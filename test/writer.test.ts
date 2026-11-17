import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { refuseFinanceConfirmation } from '../src/authorization.js';
import type { CaptureRequest, RecordData } from '../src/contracts.js';
import { focusStateNames } from '../src/focus-state.js';
import { git } from '../src/local-vault.js';
import { planChanges } from '../src/planner.js';
import { canonical, digest, readVault, validateChangeSet, validateReceipt } from '../src/vault.js';
import { captureChanges, readCaptureLedger, readContentDirectory } from '../src/writer.js';

const example = path.resolve('examples/vault');
const grants = ['capture'];
async function sandbox(name: string) {
  const parent = path.resolve('.codex-work/tmp/tests');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, name + '-'));
  await cp(example, root, { recursive: true, force: true });
  return root;
}
function gitExec(cwd: string, args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}
async function gitVault(name: string) {
  const root = await sandbox(name);
  gitExec(root, ['init', '-b', 'main']);
  gitExec(root, ['config', 'user.name', 'Focus On Writer']);
  gitExec(root, ['config', 'user.email', 'focus-on@example.invalid']);
  const hooks = path.join(root, '.git', 'focus-on-no-hooks');
  await mkdir(hooks, { recursive: true });
  gitExec(root, ['config', 'core.hooksPath', hooks]);
  gitExec(root, ['add', '.']);
  gitExec(root, ['commit', '-m', 'init']);
  return root;
}
async function taskRequest(vault: string): Promise<CaptureRequest> {
  const snapshot = await readVault(vault);
  const req = JSON.parse(await readFile('examples/requests/create-task.json', 'utf8')) as CaptureRequest;
  req.baseSnapshot = snapshot.snapshot;
  return req;
}
function recordShell(id: string, extra: Record<string, unknown>): RecordData {
  return {
    schemaVersion: 1, id, revision: 1, title: '合成写入', createdAt: '2026-10-09T00:00:00+08:00', updatedAt: '2026-10-09T00:00:00+08:00',
    source: { kind: 'synthetic', reference: 'writer-fixture' }, links: [], ...extra,
  } as unknown as RecordData;
}
async function createRequest(vault: string, requestId: string, extra: Record<string, unknown>, text = '合成写入'): Promise<CaptureRequest> {
  const snapshot = await readVault(vault);
  const id = 'rec_' + digest(snapshot.manifest.vaultId + ':' + requestId + ':' + 1 + ':' + 0).slice(0, 24);
  return {
    schemaVersion: 1, requestId, inputVersion: 1, source: { kind: 'synthetic', reference: 'writer-fixture' },
    capturedAt: '2026-10-09T00:00:00+08:00', input: { text }, baseSnapshot: snapshot.snapshot,
    operations: [{ op: 'create', record: recordShell(id, extra) }],
  };
}
const runCli = (args: string[]) => spawnSync(process.execPath, [path.resolve('.codex-work/build/src/cli.js'), ...args], { encoding: 'utf8' });

test('focus states keep the seven FOCUS names without a live Linear id', () => {
  assert.deepEqual(focusStateNames, ['待处理', '处理中', '待补充', '待合并', '待核验', '已入库', '已取消']);
});

test('authorized capture stores a task, preserves business status, and retries the same request', async () => {
  const root = await gitVault('happy');
  const request = await taskRequest(root);
  const planned = await planChanges(request, root);
  assert.equal(planned.receipt.status, 'planned');
  assert.equal(planned.receipt.verification.verified, false);
  const result = await captureChanges({ request, vault: root, grants });
  assert.equal(validateChangeSet(result.changeSet), true);
  assert.equal(validateReceipt(result.receipt), true);
  assert.equal(result.receipt.status, 'stored');
  assert.equal(result.receipt.verification.verified, true);
  assert.match(result.receipt.evidence?.commit ?? '', /^[a-f0-9]{40}$/);
  assert.equal(result.changeSet.branch, 'capture/request_demo/v1');
  assert.equal(result.changeSet.changes[0]!.record.id, 'rec_80c621cc87bf76a01c80d779');
  assert.equal(result.issue.focusState, '已入库');
  assert.equal(result.issue.linear.sync, 'disabled');
  assert.equal(result.issue.linear.teamKey, 'FOCUS');
  assert.equal(result.issue.linear.state, '已入库');
  assert.equal(result.pull.state, 'merged');
  assert.equal(result.pull.number, 1);
  assert.equal(gitExec(root, ['rev-parse', 'HEAD^']), result.receipt.evidence?.commit);
  const stored = await readVault(root);
  assert.deepEqual(stored.errors, []);
  assert.equal(stored.records.size, 13);
  assert.equal(stored.snapshot, result.receipt.verification.snapshot);
  assert.equal((stored.records.get('rec_80c621cc87bf76a01c80d779')!.record as { status: string }).status, 'todo');
  assert.equal((stored.records.get('task_sample')!.record as { status: string }).status, 'todo');
  assert.equal((stored.records.get('finance_sample')!.record as { status: string }).status, 'pending');
  assert.equal((stored.records.get('wishlist_sample')!.record as { status: string }).status, 'considering');
  const headBefore = gitExec(root, ['rev-parse', 'HEAD']);
  const again = await captureChanges({ request, vault: root, grants });
  assert.deepEqual(again.changeSet, result.changeSet);
  assert.deepEqual(again.receipt, result.receipt);
  assert.equal(again.issue.number, result.issue.number);
  assert.equal(again.pull.number, result.pull.number);
  assert.equal(gitExec(root, ['rev-parse', 'HEAD']), headBefore);
  assert.equal((await readVault(root)).records.size, 13);
  assert.equal(gitExec(root, ['status', '--porcelain']), '');
  const ledger = await readCaptureLedger(root);
  assert.equal(ledger.issues.length, 1);
  assert.equal(ledger.pulls.length, 1);
  await assert.rejects(planChanges(request, root), /snapshot changed/);
  assert.equal((await readVault(root)).records.size, 13);
});

test('an update keeps the task status and a second attempt does not bump the revision', async () => {
  const root = await gitVault('update');
  const vault = await readVault(root);
  const original = structuredClone(vault.records.get('task_sample')!.record);
  const request: CaptureRequest = {
    schemaVersion: 1, requestId: 'request_update', inputVersion: 1, source: { kind: 'synthetic', reference: 'writer-fixture' },
    capturedAt: '2026-10-09T00:00:00+08:00', input: { text: '只改标题' }, baseSnapshot: vault.snapshot,
    operations: [{ op: 'update', expectedRevision: 1, record: { ...original, revision: 2, title: '仍是待办', updatedAt: '2026-10-10T00:00:00+08:00' } }],
  };
  const result = await captureChanges({ request, vault: root, grants });
  const stored = (await readVault(root)).records.get('task_sample')!.record as { status: string; title: string; revision: number };
  assert.equal(result.receipt.status, 'stored');
  assert.equal(stored.status, 'todo');
  assert.equal(stored.title, '仍是待办');
  assert.equal(stored.revision, 2);
  const again = await captureChanges({ request, vault: root, grants });
  assert.equal(again.receipt.evidence?.commit, result.receipt.evidence?.commit);
  assert.equal(((await readVault(root)).records.get('task_sample')!.record as { revision: number }).revision, 2);
});

test('capture command stores a synthetic task and plan stays read-only', async () => {
  const root = await gitVault('cli-capture');
  const out = path.resolve('.codex-work/tmp/cli-capture-' + path.basename(root));
  const captured = runCli(['capture', '--request', 'examples/requests/create-task.json', '--vault', root, '--authorize', 'capture', '--out', out]);
  assert.equal(captured.status, 0, captured.stdout);
  const receipt = JSON.parse(await readFile(path.join(out, 'receipt.json'), 'utf8')) as { status: string };
  const issue = JSON.parse(await readFile(path.join(out, 'issue.json'), 'utf8')) as { focusState: string; linear: { sync: string } };
  assert.equal(receipt.status, 'stored');
  assert.equal(issue.focusState, '已入库');
  assert.equal(issue.linear.sync, 'disabled');
  assert.equal((await readVault(root)).records.size, 13);
  const planned = runCli(['plan', '--request', 'examples/requests/create-task.json', '--vault', root]);
  assert.equal(planned.status, 1);
  assert.match(planned.stdout, /snapshot changed/);
  assert.equal((await readVault(root)).records.size, 13);
});

test('capture without authorization does not write', async () => {
  const root = await gitVault('auth');
  const before = await readVault(root);
  const head = gitExec(root, ['rev-parse', 'HEAD']);
  await assert.rejects(captureChanges({ request: await taskRequest(root), vault: root, grants: [] }), /plan-only/);
  await assert.rejects(captureChanges({ request: await taskRequest(root), vault: root, grants: ['finance-confirm'] }), /plan-only/);
  assert.equal((await readVault(root)).snapshot, before.snapshot);
  assert.equal(gitExec(root, ['rev-parse', 'HEAD']), head);
  assert.equal(gitExec(root, ['branch', '--list', 'capture/*']), '');
  const cli = runCli(['capture', '--request', 'examples/requests/create-task.json', '--vault', root]);
  assert.equal(cli.status, 1);
  assert.match(cli.stdout, /plan-only/);
  assert.equal(gitExec(root, ['rev-parse', 'HEAD']), head);
});

test('retry after a branch commit reuses one issue, branch, and pull', async () => {
  const root = await gitVault('resume');
  const request = await taskRequest(root);
  let stopped = 0;
  await assert.rejects(captureChanges({ request, vault: root, grants, hooks: { afterBranchCommit() { stopped += 1; throw new Error('stop before merge'); } } }), /stop before merge/);
  assert.equal(stopped, 1);
  assert.equal((await readVault(root)).records.has('rec_80c621cc87bf76a01c80d779'), false);
  const result = await captureChanges({ request, vault: root, grants });
  assert.equal(result.receipt.status, 'stored');
  assert.equal(result.issue.number, 1);
  assert.equal(result.pull.number, 1);
  assert.equal((await readVault(root)).records.size, 13);
  assert.equal((await readCaptureLedger(root)).pulls.length, 1);
});

test('stale base, changed input, and main divergence do not overwrite records', async () => {
  const stale = await gitVault('stale');
  const staleRequest = await taskRequest(stale);
  staleRequest.baseSnapshot = '0'.repeat(64);
  const staleHead = gitExec(stale, ['rev-parse', 'HEAD']);
  await assert.rejects(captureChanges({ request: staleRequest, vault: stale, grants }), /snapshot changed/);
  assert.equal(gitExec(stale, ['rev-parse', 'HEAD']), staleHead);
  assert.equal(gitExec(stale, ['branch', '--list', 'capture/*']), '');

  const changed = await gitVault('changed-input');
  const original = await taskRequest(changed);
  await mkdir(path.join(changed, 'inbox/requests'), { recursive: true });
  const savedPath = path.join(changed, 'inbox/requests/request_demo-v1.json');
  await writeFile(savedPath, JSON.stringify(original));
  gitExec(changed, ['add', 'inbox/requests/request_demo-v1.json']);
  gitExec(changed, ['commit', '-m', 'save request']);
  const savedBytes = await readFile(savedPath);
  original.input.text = 'changed without a new version';
  await assert.rejects(captureChanges({ request: original, vault: changed, grants }), /saved request version/);
  assert.equal(await readFile(savedPath, 'utf8'), savedBytes.toString('utf8'));
  assert.equal((await readVault(changed)).records.has('rec_80c621cc87bf76a01c80d779'), false);

  const moved = await gitVault('diverged');
  const request = await taskRequest(moved);
  await assert.rejects(captureChanges({
    request, vault: moved, grants, hooks: { async beforeMerge() {
      const file = path.join(moved, 'life/tasks/task_sample.json');
      const record = JSON.parse(await readFile(file, 'utf8'));
      record.title = '外部修订';
      await writeFile(file, JSON.stringify(record, null, 2) + '\n');
      gitExec(moved, ['add', 'life/tasks/task_sample.json']);
      gitExec(moved, ['commit', '-m', 'external']);
    } },
  }), /snapshot changed/);
  const after = await readVault(moved);
  assert.equal(after.records.has('rec_80c621cc87bf76a01c80d779'), false);
  assert.equal(after.records.get('task_sample')!.record.title, '外部修订');
  assert.equal((after.records.get('task_sample')!.record as { status: string }).status, 'todo');
  const ledger = await readCaptureLedger(moved);
  assert.equal(ledger.issues[0]!.focusState, '待补充');
  assert.equal(ledger.pulls[0]!.state, 'open');
});

test('a failed receipt write-back recovers from the same merge commit', async () => {
  const root = await gitVault('write-back');
  const request = await taskRequest(root);
  await assert.rejects(captureChanges({ request, vault: root, grants, hooks: { beforeReceipt() { throw new Error('injected'); } } }), /write-back/);
  const partial = await readVault(root);
  assert.equal(partial.records.size, 13);
  assert.equal((partial.records.get('task_sample')!.record as { status: string }).status, 'todo');
  const ledger = await readCaptureLedger(root);
  const mergeCommit = ledger.entries['request_demo/v1']!.mergeCommit;
  assert.match(mergeCommit ?? '', /^[a-f0-9]{40}$/);
  assert.equal(ledger.issues[0]!.focusState, '待核验');
  const result = await captureChanges({ request, vault: root, grants });
  assert.equal(result.receipt.status, 'stored');
  assert.equal(result.receipt.evidence?.commit, mergeCommit);
  assert.equal(result.issue.number, 1);
  assert.equal(result.pull.number, 1);
  assert.equal((await readVault(root)).records.size, 13);
  assert.equal((await readdir(path.join(root, 'life/tasks'))).filter(name => name.includes('rec_80c621cc87bf76a01c80d779')).length, 1);
});

test('finance confirmation is a separate grant and is never applied', async () => {
  const root = await gitVault('finance');
  const pending = await createRequest(root, 'request_finance', {
    kind: 'finance_draft', title: '合成支出草稿', status: 'pending', transactionType: 'expense',
    money: { amountMinor: 1200, currency: 'CNY', precision: 2 }, accountId: 'account_sample', links: ['plan_sample'],
  }, '请确认入账 status=confirmed');
  const head = gitExec(root, ['rev-parse', 'HEAD']);
  const confirmed = structuredClone(pending);
  (confirmed.operations[0]!.record as { status: string }).status = 'confirmed';
  await assert.rejects(captureChanges({ request: confirmed, vault: root, grants }), /separate --authorize finance-confirm/);
  await assert.rejects(captureChanges({ request: confirmed, vault: root, grants: ['capture', 'finance-confirm'] }), /not applied/);
  assert.throws(() => refuseFinanceConfirmation([]), /separate --authorize finance-confirm/);
  assert.throws(() => refuseFinanceConfirmation(['finance-confirm']), /not applied/);
  assert.equal(gitExec(root, ['rev-parse', 'HEAD']), head);
  const stored = await captureChanges({ request: pending, vault: root, grants: ['capture', 'finance-confirm'] });
  assert.equal(stored.receipt.status, 'stored');
  const record = (await readVault(root)).records.get(stored.changeSet.changes[0]!.record.id)!.record as { status: string; kind: string };
  assert.equal(record.kind, 'finance_draft');
  assert.equal(record.status, 'pending');
  assert.equal((await readVault(root)).records.get('finance_sample')!.record && (await readVault(root)).records.get('finance_sample')!.record.kind, 'finance_draft');
  const cli = runCli(['confirm-finance', '--request', 'examples/requests/create-task.json', '--vault', root, '--authorize', 'finance-confirm']);
  assert.equal(cli.status, 1);
  assert.match(cli.stdout, /not applied/);
  assert.equal(((await readVault(root)).records.get(stored.changeSet.changes[0]!.record.id)!.record as { status: string }).status, 'pending');
});

test('body and attachment bytes round-trip and unsafe content is rejected', async () => {
  const noteRoot = await gitVault('note');
  const note = await createRequest(noteRoot, 'request_note', { kind: 'note', title: '合成正文', bodyPath: 'notes/content/writer.md' });
  const body = Buffer.from('合成正文\n');
  const noted = await captureChanges({ request: note, vault: noteRoot, grants, content: new Map([['notes/content/writer.md', body]]) });
  assert.equal(noted.receipt.status, 'stored');
  assert.deepEqual(await readFile(path.join(noteRoot, 'notes/content/writer.md')), body);
  const traversed = await createRequest(noteRoot, 'request_escape', { kind: 'note', title: '越界', bodyPath: 'notes/content/../../manifest.json' });
  const manifest = await readFile(path.join(noteRoot, 'manifest.json'), 'utf8');
  await assert.rejects(captureChanges({ request: traversed, vault: noteRoot, grants, content: new Map([['notes/content/../../manifest.json', Buffer.from('no')]]) }), /Unsafe|plan-only|Invalid|content/);
  assert.equal(await readFile(path.join(noteRoot, 'manifest.json'), 'utf8'), manifest);

  const attachmentRoot = await gitVault('attachment');
  const bytes = Buffer.from('synthetic writer attachment\n');
  const good = await createRequest(attachmentRoot, 'request_file', {
    kind: 'attachment', title: '合成附件写入', storage: 'local', archiveStatus: 'saved', path: 'attachments/writer.txt', size: bytes.length, sha256: digest(bytes),
  });
  const saved = await captureChanges({ request: good, vault: attachmentRoot, grants, content: new Map([['attachments/writer.txt', bytes]]) });
  assert.deepEqual(await readFile(path.join(attachmentRoot, 'attachments/writer.txt')), bytes);
  assert.equal(saved.receipt.verification.verified, true);
  const bad = await createRequest(attachmentRoot, 'request_bad_file', {
    kind: 'attachment', title: '错误哈希', storage: 'local', archiveStatus: 'saved', path: 'attachments/bad.txt', size: bytes.length, sha256: 'ab'.repeat(32),
  });
  const head = gitExec(attachmentRoot, ['rev-parse', 'HEAD']);
  await assert.rejects(captureChanges({ request: bad, vault: attachmentRoot, grants, content: new Map([['attachments/bad.txt', bytes]]) }), /hash\/size mismatch/);
  assert.equal(gitExec(attachmentRoot, ['rev-parse', 'HEAD']), head);

  const linked = await mkdtemp(path.join(path.resolve('.codex-work/tmp/tests'), 'content-'));
  await symlink(path.resolve('package.json'), path.join(linked, 'secret.json'));
  await assert.rejects(readContentDirectory(linked), /Symlink/);
  const plain = await taskRequest(example);
  plain.operations[0]!.record = { ...plain.operations[0]!.record, kind: 'note', bodyPath: 'notes/content/rejected.md' } as RecordData;
  delete (plain.operations[0]!.record as { status?: string }).status;
  await assert.rejects(planChanges(plain, example), /future attachment writer/);
});

test('capture requires --vault even when FOCUS_VAULT_PATH is set', async () => {
  const root = await gitVault('env-vault');
  const head = gitExec(root, ['rev-parse', 'HEAD']);
  const cli = spawnSync(process.execPath, [path.resolve('.codex-work/build/src/cli.js'), 'capture', '--request', 'examples/requests/create-task.json', '--authorize', 'capture'], {
    encoding: 'utf8', env: { ...process.env, FOCUS_VAULT_PATH: root },
  });
  assert.equal(cli.status, 1);
  assert.match(cli.stdout, /--vault and --request are required/);
  assert.equal(gitExec(root, ['rev-parse', 'HEAD']), head);
  assert.equal(gitExec(root, ['status', '--porcelain']), '');
});

test('reference-only attachment content cannot overwrite another record', async () => {
  const root = await gitVault('reference');
  const taskPath = path.join(root, 'life/tasks/task_sample.json');
  const before = await readFile(taskPath);
  const request = await createRequest(root, 'request_ref', {
    kind: 'attachment', title: '仅引用', storage: 'remote_reference', archiveStatus: 'reference_only',
    path: 'life/tasks/task_sample.json', url: 'https://example.invalid/reference',
  });
  const result = await captureChanges({
    request, vault: root, grants,
    content: new Map([['life/tasks/task_sample.json', Buffer.from(before.toString('utf8').replace('合成对账待办', '被覆盖'))]]),
  });
  assert.equal(result.receipt.status, 'stored');
  assert.equal(result.changeSet.changes.length, 1);
  assert.equal(result.changeSet.changes[0]!.record.kind, 'attachment');
  assert.equal(await readFile(taskPath, 'utf8'), before.toString('utf8'));
  assert.equal((await readVault(root)).records.get('task_sample')!.record.title, '合成对账待办');
});

test('a failed receipt commit is rolled back and an uncommitted receipt can be recovered', async () => {
  const root = await gitVault('receipt-rollback');
  const request = await taskRequest(root);
  await assert.rejects(captureChanges({
    request, vault: root, grants, hooks: { beforeReceiptCommit() { throw new Error('commit failed'); } },
  }), /write-back/);
  assert.equal(gitExec(root, ['status', '--porcelain']), '');
  await assert.rejects(readFile(path.join(root, 'inbox/receipts/request_demo-v1.json')), { code: 'ENOENT' });
  const ledger = await readCaptureLedger(root);
  const entry = ledger.entries['request_demo/v1']!;
  const planted = {
    schemaVersion: 1, requestId: request.requestId, inputVersion: request.inputVersion, inputHash: entry.inputHash, status: 'stored',
    recordIds: entry.changeSet.changes.map(change => change.record.id),
    verification: { verified: true, snapshot: (await readVault(root)).snapshot },
    evidence: { issueUrl: ledger.issues[0]!.url, prUrl: ledger.pulls[0]!.url, commit: entry.mergeCommit },
  };
  await mkdir(path.join(root, 'inbox/receipts'), { recursive: true });
  await writeFile(path.join(root, 'inbox/receipts/request_demo-v1.json'), JSON.stringify(planted, null, 2) + '\n');
  const result = await captureChanges({ request, vault: root, grants });
  assert.equal(result.receipt.status, 'stored');
  assert.equal(result.receipt.evidence?.commit, entry.mergeCommit);
  assert.equal(gitExec(root, ['status', '--porcelain']), '');
  assert.equal((await readVault(root)).records.size, 13);
});

test('live private-vault remotes and git pushes are refused', async () => {
  const root = await gitVault('remote');
  const head = gitExec(root, ['rev-parse', 'HEAD']);
  gitExec(root, ['remote', 'add', 'origin', 'https://github.com/Shuang-su/focus-on-vault.git']);
  await assert.rejects(captureChanges({ request: await taskRequest(root), vault: root, grants }), /not enabled/);
  assert.equal(gitExec(root, ['rev-parse', 'HEAD']), head);
  assert.throws(() => git(root, ['push', 'origin', 'main']), /not enabled/);
});

test('shell text stays data, a dirty tree is refused, and the example vault stays unchanged', async () => {
  const root = await gitVault('data');
  const request = await taskRequest(root);
  request.input.text = '$(echo pwned); rm -rf /';
  const result = await captureChanges({ request, vault: root, grants });
  assert.equal(result.receipt.status, 'stored');
  const saved = JSON.parse(await readFile(path.join(root, 'inbox/requests/request_demo-v1.json'), 'utf8')) as CaptureRequest;
  assert.equal(saved.input.text, request.input.text);
  assert.equal(canonical(saved.input), canonical(request.input));
  const dirty = await gitVault('dirty');
  await writeFile(path.join(dirty, 'extra.txt'), 'leave me');
  await assert.rejects(captureChanges({ request: await taskRequest(dirty), vault: dirty, grants }), /clean/);
  assert.equal(await readFile(path.join(dirty, 'extra.txt'), 'utf8'), 'leave me');
  assert.equal((await readVault(example)).snapshot, '801caa0c67dc26ccaf061b08fcfa75dd328d90b67911af5cf55d921b2e52cdce');
});
