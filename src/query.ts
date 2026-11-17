import { lstat, readFile } from 'node:fs/promises';
import type { CaptureRequest, ProcessingReceipt, QueryIndex, RecordData } from './contracts.js';
import { canonical, digest, readVault, safeFile, validateQueryIndex, type VaultSnapshot } from './vault.js';

const inboxStatuses = new Set(['planned', 'awaiting_merge', 'stored', 'needs_input', 'failed', 'saved']);
const lifeKinds = new Set(['task', 'plan', 'wishlist']);
const lifeOrder = { task: 0, plan: 1, wishlist: 2 } as const;
type LifeKind = keyof typeof lifeOrder;

export interface InboxItem {
  requestId: string;
  inputVersion: number;
  inputHash: string;
  capturedAt: string;
  text: string;
  status: 'planned' | 'awaiting_merge' | 'stored' | 'needs_input' | 'failed' | 'saved';
  recordIds: string[];
  verification: { verified: boolean; snapshot: string } | null;
  evidence?: { issueUrl?: string; prUrl?: string; commit?: string };
}
export interface SearchHit {
  id: string;
  path: string;
  title: string;
  archiveStatus: string;
  tags: string[];
  source: { kind: string; reference: string };
  url?: string;
  matched: string[];
  excerpt: string;
}
export interface LifeItem {
  id: string;
  kind: LifeKind;
  path: string;
  title: string;
  status: string;
  revision: number;
  updatedAt: string;
  links: string[];
  budget?: { amountMinor: number; currency: string; precision: number };
}
export interface AcceptanceReport {
  accepted: boolean;
  source: 'vault-files';
  vaultId?: string;
  snapshot?: string;
  records: number;
  inbox: number;
  collections: number;
  lifeItems: number;
  indexDigest?: string;
  checks: string[];
  errors: string[];
}

interface DailyContext { vault: VaultSnapshot; bodies: Map<string, string> }

const versionKey = (requestId: string, inputVersion: number) => requestId + '/v' + inputVersion;
export function normalizeText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en').replace(/[ \t\f\v]+/g, ' ').trim();
}
function queryTerms(query: string | undefined): string[] {
  if (!query) return [];
  if (query.length > 2000) throw new Error('Search query exceeds 2000 characters');
  return normalizeText(query).split(/\s+/u).filter(Boolean);
}
function excerptOf(body: string | undefined, title: string): string {
  return Array.from((body ?? title).replace(/\s+/g, ' ').trim()).slice(0, 80).join('');
}
function recordText(record: RecordData, body: string | undefined): string {
  const tags = record.kind === 'collection' ? record.tags ?? [] : [];
  const url = record.kind === 'collection' ? record.url : undefined;
  const status = 'status' in record ? record.status : undefined;
  const archiveStatus = 'archiveStatus' in record ? record.archiveStatus : undefined;
  return normalizeText([record.title, status, archiveStatus, ...tags, url, record.source.kind, record.source.reference, body].filter((part): part is string => !!part).join('\n'));
}
async function openDaily(vaultPath: string): Promise<DailyContext> {
  const vault = await readVault(vaultPath);
  const bodies = new Map<string, string>();
  if (!vault.errors.length) {
    for (const { record } of vault.records.values()) {
      if ('bodyPath' in record && record.bodyPath) bodies.set(record.bodyPath, (await readFile(await safeFile(vault.root, record.bodyPath))).toString('utf8'));
    }
  }
  return { vault, bodies };
}
function assertUsable(ctx: DailyContext): void {
  if (ctx.vault.errors.length) throw new Error('Invalid vault: ' + ctx.vault.errors.join('; '));
}
function indexRecords(ctx: DailyContext): QueryIndex['records'] {
  return [...ctx.vault.records.values()].sort((a, b) => a.record.id.localeCompare(b.record.id, 'en')).map(({ path, record }) => {
    const body = 'bodyPath' in record && record.bodyPath ? ctx.bodies.get(record.bodyPath) : undefined;
    const entry: QueryIndex['records'][number] = {
      id: record.id, kind: record.kind, path, title: record.title, revision: record.revision, updatedAt: record.updatedAt,
      recordHash: digest(canonical(record)), text: recordText(record, body), source: { kind: record.source.kind, reference: record.source.reference },
    };
    if ('status' in record && record.status) entry.status = record.status;
    if ('archiveStatus' in record && record.archiveStatus) entry.archiveStatus = record.archiveStatus;
    if (record.kind === 'collection' && record.tags) entry.tags = [...record.tags];
    if (record.kind === 'collection' && record.url) entry.url = record.url;
    return entry;
  });
}
function indexInbox(ctx: DailyContext): QueryIndex['inbox'] {
  return [...ctx.vault.requests.values()].map(request => {
    const receipt = ctx.vault.receipts.get(versionKey(request.requestId, request.inputVersion));
    const entry: QueryIndex['inbox'][number] = {
      requestId: request.requestId, inputVersion: request.inputVersion, inputHash: digest(canonical(request)), capturedAt: request.capturedAt,
      status: receipt?.status ?? 'saved', recordIds: [...new Set(receipt ? receipt.recordIds : request.operations.map(operation => operation.record.id))],
    };
    if (receipt) entry.receiptHash = digest(canonical(receipt));
    return entry;
  }).sort((a, b) => a.capturedAt.localeCompare(b.capturedAt, 'en') || a.requestId.localeCompare(b.requestId, 'en') || a.inputVersion - b.inputVersion);
}
function indexFrom(ctx: DailyContext): QueryIndex {
  const index: QueryIndex = { schemaVersion: 1, vaultId: ctx.vault.manifest.vaultId, sourceSnapshot: ctx.vault.snapshot, records: indexRecords(ctx), inbox: indexInbox(ctx) };
  if (!validateQueryIndex(index)) throw new Error('Invalid query index: ' + JSON.stringify(validateQueryIndex.errors));
  return index;
}
function inboxFrom(ctx: DailyContext, status?: string): InboxItem[] {
  if (status && !inboxStatuses.has(status)) throw new Error('Unknown inbox status');
  const items = [...ctx.vault.requests.values()].map(request => inboxItem(request, ctx.vault.receipts.get(versionKey(request.requestId, request.inputVersion))));
  items.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt, 'en') || a.requestId.localeCompare(b.requestId, 'en') || a.inputVersion - b.inputVersion);
  return status ? items.filter(item => item.status === status) : items;
}
function inboxItem(request: CaptureRequest, receipt: ProcessingReceipt | undefined): InboxItem {
  const item: InboxItem = {
    requestId: request.requestId, inputVersion: request.inputVersion, inputHash: digest(canonical(request)), capturedAt: request.capturedAt,
    text: request.input.text, status: receipt?.status ?? 'saved',
    recordIds: receipt ? [...receipt.recordIds] : request.operations.map(operation => operation.record.id),
    verification: receipt ? { verified: receipt.verification.verified, snapshot: receipt.verification.snapshot } : null,
  };
  if (receipt?.evidence) item.evidence = { ...receipt.evidence };
  return item;
}
function searchFrom(ctx: DailyContext, options?: { query?: string; tag?: string }): SearchHit[] {
  const terms = queryTerms(options?.query);
  const hits: SearchHit[] = [];
  for (const { path: recordPath, record } of [...ctx.vault.records.values()].sort((a, b) => a.record.id.localeCompare(b.record.id, 'en'))) {
    if (record.kind !== 'collection') continue;
    const tags = [...(record.tags ?? [])];
    if (options?.tag && !tags.includes(options.tag)) continue;
    const body = record.bodyPath ? ctx.bodies.get(record.bodyPath) : undefined;
    if (terms.length && !terms.every(term => recordText(record, body).includes(term))) continue;
    const fields: Array<[string, string | undefined]> = [
      ['archiveStatus', record.archiveStatus], ['body', body], ['source', record.source.kind + '\n' + record.source.reference],
      ['tags', tags.join('\n')], ['title', record.title], ['url', record.url],
    ];
    const matched = fields.filter(([, value]) => !!value && terms.some(term => normalizeText(value).includes(term))).map(([name]) => name);
    const hit: SearchHit = {
      id: record.id, path: recordPath, title: record.title, archiveStatus: record.archiveStatus, tags, source: { kind: record.source.kind, reference: record.source.reference },
      matched, excerpt: excerptOf(body, record.title),
    };
    if (record.url) hit.url = record.url;
    hits.push(hit);
  }
  return hits;
}
function isLife(record: RecordData): record is Extract<RecordData, { kind: LifeKind }> {
  return record.kind === 'task' || record.kind === 'plan' || record.kind === 'wishlist';
}
function lifeFrom(ctx: DailyContext, options?: { kind?: string; status?: string }): LifeItem[] {
  if (options?.kind && !lifeKinds.has(options.kind)) throw new Error('Life kind must be task, plan, or wishlist');
  const items: LifeItem[] = [];
  for (const { path: recordPath, record } of ctx.vault.records.values()) {
    if (!isLife(record)) continue;
    if (options?.kind && record.kind !== options.kind) continue;
    if (options?.status && record.status !== options.status) continue;
    const item: LifeItem = {
      id: record.id, kind: record.kind, path: recordPath, title: record.title, status: record.status,
      revision: record.revision, updatedAt: record.updatedAt, links: [...record.links],
    };
    if (record.kind === 'wishlist') item.budget = { amountMinor: record.budget.amountMinor, currency: record.budget.currency, precision: record.budget.precision };
    items.push(item);
  }
  items.sort((a, b) => lifeOrder[a.kind] - lifeOrder[b.kind] || a.id.localeCompare(b.id, 'en'));
  return items;
}
function blankReport(errors: string[]): AcceptanceReport {
  return { accepted: false, source: 'vault-files', records: 0, inbox: 0, collections: 0, lifeItems: 0, checks: [], errors };
}

export const indexDigest = (index: QueryIndex) => digest(canonical(index));
export async function buildQueryIndex(vaultPath: string): Promise<QueryIndex> {
  const ctx = await openDaily(vaultPath);
  assertUsable(ctx);
  return indexFrom(ctx);
}
export async function listInbox(vaultPath: string, status?: string): Promise<InboxItem[]> {
  const ctx = await openDaily(vaultPath);
  assertUsable(ctx);
  return inboxFrom(ctx, status);
}
export async function searchCollections(vaultPath: string, options?: { query?: string; tag?: string }): Promise<SearchHit[]> {
  const ctx = await openDaily(vaultPath);
  assertUsable(ctx);
  return searchFrom(ctx, options);
}
export async function listLife(vaultPath: string, options?: { kind?: string; status?: string }): Promise<LifeItem[]> {
  const ctx = await openDaily(vaultPath);
  assertUsable(ctx);
  return lifeFrom(ctx, options);
}
export async function readSavedIndex(file: string): Promise<QueryIndex> {
  const stat = await lstat(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Query index must be a regular file');
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(file, 'utf8')); }
  catch { throw new Error('Invalid query index'); }
  if (!validateQueryIndex(parsed)) throw new Error('Invalid query index');
  return parsed;
}
export async function assertSavedIndex(file: string, fresh: QueryIndex): Promise<void> {
  const saved = await readSavedIndex(file);
  if (canonical(saved) !== canonical(fresh)) throw new Error('Query index does not match vault files; rebuild it from the vault');
}
export async function acceptVault(vaultPath: string): Promise<AcceptanceReport> {
  let ctx: DailyContext;
  try { ctx = await openDaily(vaultPath); }
  catch (error) { return blankReport([error instanceof Error ? error.message : 'Unknown error']); }
  const collections = [...ctx.vault.records.values()].filter(entry => entry.record.kind === 'collection');
  const lifeRecords = [...ctx.vault.records.values()].filter(entry => isLife(entry.record));
  const report: AcceptanceReport = {
    accepted: false, source: 'vault-files', vaultId: ctx.vault.manifest.vaultId, snapshot: ctx.vault.snapshot,
    records: ctx.vault.records.size, inbox: ctx.vault.requests.size, collections: collections.length, lifeItems: lifeRecords.length, checks: [], errors: [],
  };
  if (ctx.vault.errors.length) { report.errors = ctx.vault.errors; return report; }
  let index: QueryIndex;
  try {
    index = indexFrom(ctx);
    const again = indexFrom(await openDaily(vaultPath));
    if (canonical(index) !== canonical(again)) report.errors.push('query index rebuild is not stable');
    else report.checks.push('index-rebuild');
  } catch (error) {
    report.errors.push(error instanceof Error ? error.message : 'query index failed');
    return report;
  }
  report.indexDigest = indexDigest(index);
  if (index.sourceSnapshot !== ctx.vault.snapshot || index.vaultId !== ctx.vault.manifest.vaultId) report.errors.push('query index does not cite the vault snapshot');
  if (index.records.length !== ctx.vault.records.size || new Set(index.records.map(entry => entry.id)).size !== index.records.length) report.errors.push('query index does not cover every record once');
  else report.checks.push('index-covers-records');
  for (const entry of index.records) {
    try {
      const disk = JSON.parse((await readFile(await safeFile(ctx.vault.root, entry.path))).toString('utf8')) as RecordData;
      const memory = ctx.vault.records.get(entry.id);
      if (digest(canonical(disk)) !== entry.recordHash || !memory || memory.path !== entry.path || digest(canonical(memory.record)) !== entry.recordHash) report.errors.push('index does not match file ' + entry.id);
      if (entry.path.startsWith('/') || entry.path.includes('\\')) report.errors.push('index path is not relative ' + entry.id);
    } catch { report.errors.push('index does not match file ' + entry.id); }
  }
  for (const { record } of ctx.vault.records.values()) {
    if (!('bodyPath' in record) || !record.bodyPath) continue;
    const body = ctx.bodies.get(record.bodyPath);
    const indexed = index.records.find(entry => entry.id === record.id);
    if (!body || !indexed || !indexed.text.includes(normalizeText(body))) report.errors.push('index text missing body ' + record.id);
  }
  if (!report.errors.some(error => error.startsWith('index does not match file') || error.startsWith('index path') || error.startsWith('index text'))) report.checks.push('index-matches-files');
  if (index.inbox.length !== ctx.vault.requests.size) report.errors.push('index inbox does not match request files');
  for (const entry of index.inbox) {
    const request = ctx.vault.requests.get(versionKey(entry.requestId, entry.inputVersion));
    const receipt = ctx.vault.receipts.get(versionKey(entry.requestId, entry.inputVersion));
    if (!request || digest(canonical(request)) !== entry.inputHash || entry.status !== (receipt?.status ?? 'saved')) report.errors.push('index inbox does not match request files');
    if (receipt && entry.receiptHash !== digest(canonical(receipt))) report.errors.push('index inbox does not match receipt file');
    if (!receipt && entry.receiptHash) report.errors.push('index inbox invented a receipt');
  }
  if (!report.errors.some(error => error.startsWith('index inbox'))) report.checks.push('inbox-matches-files');
  for (const receipt of ctx.vault.receipts.values()) {
    if (receipt.status !== 'stored') continue;
    for (const id of receipt.recordIds) if (!ctx.vault.records.has(id)) report.errors.push('stored receipt points at missing record ' + id);
  }
  if (!report.errors.some(error => error.startsWith('stored receipt'))) report.checks.push('stored-receipts-resolve');
  const found = searchFrom(ctx);
  if (found.length !== collections.length || collections.some(({ record }) => !searchFrom(ctx, { query: record.title }).some(hit => hit.id === record.id))) report.errors.push('collection search missed a vault record');
  else report.checks.push('collection-search');
  const life = lifeFrom(ctx);
  if (life.length !== lifeRecords.length) report.errors.push('life items do not match vault files');
  for (const item of life) {
    try {
      const disk = JSON.parse((await readFile(await safeFile(ctx.vault.root, item.path))).toString('utf8')) as { id?: string; kind?: string; status?: string; title?: string; revision?: number };
      if (disk.id !== item.id || disk.kind !== item.kind || disk.status !== item.status || disk.title !== item.title || disk.revision !== item.revision) report.errors.push('life item does not match file ' + item.path);
    } catch { report.errors.push('life item does not match file ' + item.path); }
  }
  if (!report.errors.some(error => error.startsWith('life item'))) report.checks.push('life-status-from-files');
  for (const { record } of ctx.vault.records.values()) {
    const status = 'status' in record ? String(record.status) : undefined;
    if (record.kind === 'finance_draft' && status !== 'pending') report.errors.push('finance draft is not pending ' + record.id);
  }
  if (!report.errors.some(error => error.startsWith('finance draft'))) report.checks.push('finance-pending');
  const end = await readVault(vaultPath);
  if (end.snapshot !== ctx.vault.snapshot || end.errors.length !== ctx.vault.errors.length) report.errors.push('acceptance changed the vault');
  else report.checks.push('vault-unchanged');
  report.accepted = report.errors.length === 0;
  return report;
}
