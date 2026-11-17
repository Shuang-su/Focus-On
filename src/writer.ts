import { constants } from 'node:fs';
import { readdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertCaptureAuthorized } from './authorization.js';
import type { CaptureRequest, ChangeSet, ProcessingReceipt, RecordData } from './contracts.js';
import { focusStates, type FocusState } from './focus-state.js';
import {
  assertLocalGitVault, assertWorktreeReady, branchExists, checkoutBranch, checkoutMain, commitPaths, ensureIssue, ensurePull,
  git, head, loadLedger, markPullMerged, mergeBranch, returnToMain, saveLedger, updateIssue,
  type CaptureIssue, type CaptureLedger, type CaptureLedgerEntry, type CapturePull,
} from './local-vault.js';
import { planChanges } from './planner.js';
import { assertSafeRelative, canonical, digest, prepareWrite, readOptionalFile, readVault, validateChangeSet, validateReceipt, validateRequest } from './vault.js';

const maxContentBytes = 5 * 1024 * 1024;
const branchPattern = /^capture\/[a-z][a-z0-9_-]{2,100}\/v[1-9][0-9]*$/;

export interface CaptureHooks {
  afterBranchCommit?: () => Promise<void> | void;
  beforeMerge?: () => Promise<void> | void;
  beforeReceipt?: () => Promise<void> | void;
  beforeReceiptCommit?: () => Promise<void> | void;
}
export interface CaptureInput {
  request: unknown;
  vault: string;
  grants: readonly string[];
  content?: ReadonlyMap<string, Uint8Array>;
  previous?: ChangeSet;
  hooks?: CaptureHooks;
}
export interface CaptureResult {
  changeSet: ChangeSet;
  receipt: ProcessingReceipt;
  issue: CaptureIssue;
  pull: CapturePull;
}

export async function readContentDirectory(directory: string): Promise<Map<string, Uint8Array>> {
  const root = await realpath(directory);
  const content = new Map<string, Uint8Array>();
  const walk = async (relative: string): Promise<void> => {
    const entries = await readdir(path.join(root, relative), { withFileTypes: true });
    for (const entry of entries) {
      const rel = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isSymbolicLink()) throw new Error('Symlinks are not allowed in content');
      if (entry.isDirectory()) await walk(rel);
      else if (entry.isFile()) {
        assertSafeRelative(rel);
        const bytes = await readFile(path.join(root, rel));
        if (bytes.byteLength > maxContentBytes) throw new Error('Content file exceeds 5 MiB');
        content.set(rel, bytes);
      }
    }
  };
  await walk('');
  return content;
}

const requestKeyOf = (request: CaptureRequest) => request.requestId + '/v' + request.inputVersion;
const requestPath = (request: CaptureRequest) => `inbox/requests/${request.requestId}-v${request.inputVersion}.json`;
const receiptPath = (request: CaptureRequest) => `inbox/receipts/${request.requestId}-v${request.inputVersion}.json`;
const jsonBytes = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const statusOf = (record: RecordData) => 'status' in record ? record.status : undefined;

function assertContentLimits(content: ReadonlyMap<string, Uint8Array>): void {
  for (const [file, bytes] of content) {
    assertSafeRelative(file);
    if (bytes.byteLength > maxContentBytes) throw new Error('Content file exceeds 5 MiB');
  }
}
function recordsMatch(vaultRecords: Map<string, { record: RecordData }>, request: CaptureRequest): boolean {
  return request.operations.every(operation => {
    const found = vaultRecords.get(operation.record.id);
    return !!found && digest(canonical(found.record)) === digest(canonical(operation.record));
  });
}
async function contentMatches(root: string, request: CaptureRequest, content: ReadonlyMap<string, Uint8Array>): Promise<boolean> {
  for (const operation of request.operations) {
    const record = operation.record;
    if ('bodyPath' in record && record.bodyPath) {
      const disk = await readOptionalFile(root, record.bodyPath);
      const supplied = content.get(record.bodyPath);
      if (!disk?.byteLength) return false;
      if (supplied && !disk.equals(Buffer.from(supplied))) return false;
    }
    if (record.kind === 'attachment' && record.archiveStatus === 'saved' && record.path && record.sha256 && record.size !== undefined) {
      const disk = await readOptionalFile(root, record.path);
      if (!disk || disk.byteLength !== record.size || digest(disk) !== record.sha256) return false;
      const supplied = content.get(record.path);
      if (supplied && !disk.equals(Buffer.from(supplied))) return false;
    }
  }
  return true;
}
async function writePlanned(root: string, relative: string, bytes: Buffer): Promise<void> {
  const target = await prepareWrite(root, relative);
  const existing = await readOptionalFile(root, relative);
  if (existing && !existing.equals(bytes)) {
    const tip = head(root);
    const base = git(root, ['merge-base', 'HEAD', 'main']);
    if (tip !== base) throw new Error('Conflict: refusing to overwrite ' + relative);
  }
  await writeFile(target, bytes, { flag: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, mode: 0o644 });
}
function contentFiles(request: CaptureRequest, content: ReadonlyMap<string, Uint8Array>): Array<{ path: string; bytes: Buffer }> {
  const files: Array<{ path: string; bytes: Buffer }> = [];
  for (const operation of request.operations) {
    const record = operation.record;
    if ('bodyPath' in record && record.bodyPath && content.has(record.bodyPath)) files.push({ path: record.bodyPath, bytes: Buffer.from(content.get(record.bodyPath)!) });
    if (record.kind === 'attachment' && record.archiveStatus === 'saved' && record.storage === 'local' && record.path?.startsWith('attachments/') && record.sha256 && record.size !== undefined && content.has(record.path)) {
      const bytes = Buffer.from(content.get(record.path)!);
      if (bytes.byteLength !== record.size || digest(bytes) !== record.sha256) throw new Error('attachment hash/size mismatch');
      files.push({ path: record.path, bytes });
    }
  }
  return files;
}
async function verifyReadBack(root: string, request: CaptureRequest, content: ReadonlyMap<string, Uint8Array>, changeSet: ChangeSet): Promise<string> {
  const vault = await readVault(root);
  if (vault.errors.length) throw new Error('Read-back verification failed: ' + vault.errors.join('; '));
  const saved = vault.requests.get(requestKeyOf(request));
  if (!saved || digest(canonical(saved)) !== digest(canonical(request))) throw new Error('Read-back verification failed');
  for (const change of changeSet.changes) {
    const found = vault.records.get(change.record.id);
    if (!found || found.path !== change.path || digest(canonical(found.record)) !== change.afterHash) throw new Error('Read-back verification failed');
    if (statusOf(found.record) !== statusOf(change.record)) throw new Error('Read-back verification failed');
    if (found.record.kind === 'finance_draft' && found.record.status !== 'pending') throw new Error('Finance confirmation is not applied.');
  }
  if (!await contentMatches(root, request, content)) throw new Error('Read-back verification failed');
  return vault.snapshot;
}
async function readReceipt(root: string, request: CaptureRequest): Promise<ProcessingReceipt | undefined> {
  const bytes = await readOptionalFile(root, receiptPath(request));
  if (!bytes) return undefined;
  const receipt = JSON.parse(bytes.toString('utf8')) as ProcessingReceipt;
  if (!validateReceipt(receipt)) throw new Error('Invalid stored ProcessingReceipt');
  return receipt;
}
function issueBody(request: CaptureRequest, changeSet: ChangeSet): string {
  const records = changeSet.changes.map(change => `- ${change.record.id} ${change.record.kind} ${statusOf(change.record) ?? 'n/a'}`);
  return ['Private capture request. Do not copy this issue to a public repository or add credentials.', `requestId: ${request.requestId}`, `inputVersion: ${request.inputVersion}`, `inputHash: ${changeSet.inputHash}`, `branch: ${changeSet.branch}`, 'input:', request.input.text, 'records:', ...records].join('\n');
}
async function saveEntry(root: string, ledger: CaptureLedger, entry: CaptureLedgerEntry): Promise<void> {
  ledger.entries[entry.requestKey] = entry;
  await saveLedger(root, ledger);
}
async function markNeedsInput(root: string, requestKey: string): Promise<void> {
  const ledger = await loadLedger(root);
  if (!ledger.issues.some(issue => issue.requestKey === requestKey)) return;
  await updateIssue(root, ledger, requestKey, focusStates.needsInput);
  const entry = ledger.entries[requestKey];
  if (entry) { entry.phase = 'needs_input'; await saveLedger(root, ledger); }
}
async function restoreReceipt(root: string, relative: string, previous: Buffer | undefined): Promise<void> {
  try { git(root, ['reset', '-q', 'HEAD', '--', relative]); } catch { /* the receipt was not staged */ }
  if (previous) await writeFile(path.join(root, relative), previous, { flag: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, mode: 0o644 });
  else await unlink(path.join(root, relative)).catch(() => undefined);
}
async function writeStoredReceipt(root: string, request: CaptureRequest, changeSet: ChangeSet, issue: CaptureIssue, pull: CapturePull, mergeCommit: string, snapshot: string, beforeCommit?: () => Promise<void> | void): Promise<ProcessingReceipt> {
  const relative = receiptPath(request);
  const previous = await readOptionalFile(root, relative);
  const existing = await readReceipt(root, request);
  const matches = (receipt: ProcessingReceipt) => receipt.status === 'stored' && receipt.inputHash === changeSet.inputHash && receipt.evidence?.commit === mergeCommit && receipt.verification.verified;
  if (existing?.status === 'stored' && !matches(existing)) throw new Error('Conflict: stored receipt does not match this request');
  const receipt: ProcessingReceipt = existing && matches(existing) ? existing : {
    schemaVersion: 1, requestId: request.requestId, inputVersion: request.inputVersion, inputHash: changeSet.inputHash,
    status: 'stored', recordIds: changeSet.changes.map(change => change.record.id),
    verification: { verified: true, snapshot }, evidence: { issueUrl: issue.url, prUrl: pull.url, commit: mergeCommit },
  };
  if (!validateReceipt(receipt)) throw new Error('Refusing to write an invalid receipt');
  try {
    if (!existing || !matches(existing)) await writeFile(await prepareWrite(root, relative), jsonBytes(receipt), { flag: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, mode: 0o644 });
    if (beforeCommit) await beforeCommit();
    commitPaths(root, [relative], `receipt ${request.requestId} v${request.inputVersion}`);
  } catch (error) {
    await restoreReceipt(root, relative, previous);
    throw error;
  }
  return receipt;
}
async function completeStored(root: string, request: CaptureRequest, content: ReadonlyMap<string, Uint8Array>, inputHash: string, requestKey: string): Promise<CaptureResult> {
  const ledger = await loadLedger(root);
  const entry = ledger.entries[requestKey];
  if (!entry?.changeSet || !entry.mergeCommit || !validateChangeSet(entry.changeSet)) throw new Error('Read-back verification failed');
  if (entry.inputHash !== inputHash) throw new Error('Conflict: input differs from saved request version');
  const snapshot = await verifyReadBack(root, request, content, entry.changeSet);
  const issue = ledger.issues.find(item => item.number === entry.issueNumber);
  const pull = ledger.pulls.find(item => item.number === entry.pullNumber);
  if (!issue || !pull || pull.state !== 'merged' || pull.mergeCommit !== entry.mergeCommit) throw new Error('Read-back verification failed');
  let receipt: ProcessingReceipt;
  try { receipt = await writeStoredReceipt(root, request, entry.changeSet, issue, pull, entry.mergeCommit, snapshot); }
  catch (error) {
    if (error instanceof Error && error.message.startsWith('Conflict:')) throw error;
    throw new Error('Receipt write-back failed; retry the same request to recover without a new record');
  }
  await updateIssue(root, ledger, requestKey, focusStates.readBack);
  entry.phase = 'stored';
  await saveLedger(root, ledger);
  return { changeSet: entry.changeSet, receipt, issue: ledger.issues.find(item => item.number === issue.number)!, pull };
}

export async function captureChanges(input: CaptureInput): Promise<CaptureResult> {
  assertCaptureAuthorized(input.grants, input.request);
  if (!validateRequest(input.request)) throw new Error('Invalid CaptureRequest: ' + JSON.stringify(validateRequest.errors));
  const request = input.request;
  const content = input.content ?? new Map<string, Uint8Array>();
  assertContentLimits(content);
  const root = await assertLocalGitVault(input.vault);
  const requestKey = requestKeyOf(request);
  const pendingReceipt = (await loadLedger(root)).entries[requestKey];
  assertWorktreeReady(root, pendingReceipt?.phase === 'merged' || pendingReceipt?.phase === 'stored' ? receiptPath(request) : undefined);
  const vault = await readVault(root);
  if (vault.errors.length) throw new Error('Invalid vault: ' + vault.errors.join('; '));
  const inputHash = digest(canonical(request));
  const branch = `capture/${request.requestId}/v${request.inputVersion}`;
  if (!branchPattern.test(branch)) throw new Error('Unsafe capture branch');
  const saved = vault.requests.get(requestKey);
  if (saved && digest(canonical(saved)) !== inputHash) {
    await markNeedsInput(root, requestKey);
    throw new Error('Conflict: input differs from saved request version');
  }
  if (recordsMatch(vault.records, request) && await contentMatches(root, request, content)) return completeStored(root, request, content, inputHash, requestKey);
  if (request.baseSnapshot !== vault.snapshot) {
    await markNeedsInput(root, requestKey);
    throw new Error('Conflict: vault snapshot changed');
  }
  const planned = await planChanges(request, root, input.previous, { content });
  if (planned.changeSet.inputHash !== inputHash || planned.changeSet.branch !== branch) throw new Error('Capture plan did not preserve the request identity');
  const ledger = await loadLedger(root);
  const existing = ledger.entries[requestKey];
  if (existing && existing.inputHash !== inputHash) {
    await markNeedsInput(root, requestKey);
    throw new Error('Conflict: input differs from saved request version');
  }
  const baseCommit = existing?.baseCommit ?? head(root);
  const issue = await ensureIssue(root, ledger, {
    requestKey, title: `capture ${request.requestId} v${request.inputVersion}`, body: issueBody(request, planned.changeSet), focusState: focusStates.requestSaved,
  });
  const entry: CaptureLedgerEntry = {
    requestKey, inputHash, branch, baseCommit, issueNumber: issue.number, pullNumber: existing?.pullNumber,
    phase: 'issued', mergeCommit: existing?.mergeCommit, changeSet: planned.changeSet,
  };
  await saveEntry(root, ledger, entry);
  const createdBranch = !branchExists(root, branch);
  let committed = false;
  checkoutBranch(root, branch);
  try {
    const paths = [requestPath(request), ...planned.changeSet.changes.map(change => change.path), ...contentFiles(request, content).map(file => file.path)];
    await writePlanned(root, requestPath(request), jsonBytes(request));
    for (const change of planned.changeSet.changes) await writePlanned(root, change.path, jsonBytes(change.record));
    for (const file of contentFiles(request, content)) await writePlanned(root, file.path, file.bytes);
    const check = await readVault(root);
    if (check.errors.length) throw new Error('Refusing to commit invalid vault: ' + check.errors.join('; '));
    committed = commitPaths(root, paths, `capture ${request.requestId} v${request.inputVersion}`) || !createdBranch;
    checkoutMain(root);
    if (git(root, ['rev-parse', branch]) === baseCommit) throw new Error('Capture branch did not record a change');
  } catch (error) {
    returnToMain(root, branch, createdBranch && !committed);
    throw error;
  }
  entry.phase = 'branched';
  await saveEntry(root, ledger, entry);
  await updateIssue(root, ledger, requestKey, focusStates.branchReady);
  if (input.hooks?.afterBranchCommit) await input.hooks.afterBranchCommit();
  const pull = await ensurePull(root, ledger, { requestKey, branch, title: issue.title, body: issue.body });
  entry.pullNumber = pull.number;
  entry.phase = 'pull_open';
  await saveEntry(root, ledger, entry);
  await updateIssue(root, ledger, requestKey, focusStates.pullReady);
  if (input.hooks?.beforeMerge) await input.hooks.beforeMerge();
  if (head(root) !== baseCommit) {
    await updateIssue(root, ledger, requestKey, focusStates.needsInput);
    entry.phase = 'needs_input';
    await saveEntry(root, ledger, entry);
    throw new Error('Conflict: vault snapshot changed');
  }
  const mergeCommit = mergeBranch(root, branch, `merge ${branch}`);
  await markPullMerged(root, ledger, branch, mergeCommit);
  entry.mergeCommit = mergeCommit;
  entry.phase = 'merged';
  await saveEntry(root, ledger, entry);
  await updateIssue(root, ledger, requestKey, focusStates.merged);
  const snapshot = await verifyReadBack(root, request, content, planned.changeSet);
  let receipt: ProcessingReceipt;
  try {
    if (input.hooks?.beforeReceipt) await input.hooks.beforeReceipt();
    receipt = await writeStoredReceipt(root, request, planned.changeSet, issue, { ...pull, state: 'merged', mergeCommit }, mergeCommit, snapshot, input.hooks?.beforeReceiptCommit);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Conflict:')) throw error;
    throw new Error('Receipt write-back failed; retry the same request to recover without a new record');
  }
  entry.phase = 'stored';
  await saveEntry(root, ledger, entry);
  const storedIssue = await updateIssue(root, ledger, requestKey, focusStates.readBack);
  const storedPull = ledger.pulls.find(item => item.number === pull.number)!;
  return { changeSet: planned.changeSet, receipt, issue: storedIssue, pull: storedPull };
}

export async function readCaptureLedger(vault: string): Promise<CaptureLedger> {
  const root = await assertLocalGitVault(vault);
  return loadLedger(root);
}
