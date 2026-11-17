import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { chmod, lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BackupManifest } from './contracts.js';
import { assertLocalGitVault, dirtyPaths, git, head, ledgerPath } from './local-vault.js';
import { assertNoSymlink, transferPath } from './output.js';
import { canonical, readVault, validateBackupManifest } from './vault.js';

export interface RestoreResult { vaultId: string; snapshot: string; head: string; records: number; refs: number; ledger: boolean }
interface LocalRef { name: string; commit: string }

const remotePattern = /^[a-z][a-z0-9+.-]*:\/\//i;
function isRemote(value: string): boolean {
  return remotePattern.test(value) || value.startsWith('git@') || value.includes('://');
}
function assertRefName(name: string): void {
  if (!/^refs\/(heads|tags)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) || name.split('/').some(part => part === '.' || part === '..')) throw new Error('Unsafe backup ref');
}
function isLedger(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const ledger = value as { issues?: unknown; pulls?: unknown; entries?: unknown };
  return Array.isArray(ledger.issues) && Array.isArray(ledger.pulls) && !!ledger.entries && typeof ledger.entries === 'object';
}
async function regularFile(file: string): Promise<Buffer> {
  const stat = await lstat(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Refusing to follow a symlink');
  return readFile(file);
}
async function absent(file: string): Promise<boolean> {
  try { await lstat(file); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
}
function localRefs(cwd: string): LocalRef[] {
  const text = git(cwd, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads', 'refs/tags']);
  if (!text) return [];
  const refs = text.split('\n').filter(Boolean).map(line => {
    const space = line.indexOf(' ');
    const commit = space < 0 ? '' : line.slice(0, space);
    const name = space < 0 ? '' : line.slice(space + 1);
    if (!name || !/^[a-f0-9]{40}$/.test(commit)) throw new Error('Unsafe backup ref');
    assertRefName(name);
    return { name, commit };
  });
  refs.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  return refs;
}
function offlineEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', TMPDIR: process.env.TMPDIR ?? '/tmp', LANG: 'C', LC_ALL: 'C',
    GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_SSH_COMMAND: 'false', GIT_ALLOW_PROTOCOL: 'file',
  };
}
function cloneLocalBundle(bundle: string, destination: string): void {
  if (isRemote(bundle)) throw new Error('Live writes to the private vault are not enabled');
  const hooks = mkdtempSync(path.join(tmpdir(), 'focus-on-hooks-'));
  try {
    execFileSync('git', [
      '-c', 'protocol.file.allow=always', '-c', 'protocol.https.allow=never', '-c', 'protocol.http.allow=never',
      '-c', 'protocol.ssh.allow=never', '-c', 'protocol.git.allow=never', '-c', 'core.autocrlf=false', '-c', `core.hooksPath=${hooks}`,
      'clone', '--no-hardlinks', '--no-single-branch', '--branch', 'main', bundle, destination,
    ], { env: offlineEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const stderr = (error as { stderr?: Buffer | string }).stderr?.toString().trim();
    throw new Error(stderr?.split('\n')[0] || 'git clone failed');
  } finally { rmSync(hooks, { recursive: true, force: true }); }
}
function unsetConfig(cwd: string, key: string): void {
  try { git(cwd, ['config', '--unset-all', key]); } catch { /* tracking key absent */ }
}
const vaultData = ['manifest.json', 'collections', 'notes', 'life', 'finance', 'entities', 'attachments', 'attachments-manifest', 'inbox'];
async function vaultFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (relative: string): Promise<void> => {
    const stat = await lstat(path.join(root, relative));
    if (stat.isSymbolicLink()) throw new Error('Symlinks are not allowed in vault data');
    if (stat.isFile()) { out.push(relative); return; }
    if (!stat.isDirectory()) return;
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) await walk(relative + '/' + entry.name);
  };
  for (const name of vaultData) if (!await absent(path.join(root, name))) await walk(name);
  return out.sort((a, b) => a.localeCompare(b, 'en'));
}
function assertCommitted(cwd: string, relative: string): void {
  let headBlob = '';
  try { headBlob = git(cwd, ['rev-parse', '--verify', '--quiet', `HEAD:${relative}`]); }
  catch { throw new Error('Backup requires ' + relative + ' to match HEAD'); }
  if (headBlob !== git(cwd, ['hash-object', '--', relative])) throw new Error('Backup requires ' + relative + ' to match HEAD');
}
function materializeRefs(cwd: string, refs: readonly LocalRef[]): void {
  const present = new Map(localRefs(cwd).map(ref => [ref.name, ref.commit]));
  for (const ref of refs) {
    assertRefName(ref.name);
    const existing = present.get(ref.name);
    if (existing && existing !== ref.commit) throw new Error('Restore verification failed');
    if (existing) continue;
    const commit = ref.commit;
    if (ref.name.startsWith('refs/heads/')) git(cwd, ['branch', ref.name.slice('refs/heads/'.length), commit]);
    else git(cwd, ['tag', ref.name.slice('refs/tags/'.length), commit]);
  }
}

export async function backupVault(project: string, vault: string, out: string): Promise<BackupManifest> {
  if (isRemote(vault) || isRemote(out)) throw new Error('Live writes to the private vault are not enabled');
  const root = await assertLocalGitVault(vault);
  const destination = transferPath(project, out, 'Backup destination');
  if (destination === root || destination.startsWith(root + path.sep)) throw new Error('Backup destination must be outside the vault');
  await assertNoSymlink(destination);
  if (!await absent(destination)) throw new Error('Backup destination already exists');
  await mkdir(destination, { recursive: true });
  await chmod(destination, 0o700);
  try {
    if (dirtyPaths(root).length) throw new Error('Vault worktree must be clean before backup');
    for (const relative of await vaultFiles(root)) assertCommitted(root, relative);
    const opened = await readVault(root);
    const refs = localRefs(root);
    const tip = head(root);
    if (!refs.some(ref => ref.name === 'refs/heads/main' && ref.commit === tip)) throw new Error('Backup requires branch main');
    const bundlePath = path.join(destination, 'vault.bundle');
    git(root, ['bundle', 'create', bundlePath, 'HEAD', ...refs.map(ref => ref.name)]);
    git(root, ['bundle', 'verify', bundlePath]);
    await chmod(bundlePath, 0o600);
    const ledgerFile = ledgerPath(root);
    let ledgerBytes: Buffer | undefined;
    if (!await absent(ledgerFile)) {
      ledgerBytes = await regularFile(ledgerFile);
      let parsed: unknown;
      try { parsed = JSON.parse(ledgerBytes.toString('utf8')); }
      catch { throw new Error('Invalid capture ledger'); }
      if (!isLedger(parsed)) throw new Error('Invalid capture ledger');
    }
    const manifest: BackupManifest = { schemaVersion: 1, vaultId: opened.manifest.vaultId, snapshot: opened.snapshot, head: tip, refs, ledger: !!ledgerBytes };
    if (!validateBackupManifest(manifest)) throw new Error('Refusing to write an invalid backup manifest');
    await writeFile(path.join(destination, 'backup.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    if (ledgerBytes) await writeFile(path.join(destination, 'ledger.json'), ledgerBytes, { mode: 0o600 });
    return manifest;
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

export async function restoreVault(project: string, backup: string, vault: string): Promise<RestoreResult> {
  if (isRemote(backup) || isRemote(vault)) throw new Error('Live writes to the private vault are not enabled');
  const backupDir = path.resolve(backup);
  const destination = transferPath(project, vault, 'Restore destination');
  if (destination === backupDir || destination.startsWith(backupDir + path.sep)) throw new Error('Restore destination must be outside the backup');
  await assertNoSymlink(backupDir);
  const backupStat = await lstat(backupDir);
  if (backupStat.isSymbolicLink() || !backupStat.isDirectory()) throw new Error('Backup must be a real directory');
  const manifestPath = path.join(backupDir, 'backup.json');
  const bundlePath = path.join(backupDir, 'vault.bundle');
  const ledgerFile = path.join(backupDir, 'ledger.json');
  const manifest = JSON.parse((await regularFile(manifestPath)).toString('utf8')) as BackupManifest;
  if (!validateBackupManifest(manifest)) throw new Error('Invalid backup manifest');
  for (const ref of manifest.refs) assertRefName(ref.name);
  if (!manifest.refs.some(ref => ref.name === 'refs/heads/main' && ref.commit === manifest.head)) throw new Error('Backup is missing branch main');
  const ledgerBytes = manifest.ledger ? await regularFile(ledgerFile) : undefined;
  if (ledgerBytes && !isLedger(JSON.parse(ledgerBytes.toString('utf8')))) throw new Error('Invalid capture ledger');
  if (!manifest.ledger && !await absent(ledgerFile)) throw new Error('Backup ledger does not match the manifest');
  await assertNoSymlink(destination);
  if (!await absent(destination)) throw new Error('Restore destination already exists');
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    cloneLocalBundle(bundlePath, destination);
    materializeRefs(destination, manifest.refs);
    try { git(destination, ['remote', 'remove', 'origin']); } catch { /* origin already absent */ }
    unsetConfig(destination, 'branch.main.remote');
    unsetConfig(destination, 'branch.main.merge');
    const hooks = path.join(destination, '.git', 'focus-on-no-hooks');
    mkdirSync(hooks, { recursive: true });
    git(destination, ['config', 'core.hooksPath', hooks]);
    git(destination, ['checkout', 'main']);
    if (ledgerBytes) await writeFile(ledgerPath(destination), ledgerBytes, { mode: 0o600 });
    const root = await assertLocalGitVault(destination);
    if (git(root, ['remote'])) throw new Error('Live writes to the private vault are not enabled');
    const opened = await readVault(root);
    const refs = localRefs(root);
    if (opened.snapshot !== manifest.snapshot) throw new Error('Restore verification failed: snapshot');
    if (head(root) !== manifest.head) throw new Error('Restore verification failed: head');
    if (canonical(refs) !== canonical(manifest.refs)) throw new Error('Restore verification failed: refs');
    return { vaultId: opened.manifest.vaultId, snapshot: opened.snapshot, head: manifest.head, records: opened.records.size, refs: refs.length, ledger: manifest.ledger };
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}
