import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { manifestSchema, recordSchema, captureRequestSchema, changeSetSchema, processingReceiptSchema, queryIndexSchema, backupManifestSchema, type RecordData, type VaultManifest, type CaptureRequest, type ProcessingReceipt } from './contracts.js';

const ajv = new Ajv2020({ allErrors: true, strict: false });
(addFormats as unknown as (instance: Ajv2020) => void)(ajv);
export const validateRecord = ajv.compile(recordSchema);
export const validateManifest = ajv.compile(manifestSchema);
export const validateRequest = ajv.compile(captureRequestSchema);
export const validateChangeSet = ajv.compile(changeSetSchema);
export const validateReceipt = ajv.compile(processingReceiptSchema);
export const validateQueryIndex = ajv.compile(queryIndexSchema);
export const validateBackupManifest = ajv.compile(backupManifestSchema);
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value);
}
export const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const domains = ['collections', 'notes', 'life', 'finance', 'entities', 'attachments-manifest'];
export interface VaultSnapshot { root: string; manifest: VaultManifest; records: Map<string, { path: string; record: RecordData }>; requests: Map<string, CaptureRequest>; receipts: Map<string, ProcessingReceipt>; snapshot: string; errors: string[] }
export function assertSafeRelative(relative: string): void {
  if (!relative || path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some(part => part === '..' || part === '.' || part === '' || part.startsWith('.'))) throw new Error('Unsafe relative data path');
}
export async function safeFile(root: string, relative: string): Promise<string> {
  assertSafeRelative(relative);
  let cursor = root;
  for (const segment of relative.split('/')) {
    cursor = path.join(cursor, segment);
    if ((await lstat(cursor)).isSymbolicLink()) throw new Error('Symlinks are not allowed in vault data');
  }
  return cursor;
}
const writableRoot = /^(collections|notes|life|finance|entities|attachments-manifest|attachments|inbox)\//;
export async function prepareWrite(root: string, relative: string): Promise<string> {
  assertSafeRelative(relative);
  if (!writableRoot.test(relative)) throw new Error('Unsafe relative data path');
  let cursor = root;
  const parts = relative.split('/');
  for (let index = 0; index < parts.length; index += 1) {
    cursor = path.join(cursor, parts[index]!);
    const isFinal = index === parts.length - 1;
    try {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink()) throw new Error('Symlinks are not allowed in vault data');
      if (!isFinal && !stat.isDirectory()) throw new Error('Unsafe relative data path');
      if (isFinal && !stat.isFile()) throw new Error('Unsafe relative data path');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!isFinal) await mkdir(cursor);
    }
  }
  return cursor;
}
export async function readOptionalFile(root: string, relative: string): Promise<Buffer | undefined> {
  try { return await readFile(await safeFile(root, relative)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
async function files(root: string, relative: string): Promise<string[]> {
  const target = path.join(root, relative);
  try { if ((await lstat(target)).isSymbolicLink()) throw new Error('Symlink data directory: ' + relative); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
  const out: string[] = [];
  for (const item of await readdir(target, { withFileTypes: true })) {
    const rel = relative + '/' + item.name;
    if (item.isSymbolicLink()) throw new Error('Symlink data entry: ' + rel);
    if (item.isDirectory()) out.push(...await files(root, rel));
    else if (item.name.endsWith('.json')) out.push(rel);
  }
  return out.sort();
}
export async function readVault(input: string): Promise<VaultSnapshot> {
  const root = await realpath(input);
  const manifest = JSON.parse(await readFile(await safeFile(root, 'manifest.json'), 'utf8')) as VaultManifest;
  const errors: string[] = [];
  if (!validateManifest(manifest)) errors.push('manifest.json: ' + ajv.errorsText(validateManifest.errors));
  const records: VaultSnapshot['records'] = new Map();
  const hashes: [string, string][] = [['manifest.json', digest(canonical(manifest))]];
  const requests: VaultSnapshot['requests'] = new Map();
  for (const file of await files(root, 'inbox/requests')) {
    try {
      const request = JSON.parse(await readFile(await safeFile(root, file), 'utf8'));
      if (!validateRequest(request)) errors.push(file + ': invalid CaptureRequest');
      else {
        const version = request.requestId + '/v' + request.inputVersion;
        if (requests.has(version)) errors.push(file + ': duplicate request version ' + version);
        requests.set(version, request);
      }
    } catch { errors.push(file + ': invalid request JSON'); }
  }
  const receipts: VaultSnapshot['receipts'] = new Map();
  for (const file of await files(root, 'inbox/receipts')) {
    try {
      const receipt = JSON.parse(await readFile(await safeFile(root, file), 'utf8')) as ProcessingReceipt;
      if (!validateReceipt(receipt)) errors.push(file + ': invalid ProcessingReceipt');
      else {
        const version = receipt.requestId + '/v' + receipt.inputVersion;
        if (receipts.has(version)) errors.push(file + ': duplicate receipt version ' + version);
        else receipts.set(version, receipt);
      }
    } catch { errors.push(file + ': invalid receipt JSON'); }
  }
  for (const [version, receipt] of receipts) {
    const request = requests.get(version);
    if (!request) errors.push(version + ': inbox receipt has no saved request');
    else if (digest(canonical(request)) !== receipt.inputHash) errors.push(version + ': inbox receipt hash mismatch');
  }
  for (const domain of domains) {
    for (const file of await files(root, domain)) {
      let record: RecordData;
      try { record = JSON.parse(await readFile(await safeFile(root, file), 'utf8')); }
      catch { errors.push(file + ': invalid JSON'); continue; }
      hashes.push([file, digest(canonical(record))]);
      if (!validateRecord(record)) { errors.push(file + ': ' + ajv.errorsText(validateRecord.errors)); continue; }
      if (records.has(record.id)) errors.push('Duplicate record ID: ' + record.id);
      records.set(record.id, { path: file, record });
    }
  }
  for (const { path: file, record } of records.values()) {
    const refs = [...record.links];
    if (record.kind === 'finance_draft') {
      for (const key of ['accountId', 'counterpartyAccountId', 'originalTransactionId'] as const) {
        const ref = record[key]; if (ref) refs.push(ref);
      }
      for (const key of ['accountId', 'counterpartyAccountId'] as const) {
        const ref = record[key]; const account = ref ? records.get(ref)?.record : undefined;
        if (ref && account && (account.kind !== 'entity' || account.entityType !== 'account')) errors.push(file + ': account reference must point to an account entity');
      }
      if (record.originalTransactionId && records.has(record.originalTransactionId) && records.get(record.originalTransactionId)!.record.kind !== 'finance_draft') errors.push(file + ': refund reference must point to a financial draft');
      if (record.transactionType === 'transfer' && (!record.accountId || !record.counterpartyAccountId || record.accountId === record.counterpartyAccountId)) errors.push(file + ': transfer needs two different accounts');
      if (record.transactionType === 'refund' && !record.originalTransactionId) errors.push(file + ': refund needs originalTransactionId');
    }
    for (const id of refs) if (!records.has(id)) errors.push(file + ': missing reference ' + id);
    if ('bodyPath' in record && record.bodyPath) {
      try { const body = await readFile(await safeFile(root, record.bodyPath)); hashes.push([record.bodyPath, digest(body)]); if (!body.length) errors.push(file + ': empty readable body'); }
      catch { errors.push(file + ': missing or unsafe bodyPath'); }
    }
    if (record.kind === 'collection' && record.archiveStatus === 'readable_copy' && !record.bodyPath) errors.push(file + ': readable copy needs bodyPath');
    if (record.kind === 'attachment') {
      if (record.storage === 'remote_reference' && record.archiveStatus !== 'reference_only') errors.push(file + ': remote URL is only a reference');
      if (record.archiveStatus === 'saved') {
        try {
          if (record.storage !== 'local' || !record.path || !record.sha256 || record.size === undefined) throw new Error();
          const bytes = await readFile(await safeFile(root, record.path));
          hashes.push([record.path, digest(bytes)]);
          if (bytes.length !== record.size || digest(bytes) !== record.sha256) errors.push(file + ': attachment hash/size mismatch');
        } catch { errors.push(file + ': missing or unsafe saved attachment'); }
      }
    }
  }
  return { root, manifest, records, requests, receipts, snapshot: digest(canonical(hashes.sort(([a], [b]) => a.localeCompare(b, 'en')))), errors };
}
