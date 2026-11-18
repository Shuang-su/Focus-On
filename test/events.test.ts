import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CaptureRequest, EventDelivery, EventState } from '../src/contracts.js';
import { confirmPlace } from '../src/context.js';
import { callRestrictedTool, deliverEvents, eventPlugins, eventStatus, eventToolCatalog, redeliverEvent, scheduleEvents, setScheduleStatus, setSubscriptionStatus, subscribeEvents } from '../src/events.js';
import { git } from '../src/local-vault.js';
import { digest, readVault } from '../src/vault.js';
import { captureChanges } from '../src/writer.js';

const example = path.resolve('examples/vault');
const project = path.resolve('.');
const candidates = path.resolve('examples/context/place-candidates.json');
const exampleSnapshot = '801caa0c67dc26ccaf061b08fcfa75dd328d90b67911af5cf55d921b2e52cdce';
const t0 = '2026-11-18T00:00:00.000Z';
const plus = (seconds: number) => new Date(Date.parse(t0) + seconds * 1000).toISOString();
const runCli = (args: string[], env: NodeJS.ProcessEnv = process.env) => spawnSync(process.execPath, [path.resolve('.codex-work/build/src/cli.js'), ...args], { encoding: 'utf8', env });

async function freshDir(name: string) {
  const parent = path.resolve('.codex-work/tmp/tests');
  await mkdir(parent, { recursive: true });
  return mkdtemp(path.join(parent, name + '-'));
}
async function sandbox(name: string) {
  const root = await freshDir(name);
  const vault = path.join(root, 'vault');
  await cp(example, vault, { recursive: true, force: true });
  return vault;
}
async function stateDir(name: string) {
  return path.join(await freshDir(name), 'state');
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
async function savedRequest(vault: string): Promise<CaptureRequest> {
  const snapshot = await readVault(vault);
  const request = JSON.parse(await readFile('examples/requests/create-task.json', 'utf8')) as CaptureRequest;
  request.baseSnapshot = snapshot.snapshot;
  request.input.text = '合成录入。此文本只作为记录，不进入事件日志。';
  return request;
}
async function readState(directory: string): Promise<EventState> {
  return JSON.parse(await readFile(path.join(directory, 'state.json'), 'utf8')) as EventState;
}
function location(vault: string, state: string) {
  return { project, vault, state };
}
const noEffects = { vaultWrite: false, lifeStatusChanged: false, financeConfirmed: false, externalDelivery: false } as const;
function statusOf(vault: Awaited<ReturnType<typeof readVault>>, id: string): string | undefined {
  const record = vault.records.get(id)?.record;
  return record && 'status' in record ? record.status : undefined;
}

test('event tools and plugins stay local and disabled', async () => {
  const previous = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: unknown) => { calls.push(String(input)); throw new Error('network was called'); }) as typeof fetch;
  try {
    const tools = eventToolCatalog();
    const plugins = eventPlugins();
    assert.equal(tools.server, 'disabled');
    assert.equal(tools.transport, 'local');
    assert.equal(tools.tools.some(tool => tool.name === 'focus.capture'), false);
    assert.equal(tools.tools.some(tool => tool.name === 'focus.confirm_finance'), false);
    assert.equal(tools.tools.find(tool => tool.name === 'focus.subscribe')?.grant, 'events-subscribe');
    assert.equal(tools.tools.find(tool => tool.name === 'focus.schedule')?.grant, 'events-schedule');
    assert.equal(tools.tools.find(tool => tool.name === 'focus.deliver')?.grant, 'events-deliver');
    assert.equal(plugins.activation, 'disabled');
    assert.deepEqual(plugins.interfaces.map(item => [item.id, item.activation]), [['map', 'disabled'], ['ui', 'disabled']]);
    assert.deepEqual(calls, []);
  } finally { globalThis.fetch = previous; }
});

test('subscriptions require a narrow grant and do not change vault records', async () => {
  const vault = await sandbox('auth');
  const state = await stateDir('auth-state');
  const before = await readVault(vault);
  const input = { ...location(vault, state), now: t0, id: 'sub_task', selector: 'record', recordId: 'task_sample' };
  await assert.rejects(subscribeEvents({ ...input, grants: [] }), /events-subscribe/);
  await assert.rejects(subscribeEvents({ ...input, grants: ['capture'] }), /events-subscribe/);
  await assert.rejects(subscribeEvents({ ...input, grants: ['events-deliver'] }), /events-subscribe/);
  await assert.rejects(subscribeEvents({ ...input, grants: ['events-admin'] }), /Unknown authorization/);
  await assert.rejects(subscribeEvents({ ...input, grants: ['events-subscribe', 'finance-confirm'] }), /not applied/);
  await assert.rejects(lstat(path.join(state, 'state.json')), { code: 'ENOENT' });
  const created = await subscribeEvents({ ...input, grants: ['events-subscribe'] });
  assert.equal(created.created, true);
  assert.equal(created.subscription.sink.type, 'journal');
  assert.equal((await readVault(vault)).snapshot, before.snapshot);
  assert.equal(statusOf(await readVault(vault), 'task_sample'), 'todo');
  assert.equal(statusOf(await readVault(vault), 'finance_sample'), 'pending');
});

test('event state survives a new call, rejects conflicts, and stays idempotent', async () => {
  const vault = await sandbox('persist');
  const state = await stateDir('persist-state');
  const first = await subscribeEvents({ ...location(vault, state), grants: ['events-subscribe'], now: t0, id: 'sub_task', selector: 'record', recordId: 'task_sample' });
  const bytes = await readFile(path.join(state, 'state.json'));
  const second = await subscribeEvents({ ...location(vault, state), grants: ['events-subscribe'], now: plus(10), id: 'sub_task', selector: 'record', recordId: 'task_sample' });
  assert.equal(second.created, false);
  assert.equal(second.subscription.createdAt, first.subscription.createdAt);
  assert.equal((await readFile(path.join(state, 'state.json'))).equals(bytes), true);
  await assert.rejects(subscribeEvents({ ...location(vault, state), grants: ['events-subscribe'], now: plus(10), id: 'sub_task', selector: 'inbox' }), /Conflict/);
  assert.equal((await readFile(path.join(state, 'state.json'))).equals(bytes), true);
  const paused = await setSubscriptionStatus({ ...location(vault, state), grants: ['events-subscribe'], now: plus(20), id: 'sub_task', status: 'paused' });
  assert.equal(paused.changed, true);
  const again = await subscribeEvents({ ...location(vault, state), grants: ['events-subscribe'], now: plus(30), id: 'sub_task', selector: 'record', recordId: 'task_sample' });
  assert.equal(again.subscription.status, 'paused');
  const monitor = await eventStatus({ ...location(vault, state), grants: [] });
  assert.equal(monitor.state, 'present');
  assert.equal(monitor.daemon, 'disabled');
  assert.equal(monitor.subscriptions[0]!.id, 'sub_task');
  assert.equal(JSON.stringify(monitor).includes(vault), false);
});

test('delivery is idempotent and does not complete life tasks or confirm finance', async () => {
  const vault = await sandbox('deliver');
  const state = await stateDir('deliver-state');
  let calls = 0;
  const handler = async () => { calls += 1; };
  await subscribeEvents({ ...location(vault, state), grants: ['events-subscribe'], now: t0, id: 'sub_task', selector: 'record', recordId: 'task_sample' });
  await subscribeEvents({ ...location(vault, state), grants: ['events-subscribe'], now: t0, id: 'sub_finance', selector: 'record', recordId: 'finance_sample' });
  const before = (await readVault(vault)).snapshot;
  const first = await deliverEvents({ ...location(vault, state), grants: ['events-deliver'], now: t0, handler });
  assert.equal(first.delivered, 2);
  assert.equal(first.duplicates, 0);
  assert.equal(first.daemon, 'disabled');
  const saved = await readState(state);
  assert.equal(saved.daemon, 'disabled');
  assert.equal(saved.externalDelivery, 'disabled');
  assert.deepEqual(saved.deliveries.map(item => item.effects), [noEffects, noEffects]);
  const task = saved.deliveries.find(item => item.subscriptionId === 'sub_task')!;
  const finance = saved.deliveries.find(item => item.subscriptionId === 'sub_finance')!;
  assert.equal(task.kind, 'record.observed');
  assert.equal(task.observation.record?.status, 'todo');
  assert.equal(finance.observation.record?.status, 'pending');
  assert.equal(task.attempts, 1);
  const bytes = await readFile(path.join(state, 'state.json'));
  const second = await deliverEvents({ ...location(vault, state), grants: ['events-deliver'], now: t0, handler });
  assert.equal(second.duplicates, 2);
  assert.equal(second.attempted, 0);
  assert.equal(calls, 2);
  assert.equal((await readFile(path.join(state, 'state.json'))).equals(bytes), true);
  assert.equal((await readVault(vault)).snapshot, before);
  assert.equal(JSON.stringify(saved).includes(vault), false);
});

test('a changed record emits a new observation without writing the vault', async () => {
  const vault = await sandbox('change');
  const state = await stateDir('change-state');
  await subscribeEvents({ ...location(vault, state), grants: ['events-subscribe'], now: t0, id: 'sub_task', selector: 'record', recordId: 'task_sample' });
  await deliverEvents({ ...location(vault, state), grants: ['events-deliver'], now: t0 });
  const file = path.join(vault, 'life/tasks/task_sample.json');
  const record = JSON.parse(await readFile(file, 'utf8')) as { title: string; status: string };
  record.title = '合成标题变更';
  await writeFile(file, JSON.stringify(record));
  const before = (await readVault(vault)).snapshot;
  const run = await deliverEvents({ ...location(vault, state), grants: ['events-deliver'], now: plus(5) });
  assert.equal(run.delivered, 1);
  assert.equal(run.duplicates, 0);
  const saved = await readState(state);
  assert.equal(saved.deliveries.length, 2);
  assert.equal(saved.deliveries.every(item => item.observation.record?.status === 'todo'), true);
  assert.equal((await readVault(vault)).snapshot, before);
  assert.equal(statusOf(await readVault(vault), 'task_sample'), 'todo');
});

test('capture stored and life todo stay separate observations', async () => {
  const vault = await gitVault('separate');
  const request = await savedRequest(vault);
  await assert.rejects(captureChanges({ request, vault, grants: ['events-deliver'] }), /capture/);
  await assert.rejects(confirmPlace({ vault, placeId: 'place_sample', candidateId: 'fixture_synth_hall', grants: ['events-subscribe'], candidatesFile: candidates }), /place-confirm/);
  const captured = await captureChanges({ request, vault, grants: ['capture'] });
  assert.equal(captured.receipt.status, 'stored');
  const state = await stateDir('separate-state');
  await subscribeEvents({ ...location(vault, state), grants: ['events-subscribe'], now: t0, id: 'sub_inbox', selector: 'inbox' });
  await subscribeEvents({ ...location(vault, state), grants: ['events-subscribe'], now: t0, id: 'sub_life', selector: 'life' });
  const before = (await readVault(vault)).snapshot;
  await deliverEvents({ ...location(vault, state), grants: ['events-deliver'], now: t0 });
  const saved = await readState(state);
  const inbox = saved.deliveries.find(item => item.kind === 'inbox.observed')!;
  const life = saved.deliveries.find(item => item.kind === 'life.observed')!;
  assert.equal(inbox.observation.inbox?.some(item => item.requestId === 'request_demo' && item.status === 'stored' && item.verified === true), true);
  assert.equal(life.observation.life?.find(item => item.id === 'task_sample')?.status, 'todo');
  assert.equal(life.observation.life?.find(item => item.id === 'rec_80c621cc87bf76a01c80d779')?.status, 'todo');
  assert.equal(JSON.stringify(saved).includes(request.input.text), false);
  assert.equal(JSON.stringify(saved).includes(vault), false);
  assert.deepEqual(inbox.effects, noEffects);
  assert.equal((await readVault(vault)).snapshot, before);
  assert.equal(gitExec(vault, ['status', '--porcelain']), '');
  assert.equal(statusOf(await readVault(vault), 'finance_sample'), 'pending');
});

test('schedules fire on saved occurrences and catch up with a bound', async () => {
  const vault = await sandbox('schedule');
  const state = await stateDir('schedule-state');
  await subscribeEvents({ ...location(vault, state), grants: ['events-subscribe'], now: t0, id: 'sub_life', selector: 'life' });
  await assert.rejects(scheduleEvents({ ...location(vault, state), grants: ['events-subscribe'], now: t0, id: 'sched_hour', subscriptionId: 'sub_life', every: 3600, start: t0 }), /events-schedule/);
  await assert.rejects(scheduleEvents({ ...location(vault, state), grants: ['events-schedule'], now: t0, id: 'sched_hour', subscriptionId: 'sub_life', every: 59, start: t0 }), /60/);
  const created = await scheduleEvents({ ...location(vault, state), grants: ['events-schedule'], now: t0, id: 'sched_hour', subscriptionId: 'sub_life', every: 3600, start: '2026-11-18T08:00:00+08:00' });
  assert.equal(created.schedule.startAt, t0);
  const same = await scheduleEvents({ ...location(vault, state), grants: ['events-schedule'], now: plus(5), id: 'sched_hour', subscriptionId: 'sub_life', every: 3600, start: t0 });
  assert.equal(same.created, false);
  const bytes = await readFile(path.join(state, 'state.json'));
  await assert.rejects(scheduleEvents({ ...location(vault, state), grants: ['events-schedule'], now: plus(5), id: 'sched_hour', subscriptionId: 'sub_life', every: 7200, start: t0 }), /Conflict/);
  assert.equal((await readFile(path.join(state, 'state.json'))).equals(bytes), true);
  const due = await deliverEvents({ ...location(vault, state), grants: ['events-deliver'], now: t0 });
  assert.equal(due.deliveries.filter(item => !item.duplicate).length, 2);
  const early = await deliverEvents({ ...location(vault, state), grants: ['events-deliver'], now: plus(3599) });
  assert.equal(early.duplicates, 1);
  assert.equal((await readState(state)).deliveries.filter(item => item.kind === 'schedule.due').length, 1);
  await deliverEvents({ ...location(vault, state), grants: ['events-deliver'], now: plus(3600) });
  assert.equal((await readState(state)).deliveries.filter(item => item.kind === 'schedule.due').length, 2);
  assert.equal((await readState(state)).schedules[0]!.nextDueAt, plus(7200));
  const ahead = await stateDir('catchup-state');
  await subscribeEvents({ ...location(vault, ahead), grants: ['events-subscribe'], now: t0, id: 'sub_life', selector: 'life' });
  await scheduleEvents({ ...location(vault, ahead), grants: ['events-schedule'], now: t0, id: 'sched_hour', subscriptionId: 'sub_life', every: 3600, start: t0 });
  await deliverEvents({ ...location(vault, ahead), grants: ['events-deliver'], now: plus(10 * 3600) });
  assert.equal((await readState(ahead)).deliveries.filter(item => item.kind === 'schedule.due').length, 8);
  assert.equal((await readState(ahead)).schedules[0]!.nextDueAt, plus(8 * 3600));
  await deliverEvents({ ...location(vault, ahead), grants: ['events-deliver'], now: plus(10 * 3600) });
  assert.equal((await readState(ahead)).deliveries.filter(item => item.kind === 'schedule.due').length, 11);
  assert.equal((await readState(ahead)).schedules[0]!.nextDueAt, plus(11 * 3600));
  const paused = await setScheduleStatus({ ...location(vault, state), grants: ['events-schedule'], now: plus(7200), id: 'sched_hour', status: 'paused' });
  assert.equal(paused.changed, true);
  await deliverEvents({ ...location(vault, state), grants: ['events-deliver'], now: plus(7200) });
  assert.equal((await readState(state)).deliveries.filter(item => item.kind === 'schedule.due').length, 2);
});

test('failed deliveries retry with bounded backoff and stay inspectable', async () => {
  const vault = await sandbox('retry');
  const state = await stateDir('retry-state');
  let fail = true;
  let calls = 0;
  const handler = async () => { calls += 1; if (fail) throw new Error('synthetic sink failure'); };
  await subscribeEvents({ ...location(vault, state), grants: ['events-subscribe'], now: t0, id: 'sub_task', selector: 'record', recordId: 'task_sample' });
  await deliverEvents({ ...location(vault, state), grants: ['events-deliver'], now: t0, handler });
  let saved = await readState(state);
  let delivery = saved.deliveries[0]!;
  assert.equal(delivery.status, 'retry');
  assert.equal(delivery.attempts, 1);
  assert.equal(delivery.nextAttemptAt, plus(60));
  assert.match(delivery.lastError ?? '', /synthetic sink failure/);
  await deliverEvents({ ...location(vault, state), grants: ['events-deliver'], now: plus(30), handler });
  assert.equal((await readState(state)).deliveries[0]!.attempts, 1);
  assert.equal(calls, 1);
  let now = plus(60);
  for (let attempt = 2; attempt <= 5; attempt += 1) {
    await deliverEvents({ ...location(vault, state), grants: ['events-deliver'], now, handler });
    saved = await readState(state);
    delivery = saved.deliveries[0]!;
    assert.equal(delivery.attempts, attempt);
    if (attempt < 5) {
      assert.equal(delivery.status, 'retry');
      now = delivery.nextAttemptAt ?? now;
    }
  }
  assert.equal(delivery.status, 'exhausted');
  assert.equal(delivery.nextAttemptAt, undefined);
  assert.equal(calls, 5);
  const exhaustedBytes = await readFile(path.join(state, 'state.json'));
  await deliverEvents({ ...location(vault, state), grants: ['events-deliver'], now: plus(86400), handler });
  assert.equal((await readFile(path.join(state, 'state.json'))).equals(exhaustedBytes), true);
  const monitor = await eventStatus({ ...location(vault, state), grants: [] });
  assert.equal(monitor.counts.exhausted, 1);
  assert.equal(monitor.failures[0]!.lastError.includes('synthetic sink failure'), true);
  assert.equal(monitor.daemon, 'disabled');
  await assert.rejects(redeliverEvent({ ...location(vault, state), grants: [], now: plus(86400), deliveryId: delivery.id, handler }), /events-deliver/);
  assert.equal((await readFile(path.join(state, 'state.json'))).equals(exhaustedBytes), true);
  fail = false;
  const recovered = await redeliverEvent({ ...location(vault, state), grants: ['events-deliver'], now: plus(86400), deliveryId: delivery.id, handler });
  assert.equal(recovered.duplicate, false);
  assert.equal(recovered.delivery.status, 'delivered');
  assert.equal(recovered.delivery.attempts, 1);
  assert.equal(calls, 6);
  const duplicate = await redeliverEvent({ ...location(vault, state), grants: ['events-deliver'], now: plus(90000), deliveryId: delivery.id, handler });
  assert.equal(duplicate.duplicate, true);
  assert.equal(calls, 6);
  assert.equal((await readVault(vault)).snapshot, exampleSnapshot);
});

test('an older failed delivery is retried after a newer observation', async () => {
  const vault = await sandbox('older');
  const state = await stateDir('older-state');
  const handler = async () => { throw new Error('synthetic sink failure'); };
  await subscribeEvents({ ...location(vault, state), grants: ['events-subscribe'], now: t0, id: 'sub_task', selector: 'record', recordId: 'task_sample' });
  await deliverEvents({ ...location(vault, state), grants: ['events-deliver'], now: t0, handler });
  const file = path.join(vault, 'life/tasks/task_sample.json');
  const record = JSON.parse(await readFile(file, 'utf8')) as { title: string };
  record.title = '另一条合成观察';
  await writeFile(file, JSON.stringify(record));
  await deliverEvents({ ...location(vault, state), grants: ['events-deliver'], now: plus(60), handler });
  const saved = await readState(state);
  assert.equal(saved.deliveries.length, 2);
  assert.deepEqual(saved.deliveries.map(item => item.attempts).sort(), [1, 2]);
  assert.equal(saved.deliveries.every(item => item.status === 'retry'), true);
});

test('paused subscriptions do not emit and resume continues from the file', async () => {
  const vault = await sandbox('pause');
  const state = await stateDir('pause-state');
  await subscribeEvents({ ...location(vault, state), grants: ['events-subscribe'], now: t0, id: 'sub_life', selector: 'life' });
  await setSubscriptionStatus({ ...location(vault, state), grants: ['events-subscribe'], now: t0, id: 'sub_life', status: 'paused' });
  const paused = await deliverEvents({ ...location(vault, state), grants: ['events-deliver'], now: t0 });
  assert.equal(paused.attempted, 0);
  assert.equal((await readState(state)).deliveries.length, 0);
  await setSubscriptionStatus({ ...location(vault, state), grants: ['events-subscribe'], now: plus(1), id: 'sub_life', status: 'active' });
  const resumed = await deliverEvents({ ...location(vault, state), grants: ['events-deliver'], now: plus(1) });
  assert.equal(resumed.delivered, 1);
  assert.equal((await readState(state)).deliveries[0]!.kind, 'life.observed');
});

test('event paths stay outside the vault and bound to one vault', async () => {
  const vault = await sandbox('paths');
  const other = await sandbox('paths-other');
  const state = await stateDir('paths-state');
  const input = { ...location(vault, state), grants: ['events-subscribe'] as const, now: t0, id: 'sub_life', selector: 'life' };
  await assert.rejects(subscribeEvents({ ...input, state: path.join(vault, 'events') }), /outside the source vault/);
  await assert.rejects(lstat(path.join(vault, 'events')), { code: 'ENOENT' });
  await assert.rejects(subscribeEvents({ ...input, state: path.resolve('src/event-state') }), /--state must stay outside this repository/);
  await assert.rejects(lstat(path.resolve('src/event-state')), { code: 'ENOENT' });
  const linkParent = await freshDir('link');
  const link = path.join(linkParent, 'state');
  await symlink(vault, link);
  await assert.rejects(subscribeEvents({ ...input, state: link }), /symlink/);
  await subscribeEvents(input);
  const outside = path.join(await freshDir('secret'), 'secret.json');
  await writeFile(outside, 'keep\n');
  const stateFile = path.join(state, 'state.json');
  const original = await readFile(stateFile);
  await unlink(stateFile);
  await symlink(outside, stateFile);
  await assert.rejects(deliverEvents({ ...location(vault, state), grants: ['events-deliver'], now: t0 }), /regular file/);
  assert.equal(await readFile(outside, 'utf8'), 'keep\n');
  await unlink(stateFile);
  await writeFile(stateFile, original);
  const manifest = JSON.parse(await readFile(path.join(other, 'manifest.json'), 'utf8')) as { vaultId: string };
  manifest.vaultId = 'vault_other';
  await writeFile(path.join(other, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(subscribeEvents({ ...location(other, state), grants: ['events-subscribe'], now: t0, id: 'sub_life', selector: 'life' }), /different vault/);
  assert.equal((await readFile(stateFile)).equals(original), true);
  await writeFile(stateFile, '{ "schemaVersion": 1 }\n');
  await assert.rejects(subscribeEvents(input), /Invalid event state/);
  assert.equal(await readFile(stateFile, 'utf8'), '{ "schemaVersion": 1 }\n');
  const broken = await sandbox('broken');
  const finance = JSON.parse(await readFile(path.join(broken, 'finance/pending/finance_sample.json'), 'utf8')) as { status: string };
  finance.status = 'confirmed';
  await writeFile(path.join(broken, 'finance/pending/finance_sample.json'), JSON.stringify(finance));
  const brokenState = await stateDir('broken-state');
  await assert.rejects(subscribeEvents({ ...location(broken, brokenState), grants: ['events-subscribe'], now: t0, id: 'sub_life', selector: 'life' }), /Invalid vault/);
  await assert.rejects(lstat(path.join(brokenState, 'state.json')), { code: 'ENOENT' });
});

test('a full local journal is not overwritten', async () => {
  const vault = await sandbox('full');
  const state = await stateDir('full-state');
  await mkdir(state, { recursive: true });
  const snapshot = (await readVault(vault)).snapshot;
  const vaultId = (await readVault(vault)).manifest.vaultId;
  const deliveries: EventDelivery[] = [];
  for (let index = 0; index < 100; index += 1) {
    const key = 'obs:' + digest('seed-' + index);
    deliveries.push({
      schemaVersion: 1, id: 'dlv_' + digest('delivery-' + index).slice(0, 24), vaultId, subscriptionId: 'sub_task', idempotencyKey: key,
      kind: 'record.observed', status: 'delivered', attempts: 1, maxAttempts: 5, createdAt: t0, updatedAt: t0, deliveredAt: t0,
      observation: { sourceSnapshot: snapshot, key }, effects: { vaultWrite: false, lifeStatusChanged: false, financeConfirmed: false, externalDelivery: false },
    });
  }
  const seeded: EventState = {
    schemaVersion: 1, kind: 'eventState', vaultId, daemon: 'disabled', externalDelivery: 'disabled', pluginActivation: 'disabled', updatedAt: t0,
    subscriptions: [{ schemaVersion: 1, id: 'sub_task', vaultId, status: 'active', createdAt: t0, updatedAt: t0, selector: { type: 'record', recordId: 'task_sample' }, sink: { type: 'journal' } }],
    schedules: [], deliveries,
  };
  const file = path.join(state, 'state.json');
  await writeFile(file, JSON.stringify(seeded, null, 2) + '\n');
  const bytes = await readFile(file);
  await assert.rejects(deliverEvents({ ...location(vault, state), grants: ['events-deliver'], now: t0 }), /Event journal is full/);
  assert.equal((await readFile(file)).equals(bytes), true);
});

test('restricted tool calls reject path overrides, plugins, and unlisted tools', async () => {
  const vault = await sandbox('tools');
  const state = await stateDir('tools-state');
  const before = (await readVault(vault)).snapshot;
  await assert.rejects(callRestrictedTool({ project, vault, grants: [], tool: 'focus.capture', args: {}, now: t0 }), /Unknown event tool/);
  await assert.rejects(callRestrictedTool({ project, vault, grants: [], tool: 'focus.search', args: { vault: '/tmp/other', query: '餐厅' }, now: t0 }), /does not accept argument: vault/);
  await assert.rejects(callRestrictedTool({ project, vault, state, grants: ['events-subscribe'], tool: 'focus.subscribe', args: { id: 'sub_life', selector: 'life', sink: 'plugin' }, now: t0 }), /does not accept argument: sink/);
  await assert.rejects(callRestrictedTool({ project, vault, state, grants: ['events-deliver'], tool: 'focus.subscribe', args: { id: 'sub_life', selector: 'life' }, now: t0 }), /events-subscribe/);
  const searched = await callRestrictedTool({ project, vault, grants: [], tool: 'focus.search', args: { query: '$(rm -rf /); cat ~/.ssh/id_rsa' }, now: t0 });
  assert.deepEqual(searched.result, []);
  const previous = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: unknown) => { calls.push(String(input)); throw new Error('network was called'); }) as typeof fetch;
  try {
    const matched = await callRestrictedTool({ project, vault, grants: [], tool: 'focus.match_place', args: { placeId: 'place_sample', query: 'synthetic hall' }, now: t0 });
    const result = matched.result as { confirmed: boolean; geocoder: string; proposalsOnly: boolean };
    assert.equal(result.confirmed, false);
    assert.equal(result.geocoder, 'disabled');
    assert.equal(result.proposalsOnly, true);
    const fragments = await callRestrictedTool({ project, vault, grants: [], tool: 'focus.fragments', args: {}, now: t0 });
    assert.equal((fragments.result as { fragments: unknown[] }).fragments.length, 0);
    assert.deepEqual(calls, []);
  } finally { globalThis.fetch = previous; }
  const subscribed = await callRestrictedTool({ project, vault, state, grants: ['events-subscribe'], tool: 'focus.subscribe', args: { id: 'sub_life', selector: 'life' }, now: t0 });
  assert.equal((subscribed.result as { created: boolean }).created, true);
  assert.equal((await readVault(vault)).snapshot, before);
  assert.equal(JSON.stringify(await readState(state)).includes('$(rm -rf /)'), false);
});

test('a delivery holds the journal lock until its write is finished', async () => {
  const vault = await sandbox('lock');
  const state = await stateDir('lock-state');
  await subscribeEvents({ ...location(vault, state), grants: ['events-subscribe'], now: t0, id: 'sub_task', selector: 'record', recordId: 'task_sample' });
  const moduleUrl = pathToFileURL(path.resolve('.codex-work/build/src/events.js')).href;
  const script = [
    `import { subscribeEvents } from ${JSON.stringify(moduleUrl)};`,
    `await subscribeEvents(${JSON.stringify({ ...location(vault, state), grants: ['events-subscribe'], now: plus(1), id: 'sub_life', selector: 'life' })});`,
  ].join('\n');
  let stderr = '';
  let child: ReturnType<typeof spawn> | undefined;
  await deliverEvents({
    ...location(vault, state), grants: ['events-deliver'], now: t0, handler: async () => {
      const started = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
      child = started;
      started.stderr?.setEncoding('utf8');
      started.stderr?.on('data', chunk => { stderr += chunk; });
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (started.exitCode !== null) throw new Error('subscribe finished while delivery held the journal: ' + stderr);
        const names = await readdir(state);
        if (names.some(name => name.startsWith('.state.lock.waiting-'))) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error('subscribe did not wait for the journal lock: ' + stderr);
    },
  });
  const finished = child;
  if (!finished) throw new Error('delivery handler did not start');
  const exit = await new Promise<number>((resolve, reject) => {
    if (finished.exitCode !== null) resolve(finished.exitCode);
    else finished.once('exit', code => resolve(code ?? 1));
    finished.once('error', reject);
  });
  assert.equal(exit, 0, stderr);
  const saved = await readState(state);
  assert.deepEqual(saved.subscriptions.map(item => item.id), ['sub_life', 'sub_task']);
  assert.equal(saved.deliveries.length, 1);
  assert.equal(saved.deliveries[0]!.status, 'delivered');
  assert.equal(saved.deliveries[0]!.subscriptionId, 'sub_task');
});

test('event commands require --vault and keep derived output outside it', async () => {
  const vault = await gitVault('cli');
  const head = gitExec(vault, ['rev-parse', 'HEAD']);
  const env = { ...process.env, FOCUS_VAULT_PATH: vault };
  const state = await stateDir('cli-state');
  for (const args of [
    ['events', 'status', '--state', state],
    ['events', 'subscribe', '--state', state, '--id', 'sub_life', '--selector', 'life', '--authorize', 'events-subscribe'],
    ['events', 'deliver', '--state', state, '--authorize', 'events-deliver'],
  ]) {
    const result = runCli(args, env);
    assert.equal(result.status, 1, args.join(' ') + result.stdout);
    assert.match(result.stdout, /--vault is required/);
  }
  const tools = runCli(['events', 'tools'], env);
  assert.equal(tools.status, 0, tools.stdout);
  assert.match(tools.stdout, /"server": "disabled"/);
  const plugins = runCli(['events', 'plugins'], env);
  assert.match(plugins.stdout, /"activation": "disabled"/);
  const denied = runCli(['events', 'subscribe', '--vault', example, '--state', state, '--id', 'sub_task', '--selector', 'record', '--record', 'task_sample', '--now', t0], env);
  assert.equal(denied.status, 1, denied.stdout);
  assert.match(denied.stdout, /events-subscribe/);
  await assert.rejects(lstat(path.join(state, 'state.json')), { code: 'ENOENT' });
  const created = runCli(['events', 'subscribe', '--vault', example, '--state', state, '--id', 'sub_task', '--selector', 'record', '--record', 'task_sample', '--authorize', 'events-subscribe', '--now', t0], env);
  assert.equal(created.status, 0, created.stdout);
  const status = runCli(['events', 'status', '--vault', example, '--state', state], env);
  assert.equal(status.status, 0, status.stdout);
  assert.match(status.stdout, /sub_task/);
  assert.equal(status.stdout.includes(example), false);
  const first = runCli(['events', 'deliver', '--vault', example, '--state', state, '--authorize', 'events-deliver', '--now', t0], env);
  assert.equal(first.status, 0, first.stdout);
  const second = runCli(['events', 'deliver', '--vault', example, '--state', state, '--authorize', 'events-deliver', '--now', t0], env);
  assert.equal(second.status, 0, second.stdout);
  assert.match(second.stdout, /"duplicate": true/);
  const out = path.join(await freshDir('event-out'), 'view');
  const written = runCli(['events', 'status', '--vault', example, '--state', state, '--out', out], env);
  assert.equal(written.status, 0, written.stdout);
  assert.match(await readFile(path.join(out, 'event-monitor.json'), 'utf8'), /"daemon": "disabled"/);
  const inside = runCli(['events', 'status', '--vault', vault, '--state', state, '--out', path.join(vault, 'inbox')], env);
  assert.equal(inside.status, 1, inside.stdout);
  assert.match(inside.stdout, /outside the source vault/);
  await assert.rejects(lstat(path.join(vault, 'inbox', 'event-monitor.json')), { code: 'ENOENT' });
  gitExec(vault, ['remote', 'add', 'origin', 'https://github.com/Shuang-su/focus-on-vault.git']);
  const remoteState = await stateDir('remote-state');
  const remote = runCli(['events', 'subscribe', '--vault', vault, '--state', remoteState, '--id', 'sub_life', '--selector', 'life', '--authorize', 'events-subscribe', '--now', t0], env);
  assert.equal(remote.status, 0, remote.stdout);
  assert.throws(() => git(vault, ['push', 'origin', 'main']), /not enabled/);
  assert.equal(gitExec(vault, ['status', '--porcelain']), '');
  assert.equal(gitExec(vault, ['rev-parse', 'HEAD']), head);
  assert.equal((await readVault(example)).snapshot, exampleSnapshot);
});
