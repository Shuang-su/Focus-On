import { readFile, statfs } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { refuseFinanceConfirmation } from './authorization.js';
import { digest, readVault } from './vault.js';
import { planChanges } from './planner.js';
import { captureRequestSchema, manifestSchema, recordSchema, changeSetSchema, processingReceiptSchema, queryIndexSchema, backupManifestSchema, placeListSchema, placeCandidateCatalogSchema, placeMatchSchema, collectionMapSchema, fragmentPackSchema, referencePackSchema, eventSubscriptionSchema, eventScheduleSchema, eventDeliverySchema, eventStateSchema, eventMonitorSchema, eventToolCatalogSchema, pluginCatalogSchema, eventDeliveryRunSchema, type ChangeSet } from './contracts.js';
import { assertOutputOutsideVault, outputDirectory, writeOutput } from './output.js';
import { captureChanges, readContentDirectory } from './writer.js';
import { acceptVault, assertSavedIndex, buildQueryIndex, indexDigest, listInbox, listLife, searchCollections } from './query.js';
import { backupVault, restoreVault } from './backup.js';
import { buildCollectionMap, buildReferencePack, confirmPlace, listPlaces, matchPlace } from './context.js';
import { callRestrictedTool, deliverEvents, eventNow, eventPlugins, eventStatus, eventToolCatalog, parseToolArgs, redeliverEvent, requireInteger, scheduleEvents, setScheduleStatus, setSubscriptionStatus, subscribeEvents } from './events.js';

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
const jsonText = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const defaultCandidates = path.join(root, 'examples/context/place-candidates.json');
async function emitProject(commandOut: string | undefined, files: ReadonlyArray<[string, string]>): Promise<void> {
  if (!commandOut) return;
  const destination = await outputDirectory(root, commandOut);
  for (const [filename, text] of files) await writeOutput(destination, filename, text);
}
async function emitFiles(vault: string, commandOut: string | undefined, files: ReadonlyArray<[string, string]>): Promise<void> {
  if (!commandOut) return;
  await assertOutputOutsideVault(vault, commandOut);
  const destination = await outputDirectory(root, commandOut);
  for (const [filename, text] of files) await writeOutput(destination, filename, text);
}
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
  } else if (command === 'places') {
    const vault = explicit('--vault');
    const places = await listPlaces(vault);
    await emitFiles(vault, arg('--out'), [['places.json', jsonText(places)]]);
    json(places);
  } else if (command === 'match-place') {
    const vault = explicit('--vault');
    const match = await matchPlace(vault, { placeId: explicit('--place'), query: arg('--query'), candidatesFile: arg('--candidates') ?? defaultCandidates });
    await emitFiles(vault, arg('--out'), [['place-match.json', jsonText(match)]]);
    json(match);
  } else if (command === 'confirm-place') {
    const vault = explicit('--vault');
    const output = arg('--out');
    if (output) await emitFiles(vault, output, []);
    const result = await confirmPlace({
      vault, placeId: explicit('--place'), candidateId: explicit('--candidate'), grants: repeated('--authorize'),
      query: arg('--query'), candidatesFile: arg('--candidates') ?? defaultCandidates,
    });
    const files: Array<[string, string]> = [['place-match.json', jsonText(result.match)]];
    if (!('unchanged' in result)) files.push(
      ['change-set.json', jsonText(result.changeSet)], ['receipt.json', jsonText(result.receipt)],
      ['issue.json', jsonText({ number: result.issue.number, url: result.issue.url, focusState: result.issue.focusState, linear: result.issue.linear })],
    );
    await emitFiles(vault, output, files);
    json(result);
  } else if (command === 'map') {
    const vault = explicit('--vault');
    const map = await buildCollectionMap(vault);
    await emitFiles(vault, arg('--out'), [['collection-map.json', jsonText(map)], ['collection-map.geojson', jsonText(map.geojson)]]);
    json(map);
  } else if (command === 'fragments') {
    const vault = explicit('--vault');
    const pack = await buildReferencePack(vault, arg('--pack'));
    await emitFiles(vault, arg('--out'), [['reference-pack.json', jsonText(pack)]]);
    json(pack);
  } else if (command === 'events') {
    const sub = args.find(value => !value.startsWith('--'));
    const now = eventNow(arg('--now') ?? new Date().toISOString());
    if (sub === 'tools') {
      const tools = eventToolCatalog();
      await emitProject(arg('--out'), [['event-tools.json', jsonText(tools)]]);
      json(tools);
    } else if (sub === 'plugins') {
      const plugins = eventPlugins();
      await emitProject(arg('--out'), [['event-plugins.json', jsonText(plugins)]]);
      json(plugins);
    } else if (sub === 'subscribe') {
      const vault = explicit('--vault');
      const result = await subscribeEvents({ project: root, vault, state: explicit('--state'), grants: repeated('--authorize'), now, id: explicit('--id'), selector: explicit('--selector'), recordId: arg('--record') });
      await emitFiles(vault, arg('--out'), [['event-subscription.json', jsonText(result)]]);
      json(result);
    } else if (sub === 'pause-subscription' || sub === 'resume-subscription') {
      const vault = explicit('--vault');
      const result = await setSubscriptionStatus({ project: root, vault, state: explicit('--state'), grants: repeated('--authorize'), now, id: explicit('--id'), status: sub === 'pause-subscription' ? 'paused' : 'active' });
      await emitFiles(vault, arg('--out'), [['event-subscription.json', jsonText(result)]]);
      json(result);
    } else if (sub === 'schedule') {
      const vault = explicit('--vault');
      const result = await scheduleEvents({ project: root, vault, state: explicit('--state'), grants: repeated('--authorize'), now, id: explicit('--id'), subscriptionId: explicit('--subscription'), every: requireInteger('--every', arg('--every')), start: explicit('--start') });
      await emitFiles(vault, arg('--out'), [['event-schedule.json', jsonText(result)]]);
      json(result);
    } else if (sub === 'pause-schedule' || sub === 'resume-schedule') {
      const vault = explicit('--vault');
      const result = await setScheduleStatus({ project: root, vault, state: explicit('--state'), grants: repeated('--authorize'), now, id: explicit('--id'), status: sub === 'pause-schedule' ? 'paused' : 'active' });
      await emitFiles(vault, arg('--out'), [['event-schedule.json', jsonText(result)]]);
      json(result);
    } else if (sub === 'deliver') {
      const vault = explicit('--vault');
      const result = await deliverEvents({ project: root, vault, state: explicit('--state'), grants: repeated('--authorize'), now });
      await emitFiles(vault, arg('--out'), [['event-delivery-run.json', jsonText(result)]]);
      json(result);
    } else if (sub === 'redeliver') {
      const vault = explicit('--vault');
      const result = await redeliverEvent({ project: root, vault, state: explicit('--state'), grants: repeated('--authorize'), now, deliveryId: explicit('--delivery') });
      await emitFiles(vault, arg('--out'), [['event-redelivery.json', jsonText(result)]]);
      json(result);
    } else if (sub === 'status') {
      const vault = explicit('--vault');
      const result = await eventStatus({ project: root, vault, state: explicit('--state'), grants: repeated('--authorize') });
      await emitFiles(vault, arg('--out'), [['event-monitor.json', jsonText(result)]]);
      json(result);
    } else if (sub === 'call') {
      const vault = explicit('--vault');
      const result = await callRestrictedTool({ project: root, vault, state: arg('--state'), grants: repeated('--authorize'), tool: explicit('--tool'), args: parseToolArgs(arg('--args')), now });
      await emitFiles(vault, arg('--out'), [['event-tool-result.json', jsonText(result)]]);
      json(result);
    } else throw new Error('Usage: focus events tools | plugins | subscribe --vault PATH --state DIR --id ID --selector record|inbox|life [--record ID] --authorize events-subscribe | pause-subscription --vault PATH --state DIR --id ID --authorize events-subscribe | resume-subscription --vault PATH --state DIR --id ID --authorize events-subscribe | schedule --vault PATH --state DIR --id ID --subscription ID --every SECONDS --start ISO --authorize events-schedule | pause-schedule --vault PATH --state DIR --id ID --authorize events-schedule | resume-schedule --vault PATH --state DIR --id ID --authorize events-schedule | deliver --vault PATH --state DIR --authorize events-deliver [--now ISO] | redeliver --vault PATH --state DIR --delivery ID --authorize events-deliver [--now ISO] | status --vault PATH --state DIR | call --tool NAME --vault PATH [--state DIR] [--args JSON] [--authorize GRANT] [--now ISO]');
  } else if (command === 'schemas') json({ manifest: manifestSchema, record: recordSchema, captureRequest: captureRequestSchema, changeSet: changeSetSchema, processingReceipt: processingReceiptSchema, queryIndex: queryIndexSchema, backupManifest: backupManifestSchema, placeList: placeListSchema, placeCandidateCatalog: placeCandidateCatalogSchema, placeMatch: placeMatchSchema, collectionMap: collectionMapSchema, fragmentPack: fragmentPackSchema, referencePack: referencePackSchema, eventSubscription: eventSubscriptionSchema, eventSchedule: eventScheduleSchema, eventDelivery: eventDeliverySchema, eventState: eventStateSchema, eventMonitor: eventMonitorSchema, eventToolCatalog: eventToolCatalogSchema, pluginCatalog: pluginCatalogSchema, eventDeliveryRun: eventDeliveryRunSchema });
  else throw new Error('Usage: focus doctor | validate --vault PATH | plan --request FILE --vault PATH [--out .codex-work/tmp/NAME] | capture --request FILE --vault PATH --authorize capture [--content DIR] [--out .codex-work/tmp/NAME] | confirm-finance --request FILE --vault PATH --authorize finance-confirm | confirm-place --vault PATH --place ID --candidate ID --authorize place-confirm [--candidates FILE] [--query TEXT] [--out .codex-work/tmp/NAME] | places --vault PATH [--out .codex-work/tmp/NAME] | match-place --vault PATH --place ID [--query TEXT] [--candidates FILE] [--out .codex-work/tmp/NAME] | map --vault PATH [--out .codex-work/tmp/NAME] | fragments --vault PATH [--pack FILE] [--out .codex-work/tmp/NAME] | inbox --vault PATH [--status STATUS] [--out .codex-work/tmp/NAME] | search --vault PATH [--query TEXT] [--tag TAG] [--out .codex-work/tmp/NAME] | life --vault PATH [--kind task|plan|wishlist] [--status STATUS] [--out .codex-work/tmp/NAME] | index --vault PATH [--out .codex-work/tmp/NAME] [--check FILE] | accept --vault PATH [--out .codex-work/tmp/NAME] | backup --vault PATH --out DIR | restore --backup DIR --vault PATH | events tools | events plugins | events subscribe | events schedule | events deliver | events status | events call | schemas');
} catch (e) { json({ error: e instanceof Error ? e.message : 'Unknown error' }); process.exitCode = 1; }
