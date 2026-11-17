import { lstat, readFile } from 'node:fs/promises';
import { captureGrant, placeConfirmGrant, assertPlaceConfirmAuthorized } from './authorization.js';
import type { CaptureRequest, CollectionMap, FragmentPack, PlaceCandidateCatalog, PlaceList, PlaceMatch, RecordData, ReferencePack } from './contracts.js';
import { normalizeText } from './query.js';
import { canonical, digest, readVault, safeFile, validateCollectionMap, validateFragmentPack, validatePlaceCatalog, validatePlaceList, validatePlaceMatch, validateReferencePack, type VaultSnapshot } from './vault.js';
import { captureChanges, type CaptureResult } from './writer.js';

const idPattern = /^[a-z][a-z0-9_-]{2,100}$/;
const splitter = /[\s,，.。:：;；、|/\\()（）[\]【】<>《》"'“”‘’!?！？]+/u;
type PlaceRecord = Extract<RecordData, { kind: 'entity' }> & { entityType: 'place' };
type CollectionRecord = Extract<RecordData, { kind: 'collection' }>;
interface Corpus { titleTokens: string[]; titleText: string; linkedText: string; queryText: string }

function isPlace(record: RecordData): record is PlaceRecord {
  return record.kind === 'entity' && record.entityType === 'place';
}
function isCollection(record: RecordData): record is CollectionRecord {
  return record.kind === 'collection';
}
function locationStatusOf(record: PlaceRecord): 'unconfirmed' | 'confirmed' | 'unset' {
  return record.locationStatus ?? 'unset';
}
function nameTokens(value: string): string[] {
  return [...new Set(normalizeText(value).split(splitter).filter(part => part.length >= 2))];
}
async function readJsonFile(file: string): Promise<unknown> {
  const stat = await lstat(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Context input must be a regular file');
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch { throw new Error('Invalid context JSON'); }
}
async function openVault(vaultPath: string): Promise<VaultSnapshot> {
  const vault = await readVault(vaultPath);
  if (vault.errors.length) throw new Error('Invalid vault: ' + vault.errors.join('; '));
  return vault;
}
function requirePlace(vault: VaultSnapshot, placeId: string): { path: string; record: PlaceRecord } {
  const found = vault.records.get(placeId);
  if (!found || !isPlace(found.record)) throw new Error('Record is not a place: ' + placeId);
  return { path: found.path, record: found.record };
}
async function loadBodies(vault: VaultSnapshot): Promise<Map<string, string>> {
  const bodies = new Map<string, string>();
  for (const { record } of vault.records.values()) {
    if (!('bodyPath' in record) || !record.bodyPath || bodies.has(record.bodyPath)) continue;
    bodies.set(record.bodyPath, (await readFile(await safeFile(vault.root, record.bodyPath))).toString('utf8'));
  }
  return bodies;
}
function optionalQuery(query: string | undefined): string | undefined {
  if (query === undefined) return undefined;
  if (query.length > 2000) throw new Error('Place query exceeds 2000 characters');
  return normalizeText(query) || undefined;
}
function linkedText(vault: VaultSnapshot, placeId: string, bodies: Map<string, string>): string {
  const related = new Set<string>();
  const place = vault.records.get(placeId)?.record;
  if (!place) return '';
  for (const id of place.links) related.add(id);
  for (const entry of vault.records.values()) {
    if (!entry.record.links.includes(placeId)) continue;
    related.add(entry.record.id);
    for (const id of entry.record.links) related.add(id);
  }
  related.delete(placeId);
  let text = '';
  for (const id of [...related].sort((a, b) => a.localeCompare(b, 'en'))) {
    const entry = vault.records.get(id);
    if (!entry) continue;
    const body = 'bodyPath' in entry.record && entry.record.bodyPath ? bodies.get(entry.record.bodyPath) : undefined;
    const chunk = normalizeText([entry.record.title, body].filter((part): part is string => !!part).join('\n'));
    if (!chunk || text.length >= 200000) continue;
    text = text ? text + '\n' + chunk : chunk;
    if (text.length > 200000) text = text.slice(0, 200000);
  }
  return text;
}
function scoreName(name: string, corpus: Corpus): { points: number; where: 'title' | 'linked' | 'query' } | undefined {
  const normalized = normalizeText(name);
  if (normalized.length < 2) return undefined;
  if (corpus.titleTokens.includes(normalized) || corpus.titleText === normalized) return { points: 70, where: 'title' };
  if (corpus.titleText.includes(normalized)) return { points: 60, where: 'title' };
  if (corpus.linkedText.includes(normalized)) return { points: 40, where: 'linked' };
  if (corpus.queryText.includes(normalized)) return { points: 30, where: 'query' };
  return undefined;
}
function scoreCandidate(names: readonly string[], corpus: Corpus, vaultBonus: number): { score: number; matched: string[] } | undefined {
  let best = 0;
  const matched: string[] = [];
  for (const name of names) {
    const found = scoreName(name, corpus);
    if (!found) continue;
    best = Math.max(best, found.points);
    const label = found.where + ':' + normalizeText(name);
    if (!matched.includes(label)) matched.push(label);
  }
  if (!best) return undefined;
  matched.sort((a, b) => a.localeCompare(b, 'en'));
  return { score: best + vaultBonus, matched };
}
function vaultCandidateId(recordId: string): string {
  const readable = 'vault_' + recordId;
  if (idPattern.test(readable)) return readable;
  return 'v_' + digest(recordId).slice(0, 24);
}
function hashCandidate(id: string, source: 'vault' | 'fixture', coordinates: PlaceMatch['candidates'][number]['coordinates'], recordedAt: string): string {
  return digest(canonical({ id, source, coordinates, recordedAt }));
}
async function readCatalog(file: string): Promise<PlaceCandidateCatalog> {
  const parsed = await readJsonFile(file);
  if (!validatePlaceCatalog(parsed)) throw new Error('Invalid place candidate catalog: ' + JSON.stringify(validatePlaceCatalog.errors));
  const catalog = parsed as PlaceCandidateCatalog;
  const ids = new Set<string>();
  for (const candidate of catalog.candidates) {
    if (ids.has(candidate.id)) throw new Error('Duplicate place candidate: ' + candidate.id);
    ids.add(candidate.id);
  }
  return catalog;
}

export async function listPlaces(vaultPath: string): Promise<PlaceList> {
  const vault = await openVault(vaultPath);
  const places: PlaceList['places'] = [];
  for (const entry of [...vault.records.values()].sort((a, b) => a.record.id.localeCompare(b.record.id, 'en'))) {
    if (!isPlace(entry.record)) continue;
    const item: PlaceList['places'][number] = {
      id: entry.record.id, path: entry.path, title: entry.record.title, revision: entry.record.revision,
      updatedAt: entry.record.updatedAt, locationStatus: locationStatusOf(entry.record), links: [...entry.record.links],
    };
    if (entry.record.coordinates) item.coordinates = { ...entry.record.coordinates };
    places.push(item);
  }
  const list: PlaceList = { schemaVersion: 1, kind: 'placeList', vaultId: vault.manifest.vaultId, sourceSnapshot: vault.snapshot, places };
  if (!validatePlaceList(list)) throw new Error('Invalid place list: ' + JSON.stringify(validatePlaceList.errors));
  return list;
}

export async function matchPlace(vaultPath: string, options: { placeId: string; query?: string; candidatesFile?: string }): Promise<PlaceMatch> {
  const vault = await openVault(vaultPath);
  const place = requirePlace(vault, options.placeId);
  const bodies = await loadBodies(vault);
  const query = optionalQuery(options.query);
  const corpus: Corpus = {
    titleTokens: nameTokens(place.record.title), titleText: normalizeText(place.record.title),
    linkedText: linkedText(vault, place.record.id, bodies), queryText: query ?? '',
  };
  const candidates: PlaceMatch['candidates'] = [];
  const seen = new Set<string>();
  for (const entry of vault.records.values()) {
    if (!isPlace(entry.record) || entry.record.id === place.record.id || !entry.record.coordinates) continue;
    const scored = scoreCandidate(nameTokens(entry.record.title), corpus, entry.record.locationStatus === 'confirmed' ? 20 : 10);
    if (!scored) continue;
    const id = vaultCandidateId(entry.record.id);
    if (seen.has(id)) throw new Error('Duplicate place candidate: ' + id);
    seen.add(id);
    const coordinates = { ...entry.record.coordinates };
    candidates.push({
      id, source: 'vault', sourceRecordId: entry.record.id, title: entry.record.title, score: scored.score, matched: scored.matched,
      coordinates, recordedAt: entry.record.updatedAt, synthetic: entry.record.source.kind === 'synthetic' || vault.manifest.synthetic,
      candidateHash: hashCandidate(id, 'vault', coordinates, entry.record.updatedAt),
    });
  }
  if (options.candidatesFile) {
    const catalog = await readCatalog(options.candidatesFile);
    for (const candidate of catalog.candidates) {
      const scored = scoreCandidate(candidate.names, corpus, 0);
      if (!scored) continue;
      if (seen.has(candidate.id)) throw new Error('Duplicate place candidate: ' + candidate.id);
      seen.add(candidate.id);
      const coordinates = { latitude: candidate.latitude, longitude: candidate.longitude, system: candidate.system, evidence: candidate.evidence };
      candidates.push({
        id: candidate.id, source: 'fixture', title: candidate.names[0] ?? candidate.id, score: scored.score, matched: scored.matched,
        coordinates, recordedAt: candidate.recordedAt, synthetic: catalog.synthetic,
        candidateHash: hashCandidate(candidate.id, 'fixture', coordinates, candidate.recordedAt),
      });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id, 'en'));
  if (candidates.length > 100) throw new Error('Place match exceeded 100 candidates');
  const match: PlaceMatch = {
    schemaVersion: 1, kind: 'placeMatch', vaultId: vault.manifest.vaultId, sourceSnapshot: vault.snapshot,
    placeId: place.record.id, title: place.record.title, locationStatus: locationStatusOf(place.record),
    confirmed: false, proposalsOnly: true, geocoder: 'disabled', candidates,
  };
  if (query) match.query = query;
  if (!validatePlaceMatch(match)) throw new Error('Invalid place match: ' + JSON.stringify(validatePlaceMatch.errors));
  return match;
}

function collectionIds(vault: VaultSnapshot, placeId: string): string[] {
  const ids = new Set<string>();
  const place = vault.records.get(placeId)?.record;
  if (!place) return [];
  for (const id of place.links) {
    const record = vault.records.get(id)?.record;
    if (record && isCollection(record)) ids.add(id);
  }
  for (const entry of vault.records.values()) {
    if (!entry.record.links.includes(placeId)) continue;
    if (isCollection(entry.record)) ids.add(entry.record.id);
    for (const id of entry.record.links) {
      const record = vault.records.get(id)?.record;
      if (record && isCollection(record)) ids.add(id);
    }
  }
  return [...ids].sort((a, b) => a.localeCompare(b, 'en'));
}
function collectionRef(path: string, record: CollectionRecord): CollectionMap['features'][number]['collections'][number] {
  const ref: CollectionMap['features'][number]['collections'][number] = {
    id: record.id, path, title: record.title, archiveStatus: record.archiveStatus, tags: [...(record.tags ?? [])],
  };
  if (record.url) ref.url = record.url;
  return ref;
}

export async function buildCollectionMap(vaultPath: string): Promise<CollectionMap> {
  const vault = await openVault(vaultPath);
  const features: CollectionMap['features'] = [];
  const placedCollections = new Set<string>();
  const unplacedPlaces: CollectionMap['unplacedPlaces'] = [];
  const placeEntries = [...vault.records.values()].filter(entry => isPlace(entry.record)).sort((a, b) => a.record.id.localeCompare(b.record.id, 'en'));
  for (const entry of placeEntries) {
    if (!isPlace(entry.record)) continue;
    if (!entry.record.coordinates) {
      unplacedPlaces.push({ id: entry.record.id, path: entry.path, title: entry.record.title, locationStatus: locationStatusOf(entry.record) });
      continue;
    }
    const coordinates = entry.record.coordinates;
    const collections = collectionIds(vault, entry.record.id).map(id => {
      const found = vault.records.get(id);
      if (!found || !isCollection(found.record)) throw new Error('Map collection was not a collection');
      placedCollections.add(id);
      return collectionRef(found.path, found.record);
    });
    features.push({
      id: entry.record.id, path: entry.path, title: entry.record.title, locationStatus: locationStatusOf(entry.record),
      system: coordinates.system, longitude: coordinates.longitude, latitude: coordinates.latitude, evidence: coordinates.evidence, collections,
    });
  }
  const unplacedCollections: CollectionMap['unplacedCollections'] = [];
  for (const entry of [...vault.records.values()].sort((a, b) => a.record.id.localeCompare(b.record.id, 'en'))) {
    if (!isCollection(entry.record) || placedCollections.has(entry.record.id)) continue;
    unplacedCollections.push(collectionRef(entry.path, entry.record));
  }
  const map: CollectionMap = {
    schemaVersion: 1, kind: 'collectionMap', vaultId: vault.manifest.vaultId, sourceSnapshot: vault.snapshot, view: 'geojson-points',
    features, unplacedPlaces, unplacedCollections,
    geojson: {
      type: 'FeatureCollection',
      features: features.map(feature => ({
        type: 'Feature' as const, id: feature.id,
        geometry: { type: 'Point' as const, coordinates: [feature.longitude, feature.latitude] },
        properties: {
          title: feature.title, locationStatus: feature.locationStatus, system: feature.system,
          evidence: feature.evidence, path: feature.path, collections: feature.collections.map(item => item.id),
        },
      })),
    },
  };
  if (!validateCollectionMap(map)) throw new Error('Invalid collection map: ' + JSON.stringify(validateCollectionMap.errors));
  return map;
}

function excerptFrom(body: string, heading: string | undefined, label: string): string {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const section: string[] = [];
  if (heading) {
    const target = normalizeText(heading);
    const index = lines.findIndex(line => normalizeText(line.replace(/^#{1,6}\s+/u, '')) === target);
    if (index < 0) throw new Error('Fragment heading not found: ' + label);
    section.push(lines[index] ?? '');
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (/^#{1,6}\s+/u.test(lines[cursor] ?? '')) break;
      section.push(lines[cursor] ?? '');
    }
  } else {
    for (const line of lines) {
      if (/^#{1,6}\s+/u.test(line)) continue;
      if (!line.trim()) { if (section.length) break; continue; }
      section.push(line);
    }
  }
  const excerpt = section.join('\n').trim();
  if (!excerpt) throw new Error('Fragment excerpt is empty: ' + label);
  if ([...excerpt].length > 8000) throw new Error('Fragment excerpt exceeds 8000 characters: ' + label);
  return excerpt;
}
function fragmentFromRecord(id: string, path: string, record: RecordData, bodies: Map<string, string>, origin: 'pack' | 'tag', heading?: string): ReferencePack['fragments'][number] {
  if (record.kind !== 'collection' && record.kind !== 'note') throw new Error('Fragment record must be a collection or note: ' + record.id);
  const body = record.bodyPath ? bodies.get(record.bodyPath) : undefined;
  if (heading && !body) throw new Error('Fragment heading not found: ' + id);
  const fragment: ReferencePack['fragments'][number] = {
    id, recordId: record.id, kind: record.kind, path, title: record.title,
    excerpt: body ? excerptFrom(body, heading, id) : record.title,
    tags: record.kind === 'collection' ? [...(record.tags ?? [])] : [],
    source: { kind: record.source.kind, reference: record.source.reference }, origin,
  };
  if (record.bodyPath) fragment.bodyPath = record.bodyPath;
  if (record.kind === 'collection') fragment.archiveStatus = record.archiveStatus;
  return fragment;
}
async function readPack(file: string): Promise<FragmentPack> {
  const parsed = await readJsonFile(file);
  if (!validateFragmentPack(parsed)) throw new Error('Invalid fragment pack: ' + JSON.stringify(validateFragmentPack.errors));
  const pack = parsed as FragmentPack;
  const ids = new Set<string>();
  for (const fragment of pack.fragments) {
    if (ids.has(fragment.id)) throw new Error('Duplicate fragment: ' + fragment.id);
    ids.add(fragment.id);
  }
  return pack;
}

export async function buildReferencePack(vaultPath: string, packFile?: string): Promise<ReferencePack> {
  const vault = await openVault(vaultPath);
  const bodies = await loadBodies(vault);
  const pack = packFile ? await readPack(packFile) : undefined;
  const fragments: ReferencePack['fragments'] = [];
  const seen = new Set<string>();
  if (pack) {
    for (const item of pack.fragments) {
      const entry = vault.records.get(item.recordId);
      if (!entry) throw new Error('Fragment record not in vault: ' + item.recordId);
      if (seen.has(item.id)) throw new Error('Duplicate fragment: ' + item.id);
      seen.add(item.id);
      fragments.push(fragmentFromRecord(item.id, entry.path, entry.record, bodies, 'pack', item.heading));
    }
  }
  for (const entry of vault.records.values()) {
    if (entry.record.kind !== 'collection' || !entry.record.tags?.includes('design')) continue;
    const id = 'tag_' + entry.record.id;
    if (!idPattern.test(id)) throw new Error('Unsafe fragment id: ' + id);
    if (seen.has(id)) throw new Error('Duplicate fragment: ' + id);
    seen.add(id);
    fragments.push(fragmentFromRecord(id, entry.path, entry.record, bodies, 'tag'));
  }
  fragments.sort((a, b) => a.id.localeCompare(b.id, 'en'));
  const view: ReferencePack = {
    schemaVersion: 1, kind: 'referencePack', vaultId: vault.manifest.vaultId, sourceSnapshot: vault.snapshot,
    packId: pack?.id ?? 'vault_tags', title: pack?.title ?? '设计标签', synthetic: vault.manifest.synthetic && (pack?.synthetic ?? true), fragments,
  };
  if (!validateReferencePack(view)) throw new Error('Invalid reference pack: ' + JSON.stringify(validateReferencePack.errors));
  return view;
}

export async function confirmPlace(input: {
  vault: string;
  placeId: string;
  candidateId: string;
  grants: readonly string[];
  query?: string;
  candidatesFile?: string;
}): Promise<CaptureResult & { match: PlaceMatch }> {
  assertPlaceConfirmAuthorized(input.grants);
  const match = await matchPlace(input.vault, { placeId: input.placeId, query: input.query, candidatesFile: input.candidatesFile });
  const candidate = match.candidates.find(item => item.id === input.candidateId);
  if (!candidate) throw new Error('Unknown place candidate: ' + input.candidateId);
  const vault = await openVault(input.vault);
  const place = requirePlace(vault, input.placeId);
  const coordinates = {
    latitude: candidate.coordinates.latitude, longitude: candidate.coordinates.longitude,
    system: candidate.coordinates.system, evidence: `candidate:${candidate.id}; source:${candidate.source}; ${candidate.coordinates.evidence}`,
  };
  const requestId = 'pc_' + digest(canonical({ vaultId: vault.manifest.vaultId, placeId: place.record.id, candidateId: candidate.id, coordinates })).slice(0, 24);
  const saved = vault.requests.get(requestId + '/v1');
  if (saved) {
    const savedRecord = saved.operations.length === 1 ? saved.operations[0]?.record : undefined;
    if (!savedRecord || savedRecord.id !== place.record.id || savedRecord.kind !== 'entity' || savedRecord.locationStatus !== 'confirmed' || canonical(savedRecord.coordinates ?? null) !== canonical(coordinates)) {
      throw new Error('Conflict: saved place confirmation does not match this candidate');
    }
    const stored = await captureChanges({ request: saved, vault: input.vault, grants: [captureGrant, placeConfirmGrant], placeConfirmation: true });
    return { ...stored, match };
  }
  const record: PlaceRecord = {
    ...place.record, revision: place.record.revision + 1,
    updatedAt: candidate.recordedAt > place.record.updatedAt ? candidate.recordedAt : place.record.updatedAt,
    locationStatus: 'confirmed', coordinates,
  };
  const request: CaptureRequest = {
    schemaVersion: 1, requestId, inputVersion: 1, source: { kind: 'manual', reference: 'place-confirm:' + candidate.id },
    input: { text: `确认地点 ${place.record.id} 使用候选 ${candidate.id}。此文本只作为记录，不作为命令。` },
    capturedAt: candidate.recordedAt, baseSnapshot: vault.snapshot,
    operations: [{ op: 'update', expectedRevision: place.record.revision, record }],
  };
  const stored = await captureChanges({ request, vault: input.vault, grants: [captureGrant, placeConfirmGrant], placeConfirmation: true });
  return { ...stored, match };
}
