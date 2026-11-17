import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { backupVault, restoreVault } from '../src/backup.js';
import type { CaptureRequest, ProcessingReceipt, QueryIndex } from '../src/contracts.js';
import { git } from '../src/local-vault.js';
import { acceptVault, assertSavedIndex, buildQueryIndex, indexDigest, listInbox, listLife, searchCollections } from '../src/query.js';
import { canonical, digest, readVault } from '../src/vault.js';
import { captureChanges } from '../src/writer.js';

const example = path.resolve('examples/vault');
const project = path.resolve('.');
const exampleSnapshot = '801caa0c67dc26ccaf061b08fcfa75dd328d90b67911af5cf55d921b2e52cdce';
const runCli = (args: string[], env: NodeJS.ProcessEnv = process.env) => spawnSync(process.execPath, [path.resolve('.codex-work/build/src/cli.js'), ...args], { encoding: 'utf8', env });

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
async function freshDir(name: string) {
  const parent = path.resolve('.codex-work/tmp/tests');
  await mkdir(parent, { recursive: true });
  return mkdtemp(path.join(parent, name + '-'));
}
async function taskRequest(vault: string): Promise<CaptureRequest> {
  const snapshot = await readVault(vault);
  const request = JSON.parse(await readFile('examples/requests/create-task.json', 'utf8')) as CaptureRequest;
  request.baseSnapshot = snapshot.snapshot;
  return request;
}
async function savedRequest(vault: string): Promise<CaptureRequest> {
  const request = await taskRequest(vault);
  await mkdir(path.join(vault, 'inbox/requests'), { recursive: true });
  await writeFile(path.join(vault, 'inbox/requests/request_demo-v1.json'), JSON.stringify(request, null, 2) + '\n');
  return request;
}

test('daily queries read vault files and leave the synthetic snapshot unchanged', async () => {
  assert.deepEqual(await listInbox(example), []);
  const byTitle = await searchCollections(example, { query: '餐厅' });
  assert.deepEqual(byTitle.map(hit => hit.id), ['collection_sample']);
  assert.equal(byTitle[0]!.archiveStatus, 'readable_copy');
  assert.ok(byTitle[0]!.matched.includes('title'));
  const byBody = await searchCollections(example, { query: '可独立阅读' });
  assert.equal(byBody[0]!.id, 'collection_sample');
  assert.ok(byBody[0]!.matched.includes('body'));
  assert.equal(byBody[0]!.excerpt.includes('可独立阅读'), true);
  assert.deepEqual(await searchCollections(example, { query: '合成笔记' }), []);
  assert.deepEqual(await searchCollections(example, { query: '合成午餐' }), []);
  assert.deepEqual(await searchCollections(example, { query: 'collections/content/sample.md' }), []);
  assert.deepEqual(await searchCollections(example, { tag: 'synthetic' }).then(hits => hits.map(hit => hit.id)), ['collection_sample']);
  assert.deepEqual(await searchCollections(example, { tag: 'Synthetic' }), []);
  const life = await listLife(example);
  assert.deepEqual(life.map(item => [item.id, item.kind, item.status]), [['task_sample', 'task', 'todo'], ['plan_sample', 'plan', 'proposed'], ['wishlist_sample', 'wishlist', 'considering']]);
  assert.equal(life[2]!.budget?.amountMinor, 200000);
  assert.equal('spent' in (life[2] ?? {}), false);
  assert.deepEqual((await listLife(example, { kind: 'task', status: 'todo' })).map(item => item.id), ['task_sample']);
  assert.deepEqual(await listLife(example, { status: 'done' }), []);
  await assert.rejects(listLife(example, { kind: 'finance_draft' }), /task, plan, or wishlist/);
  const index = await buildQueryIndex(example);
  assert.equal(index.sourceSnapshot, exampleSnapshot);
  assert.equal(canonical(index), canonical(await buildQueryIndex(example)));
  assert.equal(JSON.stringify(index), JSON.stringify(await buildQueryIndex(example)));
  assert.equal(index.records.length, 12);
  assert.equal(index.inbox.length, 0);
  const finance = index.records.find(entry => entry.id === 'finance_sample');
  assert.equal(finance?.status, 'pending');
  const report = await acceptVault(example);
  assert.equal(report.accepted, true);
  assert.deepEqual(report.errors, []);
  assert.equal(report.source, 'vault-files');
  assert.equal(report.snapshot, exampleSnapshot);
  assert.equal(report.indexDigest, indexDigest(index));
  assert.ok(report.checks.includes('vault-unchanged'));
  assert.equal((await readVault(example)).snapshot, exampleSnapshot);
});

test('saved requests and receipts stay out of the data snapshot', async () => {
  const root = await sandbox('inbox-files');
  const before = await readVault(root);
  const request = await savedRequest(root);
  const receipt: ProcessingReceipt = {
    schemaVersion: 1, requestId: request.requestId, inputVersion: request.inputVersion, inputHash: digest(canonical(request)),
    status: 'planned', recordIds: [request.operations[0]!.record.id], verification: { verified: false, snapshot: before.snapshot },
  };
  await mkdir(path.join(root, 'inbox/receipts'), { recursive: true });
  await writeFile(path.join(root, 'inbox/receipts/request_demo-v1.json'), JSON.stringify(receipt, null, 2) + '\n');
  const after = await readVault(root);
  assert.deepEqual(after.errors, []);
  assert.equal(after.snapshot, before.snapshot);
  const inbox = await listInbox(root);
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0]!.status, 'planned');
  assert.equal(inbox[0]!.text, request.input.text);
  assert.equal((await acceptVault(root)).accepted, true);
  receipt.inputHash = 'ab'.repeat(32);
  await writeFile(path.join(root, 'inbox/receipts/request_demo-v1.json'), JSON.stringify(receipt, null, 2) + '\n');
  assert.equal((await readVault(root)).snapshot, before.snapshot);
  const rejected = await acceptVault(root);
  assert.equal(rejected.accepted, false);
  assert.match(rejected.errors.join('\n'), /hash mismatch/);
  const duplicate = await sandbox('duplicate-receipt');
  const original = await savedRequest(duplicate);
  const stored: ProcessingReceipt = {
    schemaVersion: 1, requestId: original.requestId, inputVersion: original.inputVersion, inputHash: digest(canonical(original)),
    status: 'planned', recordIds: [original.operations[0]!.record.id], verification: { verified: false, snapshot: (await readVault(duplicate)).snapshot },
  };
  await mkdir(path.join(duplicate, 'inbox/receipts'), { recursive: true });
  await writeFile(path.join(duplicate, 'inbox/receipts/one.json'), JSON.stringify(stored));
  await writeFile(path.join(duplicate, 'inbox/receipts/two.json'), JSON.stringify(stored));
  assert.match((await acceptVault(duplicate)).errors.join('\n'), /duplicate receipt/);
});

test('search reads records instead of a stale index', async () => {
  const root = await sandbox('stale-index');
  const saved = path.join(root, 'stale-index.json');
  const first = await buildQueryIndex(root);
  const reordered = { inbox: first.inbox, records: first.records, sourceSnapshot: first.sourceSnapshot, vaultId: first.vaultId, schemaVersion: first.schemaVersion };
  await writeFile(saved, JSON.stringify(reordered));
  await assertSavedIndex(saved, first);
  assert.equal((await readVault(root)).snapshot, first.sourceSnapshot);
  const file = path.join(root, 'collections/collection_sample.json');
  const record = JSON.parse(await readFile(file, 'utf8')) as { title: string };
  record.title = '改过的合成收藏';
  await writeFile(file, JSON.stringify(record));
  assert.equal((await searchCollections(root, { query: '改过的合成收藏' }))[0]!.title, '改过的合成收藏');
  await assert.rejects(assertSavedIndex(saved, await buildQueryIndex(root)), /rebuild it from the vault/);
  assert.equal((await acceptVault(root)).accepted, true);
  await symlink(path.resolve('package.json'), path.join(root, 'linked-index.json'));
  await assert.rejects(assertSavedIndex(path.join(root, 'linked-index.json'), await buildQueryIndex(root)), /regular file/);
});

test('shell-shaped queries stay data', async () => {
  const before = await readVault(example);
  assert.deepEqual(await searchCollections(example, { query: '$(rm -rf /); cat ~/.ssh/id_rsa' }), []);
  await assert.rejects(searchCollections(example, { query: 'x'.repeat(2001) }), /2000/);
  assert.equal((await readVault(example)).snapshot, before.snapshot);
});

test('acceptance fails closed on an invalid vault and a symlink', async () => {
  const root = await sandbox('confirmed');
  const file = path.join(root, 'finance/pending/finance_sample.json');
  const record = JSON.parse(await readFile(file, 'utf8')) as { status: string };
  record.status = 'confirmed';
  await writeFile(file, JSON.stringify(record));
  const report = await acceptVault(root);
  assert.equal(report.accepted, false);
  assert.ok(report.errors.length > 0);
  const links = await sandbox('symlink');
  await symlink(path.resolve('package.json'), path.join(links, 'life/tasks/outside.json'));
  const refused = await acceptVault(links);
  assert.equal(refused.accepted, false);
  assert.match(refused.errors.join('\n'), /Symlink/);
});

test('daily commands require --vault and ignore FOCUS_VAULT_PATH', async () => {
  const root = await gitVault('env-vault');
  const head = gitExec(root, ['rev-parse', 'HEAD']);
  const env = { ...process.env, FOCUS_VAULT_PATH: root };
  for (const args of [['inbox'], ['search'], ['life'], ['index'], ['accept'], ['backup', '--out', path.join(root, 'backup')], ['restore', '--backup', root]]) {
    const result = runCli(args, env);
    assert.equal(result.status, 1, args.join(' ') + result.stdout);
    assert.match(result.stdout, /--(vault|backup) is required/);
  }
  assert.equal(gitExec(root, ['rev-parse', 'HEAD']), head);
  assert.equal(gitExec(root, ['status', '--porcelain']), '');
  const accepted = runCli(['accept', '--vault', example]);
  assert.equal(accepted.status, 0, accepted.stdout);
  const searched = runCli(['search', '--vault', example, '--query', '餐厅']);
  assert.equal(searched.status, 0, searched.stdout);
  assert.match(searched.stdout, /collection_sample/);
  const out = path.join(await freshDir('index-out'), 'out');
  const indexed = runCli(['index', '--vault', example, '--out', out]);
  assert.equal(indexed.status, 0, indexed.stdout);
  const written = JSON.parse(await readFile(path.join(out, 'query-index.json'), 'utf8')) as QueryIndex;
  assert.equal(written.sourceSnapshot, exampleSnapshot);
  const checked = runCli(['index', '--vault', example, '--check', path.join(out, 'query-index.json')]);
  assert.equal(checked.status, 0, checked.stdout);
  assert.match(checked.stdout, /"match": true/);
});

test('backup and restore round-trip a local git vault without a remote', async () => {
  const root = await gitVault('round-trip');
  const request = await taskRequest(root);
  request.input.text = '$(echo pwned); rm -rf /';
  const captured = await captureChanges({ request, vault: root, grants: ['capture'] });
  assert.equal(captured.receipt.status, 'stored');
  const sourceHead = gitExec(root, ['rev-parse', 'HEAD']);
  const sourceSnapshot = (await readVault(root)).snapshot;
  const backup = path.join(await freshDir('backup'), 'bundle');
  const manifest = await backupVault(project, root, backup);
  assert.equal(manifest.snapshot, sourceSnapshot);
  assert.equal(manifest.head, sourceHead);
  assert.equal(manifest.ledger, true);
  assert.equal(manifest.refs.some(ref => ref.name === 'refs/heads/capture/request_demo/v1'), true);
  const packed = JSON.stringify(manifest);
  assert.equal(packed.includes(root), false);
  assert.equal(packed.includes('github.com'), false);
  assert.equal(gitExec(root, ['status', '--porcelain']), '');
  const restored = path.join(await freshDir('restore'), 'vault');
  const result = await restoreVault(project, backup, restored);
  assert.equal(result.snapshot, sourceSnapshot);
  assert.equal(result.head, sourceHead);
  assert.equal(result.records, 13);
  assert.equal(result.ledger, true);
  assert.equal(gitExec(restored, ['remote']), '');
  assert.doesNotMatch(gitExec(restored, ['config', '--local', '--list']), /^(remote\.|alias\.)/m);
  assert.match(gitExec(restored, ['branch', '--list']), /capture\/request_demo\/v1/);
  const report = await acceptVault(restored);
  assert.equal(report.accepted, true);
  assert.equal((await listInbox(restored))[0]!.text, request.input.text);
  assert.equal((await listInbox(restored))[0]!.status, 'stored');
  assert.equal(((await readVault(restored)).records.get('task_sample')!.record as { status: string }).status, 'todo');
  assert.equal(((await readVault(restored)).records.get('finance_sample')!.record as { status: string }).status, 'pending');
  const again = await captureChanges({ request, vault: restored, grants: ['capture'] });
  assert.equal(again.receipt.evidence?.commit, captured.receipt.evidence?.commit);
  assert.equal((await readVault(restored)).records.size, 13);
  assert.equal(gitExec(root, ['rev-parse', 'HEAD']), sourceHead);
  assert.throws(() => git(restored, ['push', 'origin', 'main']), /not enabled/);
});

test('backup and restore refuse private remotes, dirty trees, and unsafe paths', async () => {
  const remote = await gitVault('remote');
  const head = gitExec(remote, ['rev-parse', 'HEAD']);
  gitExec(remote, ['remote', 'add', 'origin', 'https://github.com/Shuang-su/focus-on-vault.git']);
  const remoteOut = path.join(await freshDir('remote-out'), 'backup');
  await assert.rejects(backupVault(project, remote, remoteOut), /not enabled/);
  await assert.rejects(readFile(remoteOut), { code: 'ENOENT' });
  assert.equal(gitExec(remote, ['rev-parse', 'HEAD']), head);
  assert.throws(() => git(remote, ['push', 'origin', 'main']), /not enabled/);

  await assert.rejects(backupVault(project, example, path.join(await freshDir('plain-out'), 'backup')), /local git repository/);
  const dirty = await gitVault('dirty');
  await writeFile(path.join(dirty, 'extra.txt'), 'leave me');
  const dirtyOut = path.join(await freshDir('dirty-out'), 'backup');
  await assert.rejects(backupVault(project, dirty, dirtyOut), /clean/);
  await assert.rejects(readFile(dirtyOut), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(dirty, 'extra.txt'), 'utf8'), 'leave me');

  const source = await gitVault('paths');
  await assert.rejects(backupVault(project, source, path.join(project, 'examples', 'backup-out')), /outside this repository/);
  await assert.rejects(readFile(path.join(project, 'examples', 'backup-out')), { code: 'ENOENT' });
  await assert.rejects(backupVault(project, source, path.join(source, 'nested-backup')), /outside the vault/);
  await assert.rejects(restoreVault(project, 'https://github.com/Shuang-su/focus-on-vault.git', path.join(await freshDir('url'), 'vault')), /not enabled/);
  await assert.rejects(restoreVault(project, 'git@github.com:Shuang-su/focus-on-vault.git', path.join(await freshDir('scp'), 'vault')), /not enabled/);

  const backup = path.join(await freshDir('good-backup'), 'backup');
  await backupVault(project, source, backup);
  const existing = path.join(await freshDir('existing'), 'vault');
  await mkdir(existing, { recursive: true });
  await writeFile(path.join(existing, 'keep.txt'), 'keep');
  await assert.rejects(restoreVault(project, backup, existing), /already exists/);
  assert.equal(await readFile(path.join(existing, 'keep.txt'), 'utf8'), 'keep');
  const manifest = JSON.parse(await readFile(path.join(backup, 'backup.json'), 'utf8')) as { snapshot: string };
  manifest.snapshot = 'ab'.repeat(32);
  await writeFile(path.join(backup, 'backup.json'), JSON.stringify(manifest, null, 2) + '\n');
  const tampered = path.join(await freshDir('tampered'), 'vault');
  await assert.rejects(restoreVault(project, backup, tampered), /verification failed|Invalid backup manifest/);
  await assert.rejects(readFile(tampered), { code: 'ENOENT' });
  assert.equal((await readVault(example)).snapshot, exampleSnapshot);
});
