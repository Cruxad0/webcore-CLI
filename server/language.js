import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configDir } from './config.js';
import conditionReference from './schema-reference.json' with { type: 'json' };

const fields = ['webcore_version', 'webcore_he_version', 'db_version', 'language_hash'];
const persistentReasons = ['LANGUAGE_CHANGED', 'REFERENCE_VERSION_MISMATCH', 'DB_HE_VERSION_MISMATCH'];
const queues = new Map();
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const version = value => typeof value === 'string' && /^v?\d+(?:\.\d+)+(?:_[A-Za-z0-9]+)?$/.test(value) && value.length <= 80 ? value : null;
const dbVersion = value => version(value) ?? (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : typeof value === 'string' && /^\d{1,16}$/.test(value) ? value : null);
const digest = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const sameVersion = (a, b) => a.replace(/^v/, '') === b.replace(/^v/, '');
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function isLanguageDb(response) {
  return object(response) && object(response.db) && Object.keys(response.db).length > 0;
}

function validObservation(value) {
  return object(value) && fields.every(field => Object.hasOwn(value, field)) && hash(value.language_hash)
    && ['webcore_version', 'webcore_he_version'].every(field => value[field] === null || version(value[field]) !== null)
    && (value.db_version === null || typeof value.db_version === 'string' && dbVersion(value.db_version) !== null);
}

// Select only known fields from local state; never echo arbitrary file contents in tools.
const observation = value => Object.fromEntries(fields.map(field => [field, value[field]]));
function readState(value) {
  if (!object(value) || value.schema !== 1 || !/^[a-f0-9]{40}$/.test(value.reference_source_revision ?? '')
    || !timestamp(value.first_checked_at) || !timestamp(value.last_checked_at) || !validObservation(value.last_known)
    || !Array.isArray(value.review_reasons) || value.review_reasons.some(reason => !persistentReasons.includes(reason))) return null;
  let change = null;
  if (value.last_detected_change !== null) {
    const raw = value.last_detected_change;
    if (!object(raw) || !timestamp(raw.detected_at) || !validObservation(raw.previous) || !validObservation(raw.current)
      || !Array.isArray(raw.changed_fields) || !raw.changed_fields.length || raw.changed_fields.some(field => !fields.includes(field))) return null;
    change = { detected_at: raw.detected_at, changed_fields: [...raw.changed_fields], previous: observation(raw.previous), current: observation(raw.current) };
  }
  return { schema: 1, reference_source_revision: value.reference_source_revision,
    first_checked_at: value.first_checked_at, last_checked_at: value.last_checked_at,
    last_known: observation(value.last_known), review_reasons: [...value.review_reasons], last_detected_change: change };
}

function buildReport(current, checkedAt, previous, tracking, versionCheckError) {
  const known = previous?.last_known ?? null;
  // Missing version fields are unavailable evidence, not evidence of a downgrade/change.
  const changedFields = known ? fields.filter(field => current[field] !== null && known[field] !== null && current[field] !== known[field]) : [];
  const reference = conditionReference.reference_versions;
  const mismatch = ['webcore_version', 'webcore_he_version'].some(field => current[field] !== null && !sameVersion(current[field], reference[field]));
  const versionsAvailable = current.webcore_version !== null && current.webcore_he_version !== null;
  const dbMismatch = current.db_version !== null && current.webcore_he_version !== null && !sameVersion(current.db_version, current.webcore_he_version);
  const sameReference = previous?.reference_source_revision === conditionReference.source_revision;
  const pending = new Set(sameReference ? previous.review_reasons : []);
  if (changedFields.length) pending.add('LANGUAGE_CHANGED');
  if (mismatch) pending.add('REFERENCE_VERSION_MISMATCH');
  if (dbMismatch) pending.add('DB_HE_VERSION_MISMATCH');
  const reasons = new Set(pending);
  if (!versionsAvailable || current.db_version === null || versionCheckError) reasons.add('VERSION_UNAVAILABLE');
  if (!tracking.saved) reasons.add('TRACKING_UNAVAILABLE');
  const lastChange = changedFields.length ? { detected_at: checkedAt, changed_fields: changedFields, previous: known, current }
    : sameReference ? previous.last_detected_change : null;
  const report = {
    checked_at: checkedAt, source: 'live_hub', live: current,
    language_hash_scope: 'canonical JSON of db only; excludes response timestamps and metadata',
    observation_status: !tracking.saved ? 'tracking_unavailable' : !known ? 'first_observation' : changedFields.length ? 'changed' : 'unchanged',
    changed_since_previous_check: known ? changedFields.length > 0 : null,
    changed_fields: changedFields, previous_known: known, previous_checked_at: previous?.last_checked_at ?? null, last_detected_change: lastChange,
    reference_versions: { webcore_version: reference.webcore_version, webcore_he_version: reference.webcore_he_version, displayed_date: reference.displayed_date },
    reference_source_revision: conditionReference.source_revision,
    reference_version_match: mismatch ? false : versionsAvailable ? true : null,
    compatibility_verified: false,
    reference_status: reasons.size ? 'review_required' : 'unverified',
    reference_requires_review: reasons.size > 0, review_reasons: [...reasons],
    version_check_error: versionCheckError ?? null, tracking,
    instructions: [
      'Language definitions were fetched from the connected hub for this operation; use the returned live DB.',
      'A first observation establishes a local comparison baseline. Matching labels or unchanged hashes do not certify the bundled condition format.',
      'If reference_requires_review is true, tell the user which evidence changed/is unavailable, read the intended live piston, and inspect its native conditions and the current comparison/operand definitions before preparing a change.',
      'Pending change warnings remain across subsequent checks for this pinned reference. An unchanged observation does not clear them.',
      'The plugin does not rewrite the pinned guide or install updates automatically. Keep normal validation, review, stale-hash and read-back safeguards.'
    ]
  };
  const lastKnown = Object.fromEntries(fields.map(field => [field, current[field] ?? known?.[field] ?? null]));
  const state = { schema: 1, reference_source_revision: conditionReference.source_revision,
    first_checked_at: previous?.first_checked_at ?? checkedAt, last_checked_at: checkedAt,
    last_known: lastKnown, review_reasons: [...pending], last_detected_change: lastChange };
  return { report, state };
}

async function withLock(path, operation) {
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + 2000;
  let lock;
  while (!lock) {
    try { lock = await open(lockPath, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw Object.assign(new Error('Language tracking is busy.'), { code: 'LANGUAGE_TRACKING_BUSY' });
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  try { return await operation(); }
  finally {
    await lock.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
  }
}

async function observe(config, current, checkedAt, versionCheckError) {
  let previous = null;
  try {
    const base = new URL(config.baseUrl);
    // Connection identity excludes access/session tokens and all query/fragment values.
    const connection = `${base.origin}${base.pathname.replace(/\/$/, '')}`;
    const directory = join(configDir, 'language-state');
    const path = join(directory, `${digest(connection)}.json`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(configDir, 0o700);
    await chmod(directory, 0o700);
    return await withLock(path, async () => {
      try {
        previous = readState(JSON.parse(await readFile(path, 'utf8')));
        if (!previous) throw Object.assign(new Error('Invalid language tracking state.'), { code: 'LANGUAGE_TRACKING_INVALID' });
      } catch (error) {
        if (error.code !== 'ENOENT') throw Object.assign(new Error('Language tracking state could not be read.'), { code: error.code === 'LANGUAGE_TRACKING_INVALID' || error instanceof SyntaxError ? 'LANGUAGE_TRACKING_INVALID' : 'LANGUAGE_TRACKING_IO' });
      }
      const { report, state } = buildReport(current, checkedAt, previous,
        { saved: true, storage: 'local_user_config', error_code: null, contains_credentials: false }, versionCheckError);
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
        await rename(temporary, path);
      } finally { await unlink(temporary).catch(() => {}); }
      return report;
    });
  } catch (error) {
    const code = ['LANGUAGE_TRACKING_BUSY', 'LANGUAGE_TRACKING_INVALID'].includes(error.code) ? error.code : 'LANGUAGE_TRACKING_IO';
    return buildReport(current, checkedAt, previous,
      { saved: false, storage: 'local_user_config', error_code: code, contains_credentials: false }, versionCheckError).report;
  }
}

export async function observeLanguage(config, dashboard, response, versionCheckError = null) {
  const current = {
    webcore_version: version(dashboard?.instance?.coreVersion),
    webcore_he_version: version(dashboard?.instance?.heVersion),
    db_version: dbVersion(response.dbVersion), language_hash: digest(JSON.stringify(canonical(response.db)))
  };
  const checkedAt = new Date().toISOString();
  const key = digest(String(config.baseUrl));
  const pending = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(() => observe(config, current, checkedAt, versionCheckError));
  queues.set(key, pending);
  try { return await pending; }
  finally { if (queues.get(key) === pending) queues.delete(key); }
}

export function languageConditionReference(report) {
  return { ...conditionReference, reference_status: report.reference_status,
    reference_requires_review: report.reference_requires_review, compatibility_verified: false,
    compatibility_report: 'language_compatibility' };
}
