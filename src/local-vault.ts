import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import type { ChangeSet } from './contracts.js';
import { type FocusState, linearMapping } from './focus-state.js';

const blocked = new Set(['push', 'fetch', 'pull', 'clone', 'ls-remote', 'send-email', 'submodule']);

export interface CaptureIssue {
  number: number;
  url: string;
  requestKey: string;
  title: string;
  body: string;
  focusState: FocusState;
  linear: ReturnType<typeof linearMapping>;
}
export interface CapturePull {
  number: number;
  url: string;
  requestKey: string;
  branch: string;
  title: string;
  body: string;
  state: 'open' | 'merged';
  mergeCommit?: string;
}
export interface CaptureLedgerEntry {
  requestKey: string;
  inputHash: string;
  branch: string;
  baseCommit: string;
  issueNumber: number;
  pullNumber?: number;
  phase: 'issued' | 'branched' | 'pull_open' | 'merged' | 'stored' | 'needs_input';
  mergeCommit?: string;
  changeSet: ChangeSet;
}
export interface CaptureLedger {
  issues: CaptureIssue[];
  pulls: CapturePull[];
  entries: Record<string, CaptureLedgerEntry>;
}

const emptyLedger = (): CaptureLedger => ({ issues: [], pulls: [], entries: {} });
export const ledgerPath = (vault: string) => path.join(vault, '.git', 'focus-on-ledger.json');

export function git(cwd: string, args: string[]): string {
  const command = args[0];
  if (command && blocked.has(command)) throw new Error('Live writes to the private vault are not enabled');
  const hooks = path.join(cwd, '.git', 'focus-on-no-hooks');
  mkdirSync(hooks, { recursive: true });
  const full = ['-c', `core.hooksPath=${hooks}`, '-c', 'user.name=Focus On Writer', '-c', 'user.email=focus-on@example.invalid', ...args];
  try {
    return execFileSync('git', full, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_SSH_COMMAND: 'false' },
    }).trim();
  } catch (error) {
    const stderr = (error as { stderr?: Buffer | string }).stderr?.toString().trim() ?? (error instanceof Error ? error.message : 'git failed');
    throw new Error(stderr.split('\n')[0] ?? 'git failed');
  }
}

export async function assertLocalGitVault(input: string): Promise<string> {
  const cwd = await realpath(input);
  let top = '';
  try { top = git(cwd, ['rev-parse', '--show-toplevel']); }
  catch { throw new Error('Vault must be a local git repository on branch main'); }
  if (path.resolve(top) !== path.resolve(cwd)) throw new Error('Vault must be a local git repository on branch main');
  const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== 'main') throw new Error('Vault must be checked out on branch main');
  const remotes = git(cwd, ['remote', '-v']);
  if (/focus-on-vault/i.test(remotes) || /github\.com/i.test(remotes)) throw new Error('Live writes to the private vault are not enabled');
  const config = git(cwd, ['config', '--local', '--list']);
  if (/^(alias\.|remote\.)/m.test(config)) throw new Error('Live writes to the private vault are not enabled');
  if (git(cwd, ['status', '--porcelain'])) throw new Error('Vault worktree must be clean before capture');
  return cwd;
}

export function head(cwd: string): string { return git(cwd, ['rev-parse', 'HEAD']); }
export function branchExists(cwd: string, branch: string): boolean {
  try { git(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]); return true; }
  catch { return false; }
}
export function checkoutBranch(cwd: string, branch: string): boolean {
  const created = !branchExists(cwd, branch);
  if (created) git(cwd, ['checkout', '-b', branch, 'main']);
  else git(cwd, ['checkout', branch]);
  return created;
}
export function checkoutMain(cwd: string): void {
  if (git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']) !== 'main') git(cwd, ['checkout', 'main']);
}
export function commitPaths(cwd: string, paths: string[], message: string): boolean {
  if (!paths.length) return false;
  git(cwd, ['add', '--', ...paths]);
  if (!git(cwd, ['diff', '--cached', '--name-only'])) return false;
  git(cwd, ['commit', '-m', message]);
  return true;
}
export function mergeBranch(cwd: string, branch: string, message: string): string {
  git(cwd, ['merge', '--no-ff', '-m', message, branch]);
  return head(cwd);
}
export function returnToMain(cwd: string, branch: string, deleteUncommittedBranch: boolean): void {
  let current = '';
  try { current = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']); } catch { return; }
  try { git(cwd, ['rev-parse', '--verify', 'MERGE_HEAD']); git(cwd, ['merge', '--abort']); } catch { /* no merge in progress */ }
  if (current === branch) {
    try { git(cwd, ['checkout', '--', '.']); } catch { /* nothing to restore */ }
    try { git(cwd, ['clean', '-fd', '--', 'inbox', 'collections', 'notes', 'life', 'finance', 'entities', 'attachments', 'attachments-manifest']); } catch { /* nothing to clean */ }
  }
  checkoutMain(cwd);
  if (deleteUncommittedBranch && branchExists(cwd, branch)) git(cwd, ['branch', '-D', branch]);
}

export async function loadLedger(vault: string): Promise<CaptureLedger> {
  try { return JSON.parse(await readFile(ledgerPath(vault), 'utf8')) as CaptureLedger; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyLedger(); throw error; }
}
export async function saveLedger(vault: string, ledger: CaptureLedger): Promise<void> {
  const file = ledgerPath(vault);
  const temporary = file + '.tmp';
  await writeFile(temporary, JSON.stringify(ledger, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, file);
}

export async function ensureIssue(vault: string, ledger: CaptureLedger, issue: Omit<CaptureIssue, 'number' | 'url' | 'linear'> & { focusState: FocusState }): Promise<CaptureIssue> {
  const existing = ledger.issues.find(item => item.requestKey === issue.requestKey);
  if (existing) return existing;
  const created: CaptureIssue = {
    ...issue,
    number: ledger.issues.length + 1,
    url: `https://example.invalid/capture/issues/${ledger.issues.length + 1}`,
    linear: linearMapping(issue.focusState),
  };
  ledger.issues.push(created);
  await saveLedger(vault, ledger);
  return created;
}
export async function updateIssue(vault: string, ledger: CaptureLedger, requestKey: string, focusState: FocusState): Promise<CaptureIssue> {
  const issue = ledger.issues.find(item => item.requestKey === requestKey);
  if (!issue) throw new Error('Capture issue is missing');
  issue.focusState = focusState;
  issue.linear = linearMapping(focusState);
  await saveLedger(vault, ledger);
  return issue;
}
export async function ensurePull(vault: string, ledger: CaptureLedger, pull: Omit<CapturePull, 'number' | 'url' | 'state'>): Promise<CapturePull> {
  const existing = ledger.pulls.find(item => item.branch === pull.branch);
  if (existing) return existing;
  const created: CapturePull = { ...pull, number: ledger.pulls.length + 1, url: `https://example.invalid/capture/pulls/${ledger.pulls.length + 1}`, state: 'open' };
  ledger.pulls.push(created);
  await saveLedger(vault, ledger);
  return created;
}
export async function markPullMerged(vault: string, ledger: CaptureLedger, branch: string, mergeCommit: string): Promise<CapturePull> {
  const pull = ledger.pulls.find(item => item.branch === branch);
  if (!pull) throw new Error('Capture pull is missing');
  pull.state = 'merged';
  pull.mergeCommit = mergeCommit;
  await saveLedger(vault, ledger);
  return pull;
}
