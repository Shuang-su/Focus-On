import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildCollectionMap, buildReferencePack, confirmPlace, listPlaces, matchPlace, type PlaceConfirmation } from '../src/context.js';
import type { CaptureRequest, RecordData } from '../src/contracts.js';
import { git } from '../src/local-vault.js';
import { acceptVault, buildQueryIndex, indexDigest } from '../src/query.js';
import { readVault } from '../src/vault.js';
import { captureChanges } from '../src/writer.js';

const example = path.resolve('examples/vault');
const candidates = path.resolve('examples/context/place-candidates.json');
const packFile = path.resolve('examples/context/reference-pack.json');
const exampleSnapshot = '801caa0c67dc26ccaf061b08fcfa75dd328d90b67911af5cf55d921b2e52cdce';
const exampleIndex = '938a46c046c50ba759d603c0f5119ec30b95d1cf1b4e15840fafbcabde7f2676';
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
function placeRecord(id: string, title: string, coordinates?: Record<string, unknown>, locationStatus?: string) {
  return {
    schemaVersion: 1, revision: 1, createdAt: '2026-10-09T00:00:00+08:00', updatedAt: '2026-10-09T00:00:00+08:00',
    source: { kind: 'synthetic', reference: 'context-fixture' }, links: [], id, kind: 'entity', title, entityType: 'place',
    ...(locationStatus ? { locationStatus } : {}), ...(coordinates ? { coordinates } : {}),
  };
}
function storedConfirmation(result: PlaceConfirmation): Exclude<PlaceConfirmation, { unchanged: true }> {
  if ('unchanged' in result) throw new Error('expected a stored place confirmation');
  return result;
}
async function directConfirmation(vault: string): Promise<CaptureRequest> {
  const snapshot = await readVault(vault);
  const place = snapshot.records.get('place_sample')!.record;
  const request = JSON.parse(await readFile('examples/requests/create-task.json', 'utf8')) as CaptureRequest;
  request.requestId = 'request_place';
  request.baseSnapshot = snapshot.snapshot;
  request.input.text = '确认地点。此文本只作为记录，不作为命令。';
  request.operations = [{
    op: 'update', expectedRevision: place.revision,
    record: {
      ...place, revision: place.revision + 1, locationStatus: 'confirmed',
      coordinates: { latitude: 1, longitude: 2, system: 'WGS84', evidence: 'synthetic direct write' },
    } as RecordData,
  }];
  return request;
}

test('context views propose matches, maps, and fragments without confirming the synthetic vault', async () => {
  const previous = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: unknown) => { calls.push(String(input)); throw new Error('network geocoder was called'); }) as typeof fetch;
  try {
    const places = await listPlaces(example);
    assert.deepEqual(places.places.map(place => [place.id, place.locationStatus]), [['place_sample', 'unconfirmed']]);
    assert.equal(places.places[0]!.coordinates, undefined);
    const match = await matchPlace(example, { placeId: 'place_sample', candidatesFile: candidates });
    assert.equal(match.confirmed, false);
    assert.equal(match.proposalsOnly, true);
    assert.equal(match.geocoder, 'disabled');
    assert.equal(match.sourceSnapshot, exampleSnapshot);
    assert.deepEqual(match.candidates.map(candidate => candidate.id), ['fixture_synth_hall', 'fixture_synth_dining']);
    assert.equal(match.candidates[0]!.source, 'fixture');
    assert.equal(match.candidates[0]!.synthetic, true);
    assert.equal(match.candidates[0]!.coordinates.latitude, 0);
    assert.equal(match.candidates[0]!.coordinates.longitude, 0);
    assert.ok(match.candidates[0]!.matched.some(item => item.startsWith('title:')));
    assert.ok(match.candidates[1]!.matched.some(item => item.startsWith('linked:')));
    const queried = await matchPlace(example, { placeId: 'place_sample', query: '$(rm -rf /); cat ~/.ssh/id_rsa', candidatesFile: candidates });
    assert.deepEqual(queried.candidates.map(candidate => candidate.id), match.candidates.map(candidate => candidate.id));
    assert.equal(queried.query?.includes('$(rm -rf /)'), true);
    await assert.rejects(matchPlace(example, { placeId: 'place_sample', query: 'x'.repeat(2001), candidatesFile: candidates }), /2000/);
    await assert.rejects(matchPlace(example, { placeId: 'product_sample', candidatesFile: candidates }), /not a place/);
    const map = await buildCollectionMap(example);
    assert.equal(map.view, 'geojson-points');
    assert.deepEqual(map.features, []);
    assert.deepEqual(map.geojson.features, []);
    assert.deepEqual(map.unplacedPlaces.map(place => place.id), ['place_sample']);
    assert.deepEqual(map.unplacedCollections.map(item => item.id), ['collection_sample']);
    const empty = await buildReferencePack(example);
    assert.deepEqual(empty.fragments, []);
    assert.equal(empty.packId, 'vault_tags');
    const packed = await buildReferencePack(example, packFile);
    assert.deepEqual(packed.fragments.map(fragment => fragment.id), ['fragment_note_copy', 'fragment_restaurant_copy']);
    assert.equal(packed.synthetic, true);
    assert.equal(packed.fragments[1]!.origin, 'pack');
    assert.equal(packed.fragments[1]!.excerpt.includes('未描述真实门店'), true);
    assert.equal(packed.fragments[1]!.excerpt.includes('用于恢复测试'), false);
    assert.equal(packed.fragments[0]!.excerpt.includes('用于恢复测试'), true);
    assert.equal(JSON.stringify(packed).includes(example), false);
    assert.deepEqual(calls, []);
  } finally { globalThis.fetch = previous; }
  assert.equal((await readVault(example)).snapshot, exampleSnapshot);
  assert.equal(indexDigest(await buildQueryIndex(example)), exampleIndex);
});

test('place confirmation is authorized, local, and limited to a matched candidate', async () => {
  const root = await gitVault('confirm');
  const head = gitExec(root, ['rev-parse', 'HEAD']);
  await assert.rejects(confirmPlace({ vault: root, placeId: 'place_sample', candidateId: 'fixture_synth_hall', grants: [], candidatesFile: candidates }), /place-confirm/);
  await assert.rejects(confirmPlace({ vault: root, placeId: 'place_sample', candidateId: 'fixture_synth_hall', grants: ['capture'], candidatesFile: candidates }), /place-confirm/);
  await assert.rejects(confirmPlace({ vault: root, placeId: 'place_sample', candidateId: 'fixture_synth_hall', grants: ['place-confirm', 'finance-confirm'], candidatesFile: candidates }), /not applied/);
  await assert.rejects(confirmPlace({ vault: root, placeId: 'place_sample', candidateId: 'fixture_missing', grants: ['place-confirm'], candidatesFile: candidates }), /Unknown place candidate/);
  await assert.rejects(captureChanges({ request: await directConfirmation(root), vault: root, grants: ['capture', 'place-confirm'] }), /only applied by confirm-place/);
  assert.equal(gitExec(root, ['rev-parse', 'HEAD']), head);
  assert.equal(gitExec(root, ['status', '--porcelain']), '');
  assert.equal((await readVault(root)).records.get('place_sample')!.record && ((await readVault(root)).records.get('place_sample')!.record as { locationStatus?: string }).locationStatus, 'unconfirmed');

  const previous = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('network geocoder was called'); }) as typeof fetch;
  let confirmed;
  try {
    confirmed = storedConfirmation(await confirmPlace({ vault: root, placeId: 'place_sample', candidateId: 'fixture_synth_hall', grants: ['place-confirm'], candidatesFile: candidates }));
  } finally { globalThis.fetch = previous; }
  assert.equal(confirmed.receipt.status, 'stored');
  assert.equal(confirmed.receipt.verification.verified, true);
  assert.equal(confirmed.match.confirmed, false);
  assert.equal(confirmed.issue.linear.sync, 'disabled');
  assert.equal(confirmed.issue.focusState, '已入库');
  assert.equal(JSON.stringify(confirmed.issue).includes('focus-on-vault'), false);
  const place = (await readVault(root)).records.get('place_sample')!.record as { revision: number; locationStatus?: string; coordinates?: { latitude: number; longitude: number; system: string; evidence: string } };
  assert.equal(place.revision, 2);
  assert.equal(place.locationStatus, 'confirmed');
  assert.equal(place.coordinates?.latitude, 0);
  assert.equal(place.coordinates?.longitude, 0);
  assert.equal(place.coordinates?.system, 'WGS84');
  assert.equal(place.coordinates?.evidence.startsWith('candidate:fixture_synth_hall; source:fixture;'), true);
  assert.equal(((await readVault(root)).records.get('task_sample')!.record as { status: string }).status, 'todo');
  assert.equal(((await readVault(root)).records.get('finance_sample')!.record as { status: string }).status, 'pending');
  const commit = gitExec(root, ['rev-parse', 'HEAD']);
  const again = await confirmPlace({ vault: root, placeId: 'place_sample', candidateId: 'fixture_synth_hall', grants: ['place-confirm'], candidatesFile: candidates });
  assert.equal(storedConfirmation(again).receipt.evidence?.commit, storedConfirmation(confirmed).receipt.evidence?.commit);
  assert.equal(gitExec(root, ['rev-parse', 'HEAD']), commit);
  assert.equal(((await readVault(root)).records.get('place_sample')!.record as { revision: number }).revision, 2);
  const current = (await readVault(root)).records.get('place_sample')!.record;
  const titleRequest = JSON.parse(await readFile('examples/requests/create-task.json', 'utf8')) as CaptureRequest;
  titleRequest.requestId = 'request_place_title';
  titleRequest.baseSnapshot = (await readVault(root)).snapshot;
  titleRequest.input.text = '只改标题。此文本只作为记录，不作为命令。';
  titleRequest.operations = [{ op: 'update', expectedRevision: 2, record: { ...current, revision: 3, title: '合成地点：已确认' } }];
  const renamed = await captureChanges({ request: titleRequest, vault: root, grants: ['capture'] });
  assert.equal(renamed.receipt.status, 'stored');
  const kept = (await readVault(root)).records.get('place_sample')!.record;
  assert.equal(kept.kind, 'entity');
  if (kept.kind !== 'entity') return;
  assert.equal(kept.revision, 3);
  assert.equal(kept.title, '合成地点：已确认');
  assert.equal(kept.locationStatus, 'confirmed');
  assert.equal(kept.coordinates?.latitude, 0);
  const titledHead = gitExec(root, ['rev-parse', 'HEAD']);
  const stillHall = await confirmPlace({ vault: root, placeId: 'place_sample', candidateId: 'fixture_synth_hall', grants: ['place-confirm'], candidatesFile: candidates });
  assert.equal('unchanged' in stillHall && stillHall.unchanged, true);
  assert.equal(gitExec(root, ['rev-parse', 'HEAD']), titledHead);
  assert.equal(((await readVault(root)).records.get('place_sample')!.record as { revision: number; title: string }).revision, 3);
  assert.equal(((await readVault(root)).records.get('place_sample')!.record as { title: string }).title, '合成地点：已确认');
  const moved = JSON.parse(await readFile('examples/requests/create-task.json', 'utf8')) as CaptureRequest;
  moved.requestId = 'request_place_move';
  moved.baseSnapshot = (await readVault(root)).snapshot;
  moved.input.text = '改坐标。此文本只作为记录，不作为命令。';
  moved.operations = [{
    op: 'update', expectedRevision: 3,
    record: { ...kept, revision: 4, coordinates: { latitude: 3, longitude: 4, system: 'WGS84', evidence: 'synthetic direct move' } },
  }];
  const beforeMove = gitExec(root, ['rev-parse', 'HEAD']);
  await assert.rejects(captureChanges({ request: moved, vault: root, grants: ['capture', 'place-confirm'] }), /only applied by confirm-place/);
  assert.equal(gitExec(root, ['rev-parse', 'HEAD']), beforeMove);
  const relocated = storedConfirmation(await confirmPlace({ vault: root, placeId: 'place_sample', candidateId: 'fixture_synth_dining', grants: ['place-confirm'], candidatesFile: candidates }));
  assert.equal(relocated.receipt.status, 'stored');
  const dining = (await readVault(root)).records.get('place_sample')!.record as { revision: number; title: string; coordinates?: { latitude: number; longitude: number } };
  assert.equal(dining.revision, 4);
  assert.equal(dining.title, '合成地点：已确认');
  assert.equal(dining.coordinates?.latitude, 0.5);
  assert.equal(dining.coordinates?.longitude, -0.5);
  const restored = storedConfirmation(await confirmPlace({ vault: root, placeId: 'place_sample', candidateId: 'fixture_synth_hall', grants: ['place-confirm'], candidatesFile: candidates }));
  assert.equal(restored.receipt.status, 'stored');
  assert.notEqual(restored.changeSet.requestId, storedConfirmation(confirmed).changeSet.requestId);
  const back = (await readVault(root)).records.get('place_sample')!.record as { revision: number; title: string; coordinates?: { latitude: number; longitude: number } };
  assert.equal(back.revision, 5);
  assert.equal(back.title, '合成地点：已确认');
  assert.equal(back.coordinates?.latitude, 0);
  assert.equal(back.coordinates?.longitude, 0);
  const restoredHead = gitExec(root, ['rev-parse', 'HEAD']);
  const restoredAgain = storedConfirmation(await confirmPlace({ vault: root, placeId: 'place_sample', candidateId: 'fixture_synth_hall', grants: ['place-confirm'], candidatesFile: candidates }));
  assert.equal(restoredAgain.receipt.evidence?.commit, restored.receipt.evidence?.commit);
  assert.equal(gitExec(root, ['rev-parse', 'HEAD']), restoredHead);
  assert.equal(((await readVault(root)).records.get('place_sample')!.record as { revision: number }).revision, 5);
  assert.equal((await readVault(root)).records.size, 12);
  assert.equal(((await readVault(root)).records.get('task_sample')!.record as { status: string }).status, 'todo');
  assert.equal(((await readVault(root)).records.get('finance_sample')!.record as { status: string }).status, 'pending');
  assert.equal((await acceptVault(root)).accepted, true);
  assert.equal((await readVault(example)).snapshot, exampleSnapshot);
});

test('vault candidates and recorded catalogs stay offline and drive the collection map', async () => {
  const root = await gitVault('catalog');
  await writeFile(path.join(root, 'entities/place_known.json'), JSON.stringify(placeRecord('place_known', '合成地点', {
    latitude: 6, longitude: 7, system: 'WGS84', evidence: 'synthetic vault coordinate',
  }, 'confirmed')) + '\n');
  await writeFile(path.join(root, 'entities/place_named_only.json'), JSON.stringify(placeRecord('place_named_only', '合成地点')) + '\n');
  gitExec(root, ['add', '.']);
  gitExec(root, ['commit', '-m', 'add synthetic places']);
  const match = await matchPlace(root, { placeId: 'place_sample', candidatesFile: candidates });
  assert.equal(match.candidates[0]!.id, 'vault_place_known');
  assert.equal(match.candidates[0]!.source, 'vault');
  assert.equal(match.candidates[0]!.score > match.candidates.find(candidate => candidate.id === 'fixture_synth_hall')!.score, true);
  assert.equal(match.candidates.some(candidate => candidate.id === 'vault_place_named_only'), false);
  const draft = await sandbox('draft-map');
  const unconfirmed = placeRecord('place_sample', '合成地点：尚未核实', {
    latitude: 4, longitude: 5, system: 'GCJ02', evidence: 'synthetic unconfirmed coordinate',
  }, 'unconfirmed');
  await writeFile(path.join(draft, 'entities/place_sample.json'), JSON.stringify(unconfirmed) + '\n');
  const drafted = await buildCollectionMap(draft);
  assert.equal(drafted.features[0]!.locationStatus, 'unconfirmed');
  assert.equal(drafted.features[0]!.system, 'GCJ02');
  assert.deepEqual(drafted.geojson.features[0]!.geometry.coordinates, [5, 4]);
  assert.deepEqual(drafted.features[0]!.collections.map(item => item.id), ['collection_sample']);
  assert.equal(drafted.unplacedCollections.some(item => item.id === 'collection_sample'), false);

  const catalog = path.join(await freshDir('custom-catalog'), 'candidates.json');
  await writeFile(catalog, JSON.stringify({
    schemaVersion: 1, synthetic: true, candidates: [{
      id: 'fixture_custom_hall', names: ['合成地点'], latitude: 8, longitude: 9, system: 'GCJ02',
      evidence: 'synthetic custom candidate', recordedAt: '2026-10-09T00:00:00+08:00',
    }],
  }));
  const custom = await gitVault('custom');
  const stored = storedConfirmation(await confirmPlace({ vault: custom, placeId: 'place_sample', candidateId: 'fixture_custom_hall', grants: ['place-confirm'], candidatesFile: catalog }));
  assert.equal(stored.receipt.status, 'stored');
  const mapped = await buildCollectionMap(custom);
  assert.equal(mapped.features[0]!.system, 'GCJ02');
  assert.equal(mapped.features[0]!.latitude, 8);
  assert.equal(mapped.features[0]!.longitude, 9);
  assert.deepEqual(mapped.geojson.features[0]!.geometry.coordinates, [9, 8]);
  assert.equal(mapped.features[0]!.locationStatus, 'confirmed');
  assert.equal(JSON.stringify(mapped).includes(custom), false);
  const linked = path.join(await freshDir('linked-catalog'), 'candidates.json');
  await symlink(catalog, linked);
  await assert.rejects(matchPlace(custom, { placeId: 'place_sample', candidatesFile: linked }), /regular file/);
});

test('context commands require --vault, keep output outside it, and refuse private remotes', async () => {
  const root = await gitVault('cli');
  const head = gitExec(root, ['rev-parse', 'HEAD']);
  const env = { ...process.env, FOCUS_VAULT_PATH: root };
  for (const args of [
    ['places'], ['match-place', '--place', 'place_sample'], ['map'], ['fragments'],
    ['confirm-place', '--place', 'place_sample', '--candidate', 'fixture_synth_hall', '--authorize', 'place-confirm'],
  ]) {
    const result = runCli(args, env);
    assert.equal(result.status, 1, args.join(' ') + result.stdout);
    assert.match(result.stdout, /--vault is required/);
  }
  assert.equal(gitExec(root, ['rev-parse', 'HEAD']), head);
  assert.equal(gitExec(root, ['status', '--porcelain']), '');
  const listed = runCli(['places', '--vault', example]);
  assert.equal(listed.status, 0, listed.stdout);
  assert.match(listed.stdout, /place_sample/);
  const matched = runCli(['match-place', '--vault', example, '--place', 'place_sample']);
  assert.equal(matched.status, 0, matched.stdout);
  assert.match(matched.stdout, /fixture_synth_hall/);
  assert.match(matched.stdout, /"confirmed": false/);
  const inside = runCli(['map', '--vault', root, '--out', path.join(root, 'collections')]);
  assert.equal(inside.status, 1, inside.stdout);
  assert.match(inside.stdout, /outside the source vault/);
  assert.equal(gitExec(root, ['ls-files', '--others', '--exclude-standard']).includes('collection-map.json'), false);
  const out = path.join(await freshDir('context-out'), 'out');
  const mapped = runCli(['map', '--vault', example, '--out', out]);
  assert.equal(mapped.status, 0, mapped.stdout);
  assert.equal(JSON.parse(await readFile(path.join(out, 'collection-map.geojson'), 'utf8')).type, 'FeatureCollection');
  const fragments = runCli(['fragments', '--vault', example, '--pack', packFile, '--out', out]);
  assert.equal(fragments.status, 0, fragments.stdout);
  const refused = runCli(['confirm-place', '--vault', root, '--place', 'place_sample', '--candidate', 'fixture_synth_hall']);
  assert.equal(refused.status, 1, refused.stdout);
  assert.match(refused.stdout, /place-confirm/);
  assert.equal(gitExec(root, ['rev-parse', 'HEAD']), head);
  const confirmed = runCli(['confirm-place', '--vault', root, '--place', 'place_sample', '--candidate', 'fixture_synth_hall', '--authorize', 'place-confirm', '--out', out]);
  assert.equal(confirmed.status, 0, confirmed.stdout);
  assert.equal(JSON.parse(await readFile(path.join(out, 'receipt.json'), 'utf8')).status, 'stored');
  assert.equal(gitExec(root, ['status', '--porcelain']), '');

  for (const [name, url] of [['https-remote', 'https://github.com/Shuang-su/focus-on-vault.git'], ['ssh-remote', 'git@github.com:Shuang-su/focus-on-vault.git']] as const) {
    const remote = await gitVault(name);
    const remoteHead = gitExec(remote, ['rev-parse', 'HEAD']);
    gitExec(remote, ['remote', 'add', 'origin', url]);
    await assert.rejects(confirmPlace({ vault: remote, placeId: 'place_sample', candidateId: 'fixture_synth_hall', grants: ['place-confirm'], candidatesFile: candidates }), /not enabled/);
    assert.equal(gitExec(remote, ['rev-parse', 'HEAD']), remoteHead);
    assert.equal(((await readVault(remote)).records.get('place_sample')!.record as { locationStatus?: string }).locationStatus, 'unconfirmed');
    assert.throws(() => git(remote, ['push', 'origin', 'main']), /not enabled/);
  }
  const tagged = await sandbox('design-tag');
  const file = path.join(tagged, 'collections/collection_sample.json');
  const record = JSON.parse(await readFile(file, 'utf8')) as { tags: string[] };
  record.tags = ['Design'];
  await writeFile(file, JSON.stringify(record));
  assert.deepEqual((await buildReferencePack(tagged)).fragments, []);
  record.tags = ['design'];
  await writeFile(file, JSON.stringify(record));
  const view = await buildReferencePack(tagged, packFile);
  assert.deepEqual(view.fragments.map(fragment => [fragment.id, fragment.origin]), [
    ['fragment_note_copy', 'pack'], ['fragment_restaurant_copy', 'pack'], ['tag_collection_sample', 'tag'],
  ]);
  const broken = JSON.parse(await readFile(packFile, 'utf8')) as { fragments: Array<{ heading?: string }> };
  broken.fragments[0]!.heading = '不存在的标题';
  const brokenFile = path.join(await freshDir('broken-pack'), 'pack.json');
  await writeFile(brokenFile, JSON.stringify(broken));
  await assert.rejects(buildReferencePack(example, brokenFile), /heading not found/);
  const link = path.join(await freshDir('pack-link'), 'pack.json');
  await symlink(packFile, link);
  await assert.rejects(buildReferencePack(example, link), /regular file/);
  assert.equal((await readVault(example)).snapshot, exampleSnapshot);
});
