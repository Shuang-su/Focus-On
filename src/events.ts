import { constants } from 'node:fs';
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { eventsDeliverGrant, eventsScheduleGrant, eventsSubscribeGrant, assertEventsAuthorized, assertEventsRead } from './authorization.js';
import type { EventDelivery, EventDeliveryRun, EventMonitor, EventSchedule, EventState, EventSubscription, EventToolCatalog, PluginCatalog, RecordData } from './contracts.js';
import { buildCollectionMap, buildReferencePack, listPlaces, matchPlace } from './context.js';
import { assertNoSymlink, assertOutputOutsideVault, transferPath } from './output.js';
import { listInbox, listLife, searchCollections } from './query.js';
import { canonical, digest, readVault, validateEventDeliveryRun, validateEventMonitor, validateEventSchedule, validateEventState, validateEventSubscription, validateEventToolCatalog, validatePluginCatalog, type VaultSnapshot } from './vault.js';

const idPattern = /^[a-z][a-z0-9_-]{2,100}$/;
const maxSubscriptions = 50;
const maxSchedules = 50;
const maxDeliveries = 100;
const maxCatchup = 8;
const maxAttempts = 5;
const noEffects = { vaultWrite: false, lifeStatusChanged: false, financeConfirmed: false, externalDelivery: false } as const;
const toolFields: Record<string, readonly string[]> = {
  'focus.inbox': ['status'],
  'focus.search': ['query', 'tag'],
  'focus.life': ['kind', 'status'],
  'focus.places': [],
  'focus.match_place': ['placeId', 'query'],
  'focus.map': [],
  'focus.fragments': [],
  'focus.events_status': [],
  'focus.subscribe': ['id', 'selector', 'recordId'],
  'focus.pause_subscription': ['id'],
  'focus.resume_subscription': ['id'],
  'focus.schedule': ['id', 'subscriptionId', 'every', 'start'],
  'focus.pause_schedule': ['id'],
  'focus.resume_schedule': ['id'],
  'focus.deliver': [],
  'focus.redeliver': ['deliveryId'],
};
const forbiddenArgs = new Set(['vault', 'state', 'command', 'authorize', 'out', 'plugin', 'sink', 'handler', 'cwd', 'path', '__proto__', 'constructor', 'prototype']);

export type EventHandler = (delivery: EventDelivery) => Promise<void> | void;
export interface EventLocation { project: string; vault: string; state: string }
interface Clock { now: string }

export function eventNow(value: string): string {
  if (!value || value.length > 40 || /[\u0000-\u001f]/.test(value)) throw new Error('--now must be an ISO date-time');
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error('--now must be an ISO date-time');
  return new Date(parsed).toISOString();
}
export function requireInteger(flag: string, value: string | undefined): number {
  if (!value || !/^[0-9]+$/.test(value)) throw new Error(flag + ' must be an integer');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(flag + ' must be an integer');
  return parsed;
}
export function parseToolArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  if (raw.length > 8000) throw new Error('--args exceeds 8000 characters');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error('--args must be a JSON object'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('--args must be a JSON object');
  return parsed as Record<string, unknown>;
}

function requireId(value: string | undefined, label: string): string {
  if (!value || !idPattern.test(value)) throw new Error(label + ' must be a stable id');
  return value;
}
function addSeconds(iso: string, seconds: number): string {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString();
}
function backoffSeconds(attempt: number): number {
  const shift = Math.min(Math.max(attempt, 1) - 1, 6);
  return Math.min(3600, 60 * (2 ** shift));
}
function sanitizeError(error: unknown, hidden: readonly string[]): string {
  let message = error instanceof Error ? error.message : 'Event sink failed';
  for (const secret of hidden) if (secret) message = message.split(secret).join('[path]');
  message = message.replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
  return message || 'Event sink failed';
}
function assertUnique(ids: string[], label: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new Error('Duplicate ' + label + ': ' + id);
    seen.add(id);
  }
}
async function openVault(vaultPath: string): Promise<VaultSnapshot> {
  const vault = await readVault(vaultPath);
  if (vault.errors.length) throw new Error('Invalid vault: ' + vault.errors.join('; '));
  return vault;
}
export async function resolveEventDirectory(project: string, vault: string, requested: string): Promise<string> {
  const destination = transferPath(project, requested, '--state');
  await assertOutputOutsideVault(vault, destination);
  await assertNoSymlink(destination);
  return destination;
}
function emptyState(vaultId: string, now: string): EventState {
  return {
    schemaVersion: 1, kind: 'eventState', vaultId, daemon: 'disabled', externalDelivery: 'disabled', pluginActivation: 'disabled',
    updatedAt: now, subscriptions: [], schedules: [], deliveries: [],
  };
}
function sortedState(state: EventState): EventState {
  return {
    ...state,
    subscriptions: [...state.subscriptions].sort((a, b) => a.id.localeCompare(b.id, 'en')),
    schedules: [...state.schedules].sort((a, b) => a.id.localeCompare(b.id, 'en')),
    deliveries: [...state.deliveries].sort((a, b) => a.createdAt.localeCompare(b.createdAt, 'en') || a.id.localeCompare(b.id, 'en')),
  };
}
function assertStateShape(state: EventState): void {
  assertUnique(state.subscriptions.map(item => item.id), 'subscription');
  assertUnique(state.schedules.map(item => item.id), 'schedule');
  assertUnique(state.deliveries.map(item => item.id), 'delivery');
  const keys = new Set<string>();
  for (const delivery of state.deliveries) {
    const key = delivery.subscriptionId + ':' + delivery.idempotencyKey;
    if (keys.has(key)) throw new Error('Duplicate event delivery key');
    keys.add(key);
  }
  for (const schedule of state.schedules) {
    if (!state.subscriptions.some(item => item.id === schedule.subscriptionId)) throw new Error('Schedule subscription is missing');
  }
}
async function loadState(directory: string, vaultId: string): Promise<EventState | undefined> {
  const target = path.join(directory, 'state.json');
  let stat;
  try { stat = await lstat(target); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Event state must be a regular file');
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(target, 'utf8')); }
  catch { throw new Error('Invalid event state'); }
  if (!validateEventState(parsed)) throw new Error('Invalid event state');
  if (parsed.vaultId !== vaultId) throw new Error('Event state is bound to a different vault');
  assertStateShape(parsed);
  return parsed;
}
async function writeState(directory: string, state: EventState): Promise<void> {
  const next = sortedState(state);
  assertStateShape(next);
  if (!validateEventState(next)) throw new Error('Refusing to write an invalid event state');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, 'state.json');
  try {
    const existing = await lstat(target);
    if (existing.isSymbolicLink() || !existing.isFile()) throw new Error('Event state must be a regular file');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temporary = path.join(directory, '.state-' + process.pid + '-' + Date.now() + '.json');
  await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { flag: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode: 0o600 });
  try { await rename(temporary, target); }
  catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
  state.subscriptions = next.subscriptions;
  state.schedules = next.schedules;
  state.deliveries = next.deliveries;
}
function selectorOf(type: string, recordId: string | undefined): EventSubscription['selector'] {
  if (type === 'record') {
    if (!recordId || !idPattern.test(recordId)) throw new Error('--record is required for a record subscription');
    return { type: 'record', recordId };
  }
  if (recordId) throw new Error('--record is only valid for a record subscription');
  if (type === 'inbox' || type === 'life') return { type };
  throw new Error('Subscription selector must be record, inbox, or life');
}
function sameSelector(left: EventSubscription['selector'], right: EventSubscription['selector']): boolean {
  return canonical(left) === canonical(right);
}
async function prepare(location: EventLocation, now: string): Promise<{ directory: string; vault: VaultSnapshot; state: EventState | undefined }> {
  const clock = eventNow(now);
  const directory = await resolveEventDirectory(location.project, location.vault, location.state);
  const vault = await openVault(location.vault);
  const state = await loadState(directory, vault.manifest.vaultId);
  return { directory, vault, state: state ? { ...state, updatedAt: state.updatedAt } : undefined };
}
function materialKey(parts: unknown): string {
  return 'obs:' + digest(canonical(parts));
}
function scheduleKey(scheduleId: string, occurrence: string): string {
  return 'sch:' + digest(scheduleId + ':' + occurrence);
}
function recordStatus(record: RecordData): string | undefined {
  return 'status' in record && record.status ? record.status : undefined;
}
async function buildObservation(vaultPath: string, vault: VaultSnapshot, subscription: EventSubscription): Promise<{ key: string; kind: 'record.observed' | 'inbox.observed' | 'life.observed'; observation: EventDelivery['observation'] }> {
  if (subscription.selector.type === 'record') {
    const found = vault.records.get(subscription.selector.recordId);
    if (!found) {
      const key = materialKey(['record', subscription.selector.recordId, 'missing']);
      return { key, kind: 'record.observed', observation: { sourceSnapshot: vault.snapshot, key, missing: true } };
    }
    const record = found.record;
    const recordHash = digest(canonical(record));
    const key = materialKey(['record', record.id, record.revision, recordHash]);
    const view: NonNullable<EventDelivery['observation']['record']> = {
      id: record.id, kind: record.kind, revision: record.revision, recordHash, title: record.title,
    };
    const status = recordStatus(record);
    if (status) view.status = status;
    return { key, kind: 'record.observed', observation: { sourceSnapshot: vault.snapshot, key, record: view } };
  }
  if (subscription.selector.type === 'inbox') {
    const items = await listInbox(vaultPath);
    if (items.length > 100) throw new Error('Inbox observation exceeded 100 requests');
    const key = materialKey(['inbox', items.map(item => [item.requestId, item.inputVersion, item.status, item.inputHash, item.verification?.verified ?? null])]);
    const inbox = items.map(item => {
      const entry: NonNullable<EventDelivery['observation']['inbox']>[number] = {
        requestId: item.requestId, inputVersion: item.inputVersion, status: item.status, inputHash: item.inputHash,
      };
      if (item.verification) entry.verified = item.verification.verified;
      return entry;
    });
    return { key, kind: 'inbox.observed', observation: { sourceSnapshot: vault.snapshot, key, inbox, inboxCount: inbox.length } };
  }
  const items = await listLife(vaultPath);
  if (items.length > 100) throw new Error('Life observation exceeded 100 items');
  const key = materialKey(['life', items.map(item => [item.id, item.kind, item.status, item.revision, item.updatedAt, item.title])]);
  const life = items.map(item => ({ id: item.id, kind: item.kind, status: item.status, revision: item.revision, title: item.title }));
  return { key, kind: 'life.observed', observation: { sourceSnapshot: vault.snapshot, key, life, lifeCount: life.length } };
}
function findDelivery(state: EventState, subscriptionId: string, key: string): EventDelivery | undefined {
  return state.deliveries.find(item => item.subscriptionId === subscriptionId && item.idempotencyKey === key);
}
function createDelivery(state: EventState, input: { now: string; subscriptionId: string; scheduleId?: string; key: string; kind: EventDelivery['kind']; observation: EventDelivery['observation'] }): EventDelivery {
  if (state.deliveries.length >= maxDeliveries) throw new Error('Event journal is full');
  const id = 'dlv_' + digest(state.vaultId + ':' + input.subscriptionId + ':' + input.key).slice(0, 24);
  if (state.deliveries.some(item => item.id === id)) throw new Error('Duplicate event delivery: ' + id);
  const delivery: EventDelivery = {
    schemaVersion: 1, id, vaultId: state.vaultId, subscriptionId: input.subscriptionId, idempotencyKey: input.key,
    kind: input.kind, status: 'pending', attempts: 0, maxAttempts: maxAttempts, createdAt: input.now, updatedAt: input.now,
    observation: input.observation, effects: { ...noEffects },
  };
  if (input.scheduleId) delivery.scheduleId = input.scheduleId;
  state.deliveries.push(delivery);
  return delivery;
}
async function attemptDelivery(delivery: EventDelivery, now: string, handler: EventHandler, hidden: readonly string[], force: boolean): Promise<'delivered' | 'retry' | 'exhausted' | 'waiting'> {
  if (delivery.status === 'delivered') return 'delivered';
  if (delivery.status === 'exhausted') return 'exhausted';
  if (!force && delivery.status === 'retry' && delivery.nextAttemptAt && Date.parse(delivery.nextAttemptAt) > Date.parse(now)) return 'waiting';
  delivery.attempts += 1;
  delivery.updatedAt = now;
  try {
    await handler(delivery);
    delivery.status = 'delivered';
    delivery.deliveredAt = now;
    delete delivery.lastError;
    delete delivery.nextAttemptAt;
    return 'delivered';
  } catch (error) {
    delivery.lastError = sanitizeError(error, hidden);
    if (delivery.attempts >= delivery.maxAttempts) {
      delivery.status = 'exhausted';
      delete delivery.nextAttemptAt;
      return 'exhausted';
    }
    delivery.status = 'retry';
    delivery.nextAttemptAt = addSeconds(now, backoffSeconds(delivery.attempts));
    return 'retry';
  }
}
function eligible(state: EventState, delivery: EventDelivery): boolean {
  const subscription = state.subscriptions.find(item => item.id === delivery.subscriptionId);
  if (!subscription || subscription.status !== 'active') return false;
  if (!delivery.scheduleId) return true;
  const schedule = state.schedules.find(item => item.id === delivery.scheduleId);
  return !!schedule && schedule.status === 'active';
}
function runFrom(vaultId: string, now: string, notes: EventDeliveryRun['deliveries']): EventDeliveryRun {
  const run: EventDeliveryRun = {
    schemaVersion: 1, kind: 'eventDeliveryRun', vaultId, now, daemon: 'disabled', externalDelivery: 'disabled',
    attempted: notes.filter(item => !item.duplicate).length,
    delivered: notes.filter(item => !item.duplicate && item.status === 'delivered').length,
    retry: notes.filter(item => !item.duplicate && item.status === 'retry').length,
    exhausted: notes.filter(item => !item.duplicate && item.status === 'exhausted').length,
    duplicates: notes.filter(item => item.duplicate).length,
    deliveries: notes,
  };
  if (!validateEventDeliveryRun(run)) throw new Error('Invalid event delivery run');
  return run;
}

export async function subscribeEvents(input: EventLocation & Clock & { grants: readonly string[]; id: string; selector: string; recordId?: string }): Promise<{ subscription: EventSubscription; created: boolean }> {
  assertEventsAuthorized(input.grants, eventsSubscribeGrant);
  const now = eventNow(input.now);
  const id = requireId(input.id, 'Subscription id');
  const selector = selectorOf(input.selector, input.recordId);
  const directory = await resolveEventDirectory(input.project, input.vault, input.state);
  const vault = await openVault(input.vault);
  if (selector.type === 'record' && !vault.records.has(selector.recordId)) throw new Error('Subscribed record does not exist');
  const loaded = await loadState(directory, vault.manifest.vaultId);
  const state = loaded ?? emptyState(vault.manifest.vaultId, now);
  const existing = state.subscriptions.find(item => item.id === id);
  if (existing) {
    if (!sameSelector(existing.selector, selector) || existing.sink.type !== 'journal') throw new Error('Conflict: subscription ' + id + ' already exists');
    if (!validateEventSubscription(existing)) throw new Error('Invalid event subscription');
    return { subscription: existing, created: false };
  }
  if (state.subscriptions.length >= maxSubscriptions) throw new Error('Event subscription limit reached');
  const subscription: EventSubscription = {
    schemaVersion: 1, id, vaultId: vault.manifest.vaultId, status: 'active', createdAt: now, updatedAt: now, selector, sink: { type: 'journal' },
  };
  if (!validateEventSubscription(subscription)) throw new Error('Invalid event subscription');
  state.subscriptions.push(subscription);
  state.updatedAt = now;
  await writeState(directory, state);
  return { subscription, created: true };
}
export async function setSubscriptionStatus(input: EventLocation & Clock & { grants: readonly string[]; id: string; status: 'active' | 'paused' }): Promise<{ subscription: EventSubscription; changed: boolean }> {
  assertEventsAuthorized(input.grants, eventsSubscribeGrant);
  const now = eventNow(input.now);
  const id = requireId(input.id, 'Subscription id');
  const { directory, vault, state } = await prepare(input, now);
  if (!state) throw new Error('Unknown event subscription');
  const subscription = state.subscriptions.find(item => item.id === id);
  if (!subscription || subscription.vaultId !== vault.manifest.vaultId) throw new Error('Unknown event subscription');
  if (subscription.status === input.status) return { subscription, changed: false };
  subscription.status = input.status;
  subscription.updatedAt = now;
  state.updatedAt = now;
  await writeState(directory, state);
  return { subscription, changed: true };
}
export async function scheduleEvents(input: EventLocation & Clock & { grants: readonly string[]; id: string; subscriptionId: string; every: number; start: string }): Promise<{ schedule: EventSchedule; created: boolean }> {
  assertEventsAuthorized(input.grants, eventsScheduleGrant);
  const now = eventNow(input.now);
  const id = requireId(input.id, 'Schedule id');
  const subscriptionId = requireId(input.subscriptionId, 'Subscription id');
  if (!Number.isSafeInteger(input.every) || input.every < 60 || input.every > 31622400) throw new Error('--every must be between 60 and 31622400 seconds');
  const start = eventNow(input.start);
  const directory = await resolveEventDirectory(input.project, input.vault, input.state);
  const vault = await openVault(input.vault);
  const loaded = await loadState(directory, vault.manifest.vaultId);
  if (!loaded) throw new Error('Unknown event subscription');
  if (!loaded.subscriptions.some(item => item.id === subscriptionId)) throw new Error('Unknown event subscription');
  const existing = loaded.schedules.find(item => item.id === id);
  if (existing) {
    if (existing.subscriptionId !== subscriptionId || existing.intervalSeconds !== input.every || Date.parse(existing.startAt) !== Date.parse(start)) throw new Error('Conflict: schedule ' + id + ' already exists');
    if (!validateEventSchedule(existing)) throw new Error('Invalid event schedule');
    return { schedule: existing, created: false };
  }
  if (loaded.schedules.length >= maxSchedules) throw new Error('Event schedule limit reached');
  const schedule: EventSchedule = {
    schemaVersion: 1, id, vaultId: vault.manifest.vaultId, status: 'active', subscriptionId,
    intervalSeconds: input.every, startAt: start, nextDueAt: start, createdAt: now, updatedAt: now,
  };
  if (!validateEventSchedule(schedule)) throw new Error('Invalid event schedule');
  loaded.schedules.push(schedule);
  loaded.updatedAt = now;
  await writeState(directory, loaded);
  return { schedule, created: true };
}
export async function setScheduleStatus(input: EventLocation & Clock & { grants: readonly string[]; id: string; status: 'active' | 'paused' }): Promise<{ schedule: EventSchedule; changed: boolean }> {
  assertEventsAuthorized(input.grants, eventsScheduleGrant);
  const now = eventNow(input.now);
  const id = requireId(input.id, 'Schedule id');
  const { directory, state } = await prepare(input, now);
  if (!state) throw new Error('Unknown event schedule');
  const schedule = state.schedules.find(item => item.id === id);
  if (!schedule) throw new Error('Unknown event schedule');
  if (schedule.status === input.status) return { schedule, changed: false };
  schedule.status = input.status;
  schedule.updatedAt = now;
  state.updatedAt = now;
  await writeState(directory, state);
  return { schedule, changed: true };
}
export async function deliverEvents(input: EventLocation & Clock & { grants: readonly string[]; handler?: EventHandler }): Promise<EventDeliveryRun> {
  assertEventsAuthorized(input.grants, eventsDeliverGrant);
  const now = eventNow(input.now);
  const directory = await resolveEventDirectory(input.project, input.vault, input.state);
  const vault = await openVault(input.vault);
  const loaded = await loadState(directory, vault.manifest.vaultId);
  const state = loaded ?? emptyState(vault.manifest.vaultId, now);
  const hidden = [path.resolve(input.vault), directory];
  const ensured: EventDelivery[] = [];
  let dirty = false;
  for (const subscription of state.subscriptions) {
    if (subscription.status !== 'active') continue;
    const observed = await buildObservation(input.vault, vault, subscription);
    const existing = findDelivery(state, subscription.id, observed.key);
    if (existing) ensured.push(existing);
    else {
      ensured.push(createDelivery(state, { now, subscriptionId: subscription.id, key: observed.key, kind: observed.kind, observation: observed.observation }));
      dirty = true;
    }
  }
  for (const schedule of state.schedules) {
    if (schedule.status !== 'active') continue;
    const subscription = state.subscriptions.find(item => item.id === schedule.subscriptionId);
    if (!subscription || subscription.status !== 'active') continue;
    const observed = await buildObservation(input.vault, vault, subscription);
    let due = Date.parse(schedule.nextDueAt);
    const intervalMs = schedule.intervalSeconds * 1000;
    let steps = 0;
    while (due <= Date.parse(now) && steps < maxCatchup) {
      const occurrence = new Date(due).toISOString();
      const key = scheduleKey(schedule.id, occurrence);
      const existing = findDelivery(state, subscription.id, key);
      const observation: EventDelivery['observation'] = {
        ...observed.observation, key, changed: observed.key !== subscription.cursor, schedule: { id: schedule.id, occurrence },
      };
      if (existing) ensured.push(existing);
      else {
        ensured.push(createDelivery(state, { now, subscriptionId: subscription.id, scheduleId: schedule.id, key, kind: 'schedule.due', observation }));
        dirty = true;
      }
      steps += 1;
      due += intervalMs;
      schedule.nextDueAt = new Date(due).toISOString();
      schedule.updatedAt = now;
      dirty = true;
    }
  }
  if (dirty) {
    state.updatedAt = now;
    await writeState(directory, state);
  }
  const handler = input.handler ?? (async () => undefined);
  const notes: EventDeliveryRun['deliveries'] = [];
  const considered = new Set<string>();
  let changed = false;
  const noteAttempt = async (delivery: EventDelivery): Promise<void> => {
    if (!eligible(state, delivery) || (delivery.status !== 'pending' && delivery.status !== 'retry')) return;
    const outcome = await attemptDelivery(delivery, now, handler, hidden, false);
    if (outcome === 'waiting') return;
    notes.push({ id: delivery.id, status: delivery.status, duplicate: false, attempts: delivery.attempts });
    if (outcome === 'delivered' && delivery.kind !== 'schedule.due') {
      const subscription = state.subscriptions.find(item => item.id === delivery.subscriptionId);
      if (subscription) {
        subscription.cursor = delivery.idempotencyKey;
        subscription.updatedAt = now;
      }
    }
    changed = true;
  };
  for (const delivery of ensured) {
    considered.add(delivery.id);
    if (delivery.status === 'delivered') {
      notes.push({ id: delivery.id, status: delivery.status, duplicate: true, attempts: delivery.attempts });
      const subscription = state.subscriptions.find(item => item.id === delivery.subscriptionId);
      if (subscription && delivery.kind !== 'schedule.due' && subscription.cursor !== delivery.idempotencyKey) {
        subscription.cursor = delivery.idempotencyKey;
        subscription.updatedAt = now;
        changed = true;
      }
      continue;
    }
    await noteAttempt(delivery);
  }
  for (const delivery of state.deliveries) {
    if (considered.has(delivery.id)) continue;
    await noteAttempt(delivery);
  }
  if (changed) {
    state.updatedAt = now;
    await writeState(directory, state);
  }
  return runFrom(vault.manifest.vaultId, now, notes);
}
export async function redeliverEvent(input: EventLocation & Clock & { grants: readonly string[]; deliveryId: string; handler?: EventHandler }): Promise<{ delivery: EventDelivery; duplicate: boolean }> {
  assertEventsAuthorized(input.grants, eventsDeliverGrant);
  const now = eventNow(input.now);
  const directory = await resolveEventDirectory(input.project, input.vault, input.state);
  const vault = await openVault(input.vault);
  const state = await loadState(directory, vault.manifest.vaultId);
  if (!state) throw new Error('Unknown event delivery');
  const delivery = state.deliveries.find(item => item.id === input.deliveryId);
  if (!delivery) throw new Error('Unknown event delivery');
  if (delivery.status === 'delivered') return { delivery, duplicate: true };
  const subscription = state.subscriptions.find(item => item.id === delivery.subscriptionId);
  if (!subscription || subscription.status !== 'active') throw new Error('Subscription is paused');
  if (delivery.scheduleId) {
    const schedule = state.schedules.find(item => item.id === delivery.scheduleId);
    if (!schedule || schedule.status !== 'active') throw new Error('Schedule is paused');
  }
  if (delivery.status === 'exhausted') {
    delivery.status = 'pending';
    delivery.attempts = 0;
    delete delivery.lastError;
    delete delivery.nextAttemptAt;
    delete delivery.deliveredAt;
  }
  const handler = input.handler ?? (async () => undefined);
  const outcome = await attemptDelivery(delivery, now, handler, [path.resolve(input.vault), directory], true);
  if (outcome === 'delivered' && delivery.kind !== 'schedule.due') {
    subscription.cursor = delivery.idempotencyKey;
    subscription.updatedAt = now;
  }
  state.updatedAt = now;
  await writeState(directory, state);
  return { delivery, duplicate: false };
}
export async function eventStatus(input: EventLocation & { grants: readonly string[] }): Promise<EventMonitor> {
  assertEventsRead(input.grants);
  const directory = await resolveEventDirectory(input.project, input.vault, input.state);
  const vault = await openVault(input.vault);
  const state = await loadState(directory, vault.manifest.vaultId);
  const deliveries = state?.deliveries ?? [];
  const monitor: EventMonitor = {
    schemaVersion: 1, kind: 'eventMonitor', vaultId: vault.manifest.vaultId, sourceSnapshot: vault.snapshot,
    daemon: 'disabled', externalDelivery: 'disabled', pluginActivation: 'disabled', vaultWrites: false,
    state: state ? 'present' : 'absent',
    counts: {
      subscriptions: state?.subscriptions.length ?? 0,
      schedules: state?.schedules.length ?? 0,
      pending: deliveries.filter(item => item.status === 'pending').length,
      delivered: deliveries.filter(item => item.status === 'delivered').length,
      retry: deliveries.filter(item => item.status === 'retry').length,
      exhausted: deliveries.filter(item => item.status === 'exhausted').length,
    },
    failures: deliveries.flatMap(item => {
      if (item.status !== 'retry' && item.status !== 'exhausted') return [];
      const failure: EventMonitor['failures'][number] = {
        id: item.id, subscriptionId: item.subscriptionId, kind: item.kind, status: item.status, attempts: item.attempts, maxAttempts: maxAttempts, lastError: item.lastError ?? 'Event sink failed',
      };
      if (item.scheduleId) failure.scheduleId = item.scheduleId;
      if (item.nextAttemptAt) failure.nextAttemptAt = item.nextAttemptAt;
      return [failure];
    }),
    subscriptions: state ? [...state.subscriptions] : [],
    schedules: state ? [...state.schedules] : [],
    deliveries: deliveries.map(item => {
      const summary: EventMonitor['deliveries'][number] = {
        id: item.id, subscriptionId: item.subscriptionId, idempotencyKey: item.idempotencyKey, kind: item.kind, status: item.status, attempts: item.attempts, maxAttempts: maxAttempts,
      };
      if (item.scheduleId) summary.scheduleId = item.scheduleId;
      if (item.nextAttemptAt) summary.nextAttemptAt = item.nextAttemptAt;
      if (item.lastError) summary.lastError = item.lastError;
      return summary;
    }),
  };
  if (state) monitor.updatedAt = state.updatedAt;
  if (!validateEventMonitor(monitor)) throw new Error('Invalid event monitor: ' + JSON.stringify(validateEventMonitor.errors));
  return monitor;
}
export function eventToolCatalog(): EventToolCatalog {
  const catalog: EventToolCatalog = {
    schemaVersion: 1, kind: 'eventToolCatalog', transport: 'local', server: 'disabled',
    tools: [
      { name: 'focus.inbox', mutates: false, grant: null },
      { name: 'focus.search', mutates: false, grant: null },
      { name: 'focus.life', mutates: false, grant: null },
      { name: 'focus.places', mutates: false, grant: null },
      { name: 'focus.match_place', mutates: false, grant: null },
      { name: 'focus.map', mutates: false, grant: null },
      { name: 'focus.fragments', mutates: false, grant: null },
      { name: 'focus.events_status', mutates: false, grant: null },
      { name: 'focus.subscribe', mutates: true, grant: eventsSubscribeGrant },
      { name: 'focus.pause_subscription', mutates: true, grant: eventsSubscribeGrant },
      { name: 'focus.resume_subscription', mutates: true, grant: eventsSubscribeGrant },
      { name: 'focus.schedule', mutates: true, grant: eventsScheduleGrant },
      { name: 'focus.pause_schedule', mutates: true, grant: eventsScheduleGrant },
      { name: 'focus.resume_schedule', mutates: true, grant: eventsScheduleGrant },
      { name: 'focus.deliver', mutates: true, grant: eventsDeliverGrant },
      { name: 'focus.redeliver', mutates: true, grant: eventsDeliverGrant },
    ],
  };
  if (!validateEventToolCatalog(catalog)) throw new Error('Invalid event tool catalog');
  return catalog;
}
export function eventPlugins(): PluginCatalog {
  const catalog: PluginCatalog = {
    schemaVersion: 1, kind: 'pluginCatalog', activation: 'disabled',
    interfaces: [
      { id: 'map', kind: 'view', activation: 'disabled', document: 'collectionMap' },
      { id: 'ui', kind: 'view', activation: 'disabled', document: 'referencePack' },
    ],
  };
  if (!validatePluginCatalog(catalog)) throw new Error('Invalid plugin catalog');
  return catalog;
}
function toolArguments(tool: string, args: Record<string, unknown>): Record<string, string | number> {
  const allowed = toolFields[tool];
  if (!allowed) throw new Error('Unknown event tool: ' + tool);
  const read: Record<string, string | number> = {};
  for (const key of Object.keys(args)) {
    if (forbiddenArgs.has(key) || !allowed.includes(key)) throw new Error('Event tool does not accept argument: ' + key);
    const value = args[key];
    if (key === 'every') {
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error('every must be an integer');
      read[key] = value;
      continue;
    }
    if (typeof value !== 'string' || value.length > 2000 || /[\u0000-\u001f]/.test(value)) throw new Error(key + ' is not valid event data');
    read[key] = value;
  }
  return read;
}
function textArg(args: Record<string, string | number>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}
export async function callRestrictedTool(input: { project: string; vault: string; state?: string; grants: readonly string[]; tool: string; args: Record<string, unknown>; now: string; handler?: EventHandler }): Promise<{ tool: string; mutates: boolean; result: unknown }> {
  const catalog = eventToolCatalog();
  const described = catalog.tools.find(item => item.name === input.tool);
  if (!described || catalog.server !== 'disabled') throw new Error('Unknown event tool: ' + input.tool);
  const args = toolArguments(input.tool, input.args);
  const now = eventNow(input.now);
  if (!described.mutates) {
    assertEventsRead(input.grants);
    if (input.tool === 'focus.inbox') return { tool: input.tool, mutates: false, result: await listInbox(input.vault, textArg(args, 'status')) };
    if (input.tool === 'focus.search') return { tool: input.tool, mutates: false, result: await searchCollections(input.vault, { query: textArg(args, 'query'), tag: textArg(args, 'tag') }) };
    if (input.tool === 'focus.life') return { tool: input.tool, mutates: false, result: await listLife(input.vault, { kind: textArg(args, 'kind'), status: textArg(args, 'status') }) };
    if (input.tool === 'focus.places') return { tool: input.tool, mutates: false, result: await listPlaces(input.vault) };
    if (input.tool === 'focus.match_place') return { tool: input.tool, mutates: false, result: await matchPlace(input.vault, { placeId: textArg(args, 'placeId') ?? '', query: textArg(args, 'query') }) };
    if (input.tool === 'focus.map') return { tool: input.tool, mutates: false, result: await buildCollectionMap(input.vault) };
    if (input.tool === 'focus.fragments') return { tool: input.tool, mutates: false, result: await buildReferencePack(input.vault) };
    if (input.tool === 'focus.events_status') {
      if (!input.state) throw new Error('--state is required');
      return { tool: input.tool, mutates: false, result: await eventStatus({ project: input.project, vault: input.vault, state: input.state, grants: input.grants }) };
    }
  }
  if (!input.state) throw new Error('--state is required');
  const location = { project: input.project, vault: input.vault, state: input.state, grants: input.grants, now };
  if (input.tool === 'focus.subscribe') return { tool: input.tool, mutates: true, result: await subscribeEvents({ ...location, id: textArg(args, 'id') ?? '', selector: textArg(args, 'selector') ?? '', recordId: textArg(args, 'recordId') }) };
  if (input.tool === 'focus.pause_subscription') return { tool: input.tool, mutates: true, result: await setSubscriptionStatus({ ...location, id: textArg(args, 'id') ?? '', status: 'paused' }) };
  if (input.tool === 'focus.resume_subscription') return { tool: input.tool, mutates: true, result: await setSubscriptionStatus({ ...location, id: textArg(args, 'id') ?? '', status: 'active' }) };
  if (input.tool === 'focus.schedule') return { tool: input.tool, mutates: true, result: await scheduleEvents({ ...location, id: textArg(args, 'id') ?? '', subscriptionId: textArg(args, 'subscriptionId') ?? '', every: typeof args.every === 'number' ? args.every : Number.NaN, start: textArg(args, 'start') ?? '' }) };
  if (input.tool === 'focus.pause_schedule') return { tool: input.tool, mutates: true, result: await setScheduleStatus({ ...location, id: textArg(args, 'id') ?? '', status: 'paused' }) };
  if (input.tool === 'focus.resume_schedule') return { tool: input.tool, mutates: true, result: await setScheduleStatus({ ...location, id: textArg(args, 'id') ?? '', status: 'active' }) };
  if (input.tool === 'focus.deliver') return { tool: input.tool, mutates: true, result: await deliverEvents({ ...location, handler: input.handler }) };
  if (input.tool === 'focus.redeliver') return { tool: input.tool, mutates: true, result: await redeliverEvent({ ...location, deliveryId: textArg(args, 'deliveryId') ?? '', handler: input.handler }) };
  throw new Error('Unknown event tool: ' + input.tool);
}
