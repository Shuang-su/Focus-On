import { readFile, statfs } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { refuseFinanceConfirmation } from './authorization.js';
import { digest, readVault } from './vault.js';
import { planChanges } from './planner.js';
import { captureRequestSchema, manifestSchema, recordSchema, changeSetSchema, processingReceiptSchema, queryIndexSchema, backupManifestSchema, type ChangeSet } from './contracts.js';
import { assertOutputOutsideVault, outputDirectory, writeOutput } from './output.js';
import { captureChanges, readContentDirectory } from './writer.js';
import { acceptVault, assertSavedIndex, buildQueryIndex, indexDigest, listInbox, listLife, searchCollections } from './query.js';
import { backupVault, restoreVault } from './backup.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const [command, ...args] = process.argv.slice(2);
const arg = (flag: string) => { const index = args.indexOf(flag); if (index < 0) return undefined; const value = args[index + 1]; if (value?.startsWith('--')) throw new Error(flag + ' requires a value'); return value; };
const explicit = (flag: string) => { const value = arg(flag); if (!value) throw new Error(flag + ' is required'); return value; };
async function emit(vault: string, commandOut: string | undefined, filename: string, value: unknown): Promise<void> {
  if (!commandOut) return;
  await assertOutputOutsideVault(vault, commandOut);
  await writeOutput(await outputDirectory(root, commandOut), filename, JSON.stringify(value, null, 2) + '\n');
}
const repeated = (flag: string) => args.flatMap((value, index) => value === flag ? [args[index + 1]].filter((item): item is string => !!item && !item.startsWith('--')) : []);
const json = (value: unknown) => console.log(JSON.stringify(value, null, 2));
async function loadPrevious(explicit: string | undefined, destination: string | undefined): Promise<ChangeSet | undefined> {
  const previousFile = explicit ?? (destination ? path.join(destination, 'change-set.json') : undefined);
  if (!previousFile) return undefined;
  try { return JSON.parse(await readFile(previousFile, 'utf8')) as ChangeSet; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || explicit) throw error; }
  return undefined;
}
try {
  if (command === 'doctor') {
    let git = 'unavailable'; try { git = execFileSync('git', ['status', '--short', '--branch'], { cwd: root, encoding: 'utf8' }).trim(); } catch {}
    const space = await statfs(root);
    json({ node: process.version, supportedNode: Number(process.versions.node.split('.')[0]) === 24, platform: process.platform, architecture: process.arch, root, git, vaultConfigured: !!process.env.FOCUS_VAULT_PATH, availableBytes: space.bavail * space.bsize, cache: path.join(root, '.codex-work/cache') });
    if (Number(process.versions.node.split('.')[0]) !== 24) process.exitCode = 1;
  } else if (command === 'validate') {
    const vault = arg('--vault') ?? process.env.FOCUS_VAULT_PATH; if (!vault) throw new Error('--vault is required');
    const result = await readVault(vault);
    json({ valid: !result.errors.length, records: result.records.size, snapshot: result.snapshot, errors: result.errors });
    if (result.errors.length) process.exitCode = 1;
  } else if (command === 'plan') {
    const vault = arg('--vault') ?? process.env.FOCUS_VAULT_PATH;
    const input = arg('--request'); if (!vault || !input) throw new Error('--vault and --request are required');
    const output = arg('--out');
    const destination = output ? await outputDirectory(root, output) : undefined;
    const result = await planChanges(JSON.parse(await readFile(input, 'utf8')), vault, await loadPrevious(arg('--previous'), destination));
    if (destination) {
      await writeOutput(destination, 'change-set.json', JSON.stringify(result.changeSet, null, 2) + '\n');
      await writeOutput(destination, 'receipt.json', JSON.stringify(result.receipt, null, 2) + '\n');
      for (const [i, change] of result.changeSet.changes.entries()) await writeOutput(destination, `change-${i}.diff`, `${change.op} ${change.path}\nbase ${change.beforeHash ?? 'new'}\n+${JSON.stringify(change.record)}\n`);
    }
    json(result);
  } else if (command === 'capture') {
    const vault = arg('--vault');
    const input = arg('--request'); if (!vault || !input) throw new Error('--vault and --request are required');
    const output = arg('--out');
    const destination = output ? await outputDirectory(root, output) : undefined;
    const contentDir = arg('--content');
    const content = contentDir ? await readContentDirectory(contentDir) : undefined;
    const result = await captureChanges({ request: JSON.parse(await readFile(input, 'utf8')), vault, grants: repeated('--authorize'), content, previous: await loadPrevious(arg('--previous'), destination) });
    if (destination) {
      await writeOutput(destination, 'change-set.json', JSON.stringify(result.changeSet, null, 2) + '\n');
      await writeOutput(destination, 'receipt.json', JSON.stringify(result.receipt, null, 2) + '\n');
      await writeOutput(destination, 'issue.json', JSON.stringify({ number: result.issue.number, url: result.issue.url, focusState: result.issue.focusState, linear: result.issue.linear }, null, 2) + '\n');
      for (const [i, change] of result.changeSet.changes.entries()) {
        const record = change.record;
        const body = 'bodyPath' in record && record.bodyPath && content?.has(record.bodyPath) ? `body ${record.bodyPath} ${digest(content.get(record.bodyPath)!)}\n` : '';
        await writeOutput(destination, `change-${i}.diff`, `${change.op} ${change.path}\nbase ${change.beforeHash ?? 'new'}\n+${JSON.stringify(change.record)}\n${body}`);
      }
    }
    json(result);
  } else if (command === 'confirm-finance') {
    const vault = arg('--vault');
    const input = arg('--request'); if (!vault || !input) throw new Error('--vault and --request are required');
    JSON.parse(await readFile(input, 'utf8'));
    await readVault(vault);
    refuseFinanceConfirmation(repeated('--authorize'));
  } else if (command === 'inbox') {
    const vault = explicit('--vault');
    const items = await listInbox(vault, arg('--status'));
    await emit(vault, arg('--out'), 'inbox.json', items);
    json(items);
  } else if (command === 'search') {
    const vault = explicit('--vault');
    const hits = await searchCollections(vault, { query: arg('--query'), tag: arg('--tag') });
    await emit(vault, arg('--out'), 'search.json', hits);
    json(hits);
  } else if (command === 'life') {
    const vault = explicit('--vault');
    const items = await listLife(vault, { kind: arg('--kind'), status: arg('--status') });
    await emit(vault, arg('--out'), 'life.json', items);
    json(items);
  } else if (command === 'index') {
    const vault = explicit('--vault');
    const fresh = await buildQueryIndex(vault);
    const check = arg('--check');
    if (check) await assertSavedIndex(check, fresh);
    await emit(vault, arg('--out'), 'query-index.json', fresh);
    json(check ? { match: true, sourceSnapshot: fresh.sourceSnapshot, indexDigest: indexDigest(fresh) } : fresh);
  } else if (command === 'accept') {
    const vault = explicit('--vault');
    const report = await acceptVault(vault);
    const output = arg('--out');
    await emit(vault, output, 'acceptance.json', report);
    if (output && report.accepted) await emit(vault, output, 'query-index.json', await buildQueryIndex(vault));
    json(report);
    if (!report.accepted) process.exitCode = 1;
  } else if (command === 'backup') {
    json(await backupVault(root, explicit('--vault'), explicit('--out')));
  } else if (command === 'restore') {
    json(await restoreVault(root, explicit('--backup'), explicit('--vault')));
  } else if (command === 'schemas') json({ manifest: manifestSchema, record: recordSchema, captureRequest: captureRequestSchema, changeSet: changeSetSchema, processingReceipt: processingReceiptSchema, queryIndex: queryIndexSchema, backupManifest: backupManifestSchema });
  else throw new Error('Usage: focus doctor | validate --vault PATH | plan --request FILE --vault PATH [--out .codex-work/tmp/NAME] | capture --request FILE --vault PATH --authorize capture [--content DIR] [--out .codex-work/tmp/NAME] | confirm-finance --request FILE --vault PATH --authorize finance-confirm | inbox --vault PATH [--status STATUS] [--out .codex-work/tmp/NAME] | search --vault PATH [--query TEXT] [--tag TAG] [--out .codex-work/tmp/NAME] | life --vault PATH [--kind task|plan|wishlist] [--status STATUS] [--out .codex-work/tmp/NAME] | index --vault PATH [--out .codex-work/tmp/NAME] [--check FILE] | accept --vault PATH [--out .codex-work/tmp/NAME] | backup --vault PATH --out DIR | restore --backup DIR --vault PATH | schemas');
} catch (e) { json({ error: e instanceof Error ? e.message : 'Unknown error' }); process.exitCode = 1; }
