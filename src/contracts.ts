import type { FromSchema } from 'json-schema-to-ts';

export const moneySchema = {
  type: 'object', additionalProperties: false,
  required: ['amountMinor', 'currency', 'precision'],
  properties: {
    amountMinor: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    currency: { type: 'string', pattern: '^[A-Z]{3}$' },
    precision: { type: 'integer', minimum: 0, maximum: 4 },
  },
} as const;
const recordId = { type: 'string', pattern: '^[a-z][a-z0-9_-]{2,100}$' } as const;
const common = {
  schemaVersion: { const: 1 }, id: recordId,
  revision: { type: 'integer', minimum: 1 },
  title: { type: 'string', minLength: 1, maxLength: 500 },
  createdAt: { type: 'string', format: 'date-time' },
  updatedAt: { type: 'string', format: 'date-time' },
  source: {
    type: 'object', additionalProperties: false, required: ['kind', 'reference'],
    properties: { kind: { enum: ['synthetic', 'manual', 'github', 'linear', 'chatgpt', 'dot'] }, reference: { type: 'string', minLength: 1 } },
  },
  links: { type: 'array', items: recordId, uniqueItems: true },
} as const;
const commonRequired = ['schemaVersion', 'id', 'revision', 'title', 'createdAt', 'updatedAt', 'source', 'links'] as const;
export const recordSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://focus-on.example/schemas/record-v1',
  oneOf: [
    { type: 'object', additionalProperties: false, required: [...commonRequired, 'kind', 'archiveStatus'], properties: { ...common, kind: { const: 'collection' }, archiveStatus: { enum: ['link_only', 'partial', 'readable_copy', 'needs_input'] }, url: { type: 'string', format: 'uri' }, bodyPath: { type: 'string' }, tags: { type: 'array', items: { type: 'string' }, uniqueItems: true } } },
    { type: 'object', additionalProperties: false, required: [...commonRequired, 'kind', 'bodyPath'], properties: { ...common, kind: { const: 'note' }, bodyPath: { type: 'string' } } },
    { type: 'object', additionalProperties: false, required: [...commonRequired, 'kind', 'status'], properties: { ...common, kind: { const: 'task' }, status: { enum: ['todo', 'in_progress', 'done', 'canceled'] } } },
    { type: 'object', additionalProperties: false, required: [...commonRequired, 'kind', 'status'], properties: { ...common, kind: { const: 'plan' }, status: { enum: ['proposed', 'scheduled', 'done', 'canceled'] } } },
    { type: 'object', additionalProperties: false, required: [...commonRequired, 'kind', 'status', 'budget'], properties: { ...common, kind: { const: 'wishlist' }, status: { enum: ['considering', 'purchased', 'dismissed'] }, budget: moneySchema } },
    { type: 'object', additionalProperties: false, required: [...commonRequired, 'kind', 'status', 'transactionType', 'money'], properties: { ...common, kind: { const: 'finance_draft' }, status: { const: 'pending' }, transactionType: { enum: ['expense', 'income', 'transfer', 'refund'] }, money: moneySchema, accountId: recordId, counterpartyAccountId: recordId, originalTransactionId: recordId } },
    { type: 'object', additionalProperties: false, required: [...commonRequired, 'kind', 'entityType'], properties: { ...common, kind: { const: 'entity' }, entityType: { enum: ['place', 'product', 'possession', 'account'] }, locationStatus: { enum: ['unconfirmed', 'confirmed'] }, coordinates: { type: 'object', additionalProperties: false, required: ['latitude', 'longitude', 'system', 'evidence'], properties: { latitude: { type: 'number', minimum: -90, maximum: 90 }, longitude: { type: 'number', minimum: -180, maximum: 180 }, system: { enum: ['WGS84', 'GCJ02'] }, evidence: { type: 'string', minLength: 1 } } } } },
    { type: 'object', additionalProperties: false, required: [...commonRequired, 'kind', 'money'], properties: { ...common, kind: { enum: ['budget', 'subscription'] }, money: moneySchema } },
    { type: 'object', additionalProperties: false, required: [...commonRequired, 'kind', 'storage', 'archiveStatus'], properties: { ...common, kind: { const: 'attachment' }, storage: { enum: ['local', 'remote_reference'] }, archiveStatus: { enum: ['saved', 'missing', 'reference_only'] }, path: { type: 'string' }, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' }, size: { type: 'integer', minimum: 0 }, url: { type: 'string', format: 'uri' } } },
  ],
} as const;
export const manifestSchema = {
  type: 'object', additionalProperties: false,
  required: ['schemaVersion', 'vaultId', 'validator', 'synthetic'],
  properties: {
    schemaVersion: { const: 1 }, vaultId: recordId, synthetic: { type: 'boolean' },
    validator: { type: 'object', additionalProperties: false, required: ['repository', 'commit'], properties: { repository: { const: 'Shuang-su/focus-on' }, commit: { type: 'string', pattern: '^[a-f0-9]{40}$' } } },
  },
} as const;
export const captureRequestSchema = {
  type: 'object', additionalProperties: false,
  required: ['schemaVersion', 'requestId', 'inputVersion', 'source', 'input', 'capturedAt', 'baseSnapshot', 'operations'],
  properties: {
    schemaVersion: { const: 1 }, requestId: recordId, inputVersion: { type: 'integer', minimum: 1 },
    source: common.source, capturedAt: { type: 'string', format: 'date-time' },
    input: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string', minLength: 1, maxLength: 100000 } } },
    baseSnapshot: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    operations: { type: 'array', minItems: 1, maxItems: 100, items: {
      type: 'object', additionalProperties: false, required: ['op', 'record'],
      properties: { op: { enum: ['create', 'update'] }, expectedRevision: { type: 'integer', minimum: 1 }, record: recordSchema },
    } },
  },
} as const;

export type RecordData = FromSchema<typeof recordSchema>;
export type VaultManifest = FromSchema<typeof manifestSchema>;
export type CaptureRequest = FromSchema<typeof captureRequestSchema>;
const hash = { type: 'string', pattern: '^[a-f0-9]{64}$' } as const;
const processingIdentity = { schemaVersion: { const: 1 }, requestId: recordId, inputVersion: { type: 'integer', minimum: 1 }, inputHash: hash } as const;
export const changeSetSchema = {
  type: 'object', additionalProperties: false, required: ['schemaVersion', 'requestId', 'inputVersion', 'inputHash', 'baseSnapshot', 'branch', 'changes'],
  properties: { ...processingIdentity, baseSnapshot: hash, branch: { type: 'string', pattern: '^capture/[a-z][a-z0-9_-]{2,100}/v[1-9][0-9]*$' }, changes: {
    type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['op', 'path', 'beforeHash', 'afterHash', 'record'],
      properties: { op: { enum: ['create', 'update'] }, path: { type: 'string', minLength: 1 }, beforeHash: { anyOf: [hash, { type: 'null' }] }, afterHash: hash, record: recordSchema } },
  } },
} as const;
export const processingReceiptSchema = {
  type: 'object', additionalProperties: false, required: ['schemaVersion', 'requestId', 'inputVersion', 'inputHash', 'status', 'recordIds', 'verification'],
  properties: { ...processingIdentity, status: { enum: ['planned', 'awaiting_merge', 'stored', 'needs_input', 'failed'] }, recordIds: { type: 'array', uniqueItems: true, items: recordId },
    verification: { type: 'object', additionalProperties: false, required: ['verified', 'snapshot'], properties: { verified: { type: 'boolean' }, snapshot: hash } },
    evidence: { type: 'object', additionalProperties: false, properties: { issueUrl: { type: 'string', format: 'uri' }, prUrl: { type: 'string', format: 'uri' }, commit: { type: 'string', pattern: '^[a-f0-9]{40}$' } } },
  },
  if: { properties: { status: { const: 'stored' } } },
  then: { required: ['evidence'], properties: { verification: { properties: { verified: { const: true } } }, evidence: { required: ['commit'] } } },
} as const;
export type ChangeSet = FromSchema<typeof changeSetSchema>;
export type ProcessingReceipt = FromSchema<typeof processingReceiptSchema>;

const queryRecordSchema = {
  type: 'object', additionalProperties: false,
  required: ['id', 'kind', 'path', 'title', 'revision', 'updatedAt', 'recordHash', 'text', 'source'],
  properties: {
    id: recordId,
    kind: { enum: ['collection', 'note', 'task', 'plan', 'wishlist', 'finance_draft', 'entity', 'budget', 'subscription', 'attachment'] },
    path: { type: 'string', minLength: 1, maxLength: 500 },
    title: { type: 'string', minLength: 1, maxLength: 500 },
    revision: { type: 'integer', minimum: 1 },
    updatedAt: { type: 'string', format: 'date-time' },
    recordHash: hash,
    text: { type: 'string', maxLength: 5 * 1024 * 1024 },
    source: common.source,
    status: { type: 'string', minLength: 1, maxLength: 100 },
    archiveStatus: { type: 'string', minLength: 1, maxLength: 100 },
    tags: { type: 'array', items: { type: 'string' }, uniqueItems: true },
    url: { type: 'string', format: 'uri' },
  },
} as const;
const inboxIndexSchema = {
  type: 'object', additionalProperties: false,
  required: ['requestId', 'inputVersion', 'inputHash', 'capturedAt', 'status', 'recordIds'],
  properties: {
    requestId: recordId,
    inputVersion: { type: 'integer', minimum: 1 },
    inputHash: hash,
    capturedAt: { type: 'string', format: 'date-time' },
    status: { enum: ['planned', 'awaiting_merge', 'stored', 'needs_input', 'failed', 'saved'] },
    recordIds: { type: 'array', uniqueItems: true, items: recordId },
    receiptHash: hash,
  },
} as const;
export const queryIndexSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://focus-on.example/schemas/query-index-v1',
  type: 'object', additionalProperties: false,
  required: ['schemaVersion', 'vaultId', 'sourceSnapshot', 'records', 'inbox'],
  properties: {
    schemaVersion: { const: 1 },
    vaultId: recordId,
    sourceSnapshot: hash,
    records: { type: 'array', items: queryRecordSchema },
    inbox: { type: 'array', items: inboxIndexSchema },
  },
} as const;
export const backupManifestSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://focus-on.example/schemas/backup-manifest-v1',
  type: 'object', additionalProperties: false,
  required: ['schemaVersion', 'vaultId', 'snapshot', 'head', 'refs', 'ledger'],
  properties: {
    schemaVersion: { const: 1 },
    vaultId: recordId,
    snapshot: hash,
    head: { type: 'string', pattern: '^[a-f0-9]{40}$' },
    ledger: { type: 'boolean' },
    refs: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['name', 'commit'],
      properties: {
        name: { type: 'string', pattern: '^refs/(heads|tags)/[A-Za-z0-9][A-Za-z0-9._/-]*$' },
        commit: { type: 'string', pattern: '^[a-f0-9]{40}$' },
      },
    } },
  },
} as const;
const locationLabel = { enum: ['unconfirmed', 'confirmed', 'unset'] } as const;
const coordinateValue = {
  type: 'object', additionalProperties: false,
  required: ['latitude', 'longitude', 'system', 'evidence'],
  properties: {
    latitude: { type: 'number', minimum: -90, maximum: 90 },
    longitude: { type: 'number', minimum: -180, maximum: 180 },
    system: { enum: ['WGS84', 'GCJ02'] },
    evidence: { type: 'string', minLength: 1, maxLength: 4000 },
  },
} as const;
const relativePath = { type: 'string', minLength: 1, maxLength: 500 } as const;
export const placeListSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://focus-on.example/schemas/place-list-v1',
  type: 'object', additionalProperties: false,
  required: ['schemaVersion', 'kind', 'vaultId', 'sourceSnapshot', 'places'],
  properties: {
    schemaVersion: { const: 1 }, kind: { const: 'placeList' }, vaultId: recordId, sourceSnapshot: hash,
    places: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      required: ['id', 'path', 'title', 'revision', 'updatedAt', 'locationStatus', 'links'],
      properties: {
        id: recordId, path: relativePath, title: { type: 'string', minLength: 1, maxLength: 500 },
        revision: { type: 'integer', minimum: 1 }, updatedAt: { type: 'string', format: 'date-time' },
        locationStatus: locationLabel, links: { type: 'array', items: recordId, uniqueItems: true },
        coordinates: coordinateValue,
      },
    } },
  },
} as const;
export const placeCandidateCatalogSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://focus-on.example/schemas/place-candidate-catalog-v1',
  type: 'object', additionalProperties: false,
  required: ['schemaVersion', 'synthetic', 'candidates'],
  properties: {
    schemaVersion: { const: 1 }, synthetic: { type: 'boolean' },
    candidates: { type: 'array', maxItems: 500, items: {
      type: 'object', additionalProperties: false,
      required: ['id', 'names', 'latitude', 'longitude', 'system', 'evidence', 'recordedAt'],
      properties: {
        id: recordId,
        names: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: { type: 'string', minLength: 2, maxLength: 200 } },
        latitude: { type: 'number', minimum: -90, maximum: 90 },
        longitude: { type: 'number', minimum: -180, maximum: 180 },
        system: { enum: ['WGS84', 'GCJ02'] },
        evidence: { type: 'string', minLength: 1, maxLength: 500 },
        recordedAt: { type: 'string', format: 'date-time' },
      },
    } },
  },
} as const;
export const placeMatchSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://focus-on.example/schemas/place-match-v1',
  type: 'object', additionalProperties: false,
  required: ['schemaVersion', 'kind', 'vaultId', 'sourceSnapshot', 'placeId', 'title', 'locationStatus', 'confirmed', 'proposalsOnly', 'geocoder', 'candidates'],
  properties: {
    schemaVersion: { const: 1 }, kind: { const: 'placeMatch' }, vaultId: recordId, sourceSnapshot: hash,
    placeId: recordId, title: { type: 'string', minLength: 1, maxLength: 500 }, locationStatus: locationLabel,
    confirmed: { const: false }, proposalsOnly: { const: true }, geocoder: { const: 'disabled' },
    query: { type: 'string', maxLength: 2000 },
    candidates: { type: 'array', maxItems: 100, items: {
      type: 'object', additionalProperties: false,
      required: ['id', 'source', 'title', 'score', 'matched', 'coordinates', 'recordedAt', 'synthetic', 'candidateHash'],
      properties: {
        id: recordId, source: { enum: ['vault', 'fixture'] }, sourceRecordId: recordId,
        title: { type: 'string', minLength: 1, maxLength: 500 },
        score: { type: 'integer', minimum: 1, maximum: 100 },
        matched: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 400 } },
        coordinates: coordinateValue, recordedAt: { type: 'string', format: 'date-time' },
        synthetic: { type: 'boolean' }, candidateHash: hash,
      },
    } },
  },
} as const;
const collectionRefSchema = {
  type: 'object', additionalProperties: false,
  required: ['id', 'path', 'title', 'archiveStatus', 'tags'],
  properties: {
    id: recordId, path: relativePath, title: { type: 'string', minLength: 1, maxLength: 500 },
    archiveStatus: { enum: ['link_only', 'partial', 'readable_copy', 'needs_input'] },
    tags: { type: 'array', items: { type: 'string' }, uniqueItems: true },
    url: { type: 'string', format: 'uri' },
  },
} as const;
const pointSchema = {
  type: 'object', additionalProperties: false,
  required: ['type', 'coordinates'],
  properties: {
    type: { const: 'Point' },
    coordinates: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' } },
  },
} as const;
export const collectionMapSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://focus-on.example/schemas/collection-map-v1',
  type: 'object', additionalProperties: false,
  required: ['schemaVersion', 'kind', 'vaultId', 'sourceSnapshot', 'view', 'features', 'unplacedPlaces', 'unplacedCollections', 'geojson'],
  properties: {
    schemaVersion: { const: 1 }, kind: { const: 'collectionMap' }, vaultId: recordId, sourceSnapshot: hash,
    view: { const: 'geojson-points' },
    features: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      required: ['id', 'path', 'title', 'locationStatus', 'system', 'longitude', 'latitude', 'evidence', 'collections'],
      properties: {
        id: recordId, path: relativePath, title: { type: 'string', minLength: 1, maxLength: 500 },
        locationStatus: locationLabel, system: { enum: ['WGS84', 'GCJ02'] },
        longitude: { type: 'number', minimum: -180, maximum: 180 }, latitude: { type: 'number', minimum: -90, maximum: 90 },
        evidence: { type: 'string', minLength: 1, maxLength: 4000 },
        collections: { type: 'array', items: collectionRefSchema },
      },
    } },
    unplacedPlaces: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['id', 'path', 'title', 'locationStatus'],
      properties: { id: recordId, path: relativePath, title: { type: 'string', minLength: 1, maxLength: 500 }, locationStatus: locationLabel },
    } },
    unplacedCollections: { type: 'array', items: collectionRefSchema },
    geojson: {
      type: 'object', additionalProperties: false, required: ['type', 'features'],
      properties: {
        type: { const: 'FeatureCollection' },
        features: { type: 'array', items: {
          type: 'object', additionalProperties: false, required: ['type', 'id', 'geometry', 'properties'],
          properties: {
            type: { const: 'Feature' }, id: recordId, geometry: pointSchema,
            properties: {
              type: 'object', additionalProperties: false,
              required: ['title', 'locationStatus', 'system', 'evidence', 'path', 'collections'],
              properties: {
                title: { type: 'string', minLength: 1, maxLength: 500 }, locationStatus: locationLabel,
                system: { enum: ['WGS84', 'GCJ02'] }, evidence: { type: 'string', minLength: 1, maxLength: 4000 },
                path: relativePath, collections: { type: 'array', items: recordId, uniqueItems: true },
              },
            },
          },
        } },
      },
    },
  },
} as const;
export const fragmentPackSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://focus-on.example/schemas/fragment-pack-v1',
  type: 'object', additionalProperties: false,
  required: ['schemaVersion', 'id', 'title', 'synthetic', 'fragments'],
  properties: {
    schemaVersion: { const: 1 }, id: recordId, title: { type: 'string', minLength: 1, maxLength: 500 }, synthetic: { type: 'boolean' },
    fragments: { type: 'array', maxItems: 200, items: {
      type: 'object', additionalProperties: false, required: ['id', 'recordId'],
      properties: {
        id: recordId, recordId, heading: { type: 'string', minLength: 1, maxLength: 500 },
      },
    } },
  },
} as const;
export const referencePackSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://focus-on.example/schemas/reference-pack-v1',
  type: 'object', additionalProperties: false,
  required: ['schemaVersion', 'kind', 'vaultId', 'sourceSnapshot', 'packId', 'title', 'synthetic', 'fragments'],
  properties: {
    schemaVersion: { const: 1 }, kind: { const: 'referencePack' }, vaultId: recordId, sourceSnapshot: hash,
    packId: recordId, title: { type: 'string', minLength: 1, maxLength: 500 }, synthetic: { type: 'boolean' },
    fragments: { type: 'array', maxItems: 300, items: {
      type: 'object', additionalProperties: false,
      required: ['id', 'recordId', 'kind', 'path', 'title', 'excerpt', 'tags', 'source', 'origin'],
      properties: {
        id: recordId, recordId, kind: { enum: ['collection', 'note'] }, path: relativePath,
        bodyPath: relativePath, title: { type: 'string', minLength: 1, maxLength: 500 },
        excerpt: { type: 'string', minLength: 1, maxLength: 8000 },
        tags: { type: 'array', items: { type: 'string' }, uniqueItems: true },
        source: common.source, origin: { enum: ['pack', 'tag'] },
        archiveStatus: { enum: ['link_only', 'partial', 'readable_copy', 'needs_input'] },
      },
    } },
  },
} as const;
export type QueryIndex = FromSchema<typeof queryIndexSchema>;
export type BackupManifest = FromSchema<typeof backupManifestSchema>;
export type PlaceList = FromSchema<typeof placeListSchema>;
export type PlaceCandidateCatalog = FromSchema<typeof placeCandidateCatalogSchema>;
export type PlaceMatch = FromSchema<typeof placeMatchSchema>;
export type CollectionMap = FromSchema<typeof collectionMapSchema>;
export type FragmentPack = FromSchema<typeof fragmentPackSchema>;
export type ReferencePack = FromSchema<typeof referencePackSchema>;
