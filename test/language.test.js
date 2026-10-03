import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Import config/client only after isolating this test process from real credentials/state.
const temporary = await mkdtemp(join(tmpdir(), 'webcore-language-'));
process.env.XDG_CONFIG_HOME = temporary;
const { WebcoreClient } = await import('../server/client.js');
const { configDir } = await import('../server/config.js');
after(() => rm(temporary, { recursive: true, force: true }));

let instance = 0;
function fixture() {
  const f = {
    config: { baseUrl: `http://hub.fixture.invalid/apps/api/${++instance}`, accessToken: 'fixture-access-secret', securityToken: 'fixture-session-secret' },
    dashboard: { instance: { coreVersion: 'v0.3.114.20220203', heVersion: 'v0.3.114.20240115_HE' } },
    language: { dbVersion: 'v0.3.114.20240115_HE', now: 1, db: {
      commands: { physical: { on: { n: 'on', p: [] } } },
      attributes: { switch: { t: 'string', options: ['off', 'on'] } },
      functions: { fixtureFunction: { n: 'fixture-only-definition', p: [] } }
    } }, calls: []
  };
  f.fetch = async input => {
    const path = new URL(input).pathname;
    f.calls.push(path);
    if (path.endsWith('/piston/getDb')) {
      if (f.failLanguage) throw new Error('Fixture language request failed.');
      return new Response(JSON.stringify(f.language), { headers: { 'content-type': 'application/json' } });
    }
    if (path.endsWith('/dashboard/load')) {
      if (f.failVersions) throw new Error('Fixture dashboard request failed.');
      return new Response(JSON.stringify(f.dashboard), { headers: { 'content-type': 'application/json' } });
    }
    throw new Error('Unexpected fixture endpoint.');
  };
  f.client = new WebcoreClient(f.config, f.fetch);
  f.statePath = join(configDir, 'language-state', `${createHash('sha256').update(f.config.baseUrl).digest('hex')}.json`);
  return f;
}

test('first language observation establishes a private baseline without certifying compatibility', async () => {
  const f = fixture();
  const result = await f.client.getLanguageDb();
  const report = result.language_compatibility;
  assert.equal(report.observation_status, 'first_observation');
  assert.equal(report.changed_since_previous_check, null);
  assert.equal(report.reference_version_match, true);
  assert.equal(report.compatibility_verified, false);
  assert.equal(report.reference_status, 'unverified');
  assert.equal(result.condition_reference.compatibility_verified, false);
  assert.equal(report.tracking.saved, true);
  assert.match(report.live.language_hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(f.calls.sort(), [
    `${new URL(f.config.baseUrl).pathname}/intf/dashboard/load`,
    `${new URL(f.config.baseUrl).pathname}/intf/dashboard/piston/getDb`
  ]);
  const state = await readFile(f.statePath, 'utf8');
  for (const marker of [f.config.baseUrl, f.config.accessToken, f.config.securityToken, 'fixture-only-definition']) {
    assert.equal(state.includes(marker), false);
    assert.equal(JSON.stringify(report).includes(marker), false);
  }
  if (process.platform !== 'win32') {
    assert.equal((await stat(configDir)).mode & 0o777, 0o700);
    assert.equal((await stat(join(configDir, 'language-state'))).mode & 0o777, 0o700);
    assert.equal((await stat(f.statePath)).mode & 0o777, 0o600);
  }
});

test('language hash excludes response metadata and object key ordering', async () => {
  const f = fixture();
  const first = await f.client.getLanguageDb();
  const reverseKeys = value => Array.isArray(value) ? value.map(reverseKeys)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([key, nested]) => [key, reverseKeys(nested)])) : value;
  f.language = { ...f.language, now: 999, responseMetadata: { changed: true }, db: reverseKeys(f.language.db) };
  const next = await f.client.getLanguageDb();
  assert.equal(next.language_compatibility.live.language_hash, first.language_compatibility.live.language_hash);
  assert.equal(next.language_compatibility.observation_status, 'unchanged');
  assert.equal(next.language_compatibility.reference_requires_review, false);
  assert.equal(next.language_compatibility.compatibility_verified, false);
});

test('changed definitions with identical HE labels retain review warnings across later clients', async () => {
  const f = fixture();
  const first = await f.client.getLanguageDb();
  f.language.db.functions.newFunction = { n: 'new function' };
  const changed = await f.client.getLanguageDb();
  const report = changed.language_compatibility;
  assert.equal(report.live.webcore_he_version, first.language_compatibility.live.webcore_he_version);
  assert.deepEqual(report.changed_fields, ['language_hash']);
  assert.equal(report.changed_since_previous_check, true);
  assert.equal(report.reference_version_match, true);
  assert.equal(report.reference_requires_review, true);
  assert.ok(report.review_reasons.includes('LANGUAGE_CHANGED'));
  assert.equal(changed.condition_reference.reference_status, 'review_required');
  const restarted = new WebcoreClient({ ...f.config, accessToken: 'rotated-fixture-token' }, f.fetch);
  const later = (await restarted.getLanguageDb()).language_compatibility;
  assert.equal(later.observation_status, 'unchanged');
  assert.equal(later.changed_since_previous_check, false);
  assert.equal(later.reference_requires_review, true);
  assert.deepEqual(later.last_detected_change, report.last_detected_change);
  assert.deepEqual(JSON.parse(await readFile(f.statePath, 'utf8')).review_reasons, ['LANGUAGE_CHANGED']);
});

test('core, HE and DB version changes are detected independently of the language hash', async () => {
  const f = fixture();
  const first = await f.client.getLanguageDb();
  f.dashboard.instance.coreVersion = 'v0.3.115.20261002';
  f.dashboard.instance.heVersion = 'v0.3.115.20261002_HE';
  f.language.dbVersion = f.dashboard.instance.heVersion;
  const report = (await f.client.getLanguageDb()).language_compatibility;
  assert.deepEqual(report.changed_fields, ['webcore_version', 'webcore_he_version', 'db_version']);
  assert.equal(report.live.language_hash, first.language_compatibility.live.language_hash);
  assert.equal(report.reference_version_match, false);
  assert.ok(report.review_reasons.includes('REFERENCE_VERSION_MISMATCH'));
});

test('DB and HE version disagreement requires reference review', async () => {
  const f = fixture();
  f.language.dbVersion = 'v0.3.114.20261002_HE';
  const report = (await f.client.getLanguageDb()).language_compatibility;
  assert.equal(report.reference_requires_review, true);
  assert.ok(report.review_reasons.includes('DB_HE_VERSION_MISMATCH'));
});

test('failed version checks preserve the live DB and last known versions for the next comparison', async () => {
  const f = fixture();
  await f.client.getLanguageDb();
  f.failVersions = true;
  const result = await f.client.getLanguageDb();
  const report = result.language_compatibility;
  assert.deepEqual(result.db, f.language.db);
  assert.equal(report.live.webcore_version, null);
  assert.equal(report.live.webcore_he_version, null);
  assert.equal(report.version_check_error, 'NETWORK_ERROR');
  assert.equal(report.reference_version_match, null);
  assert.ok(report.review_reasons.includes('VERSION_UNAVAILABLE'));
  assert.equal(report.previous_known.webcore_version, 'v0.3.114.20220203');
  f.failVersions = false;
  f.dashboard.instance.coreVersion = 'v0.3.115.20261002';
  const recovered = (await f.client.getLanguageDb()).language_compatibility;
  assert.deepEqual(recovered.changed_fields, ['webcore_version']);
});

test('missing version fields never substitute the pinned reference values', async () => {
  const f = fixture();
  f.dashboard = { instance: {} };
  delete f.language.dbVersion;
  const report = (await f.client.getLanguageDb()).language_compatibility;
  assert.equal(report.live.webcore_version, null);
  assert.equal(report.live.webcore_he_version, null);
  assert.equal(report.live.db_version, null);
  assert.equal(report.reference_version_match, null);
  assert.equal(report.reference_requires_review, true);
  assert.deepEqual(report.review_reasons, ['VERSION_UNAVAILABLE']);
});

test('corrupt local tracking is reported without overwriting the baseline or exposing file contents', async () => {
  const f = fixture();
  await f.client.getLanguageDb();
  const corrupt = '{"private":"fixture-corrupt-file-secret"';
  await writeFile(f.statePath, corrupt);
  const result = await f.client.getLanguageDb();
  assert.deepEqual(result.db, f.language.db);
  assert.equal(result.language_compatibility.observation_status, 'tracking_unavailable');
  assert.equal(result.language_compatibility.tracking.saved, false);
  assert.equal(result.language_compatibility.tracking.error_code, 'LANGUAGE_TRACKING_INVALID');
  assert.equal(result.language_compatibility.changed_since_previous_check, null);
  assert.equal(JSON.stringify(result).includes('fixture-corrupt-file-secret'), false);
  assert.equal(await readFile(f.statePath, 'utf8'), corrupt);
});

test('unknown tracking fields cannot leak into reports or rewritten state', async () => {
  const f = fixture();
  await f.client.getLanguageDb();
  const state = JSON.parse(await readFile(f.statePath, 'utf8'));
  state.accessToken = 'fixture-injected-file-secret';
  state.last_known.private = 'fixture-injected-file-secret';
  await writeFile(f.statePath, JSON.stringify(state));
  const result = await f.client.getLanguageDb();
  assert.equal(result.language_compatibility.observation_status, 'unchanged');
  assert.equal(JSON.stringify(result).includes('fixture-injected-file-secret'), false);
  assert.equal((await readFile(f.statePath, 'utf8')).includes('fixture-injected-file-secret'), false);
});

test('busy tracking leaves fresh definitions usable and preserves the baseline until a successful retry', async () => {
  const f = fixture();
  await f.client.getLanguageDb();
  const original = await readFile(f.statePath, 'utf8');
  const lock = `${f.statePath}.lock`;
  await writeFile(lock, '');
  f.language.db.functions.newFunction = { n: 'fresh while locked' };
  try {
    const result = await f.client.getLanguageDb();
    assert.deepEqual(result.db, f.language.db);
    assert.equal(result.language_compatibility.tracking.error_code, 'LANGUAGE_TRACKING_BUSY');
    assert.equal(result.language_compatibility.observation_status, 'tracking_unavailable');
    assert.equal(result.language_compatibility.tracking.saved, false);
    assert.equal(await readFile(f.statePath, 'utf8'), original);
  } finally { await unlink(lock); }
  const retry = (await f.client.getLanguageDb()).language_compatibility;
  assert.deepEqual(retry.changed_fields, ['language_hash']);
  assert.equal(retry.reference_requires_review, true);
});

test('invalid or failed language retrieval never falls back to earlier definitions', async () => {
  const f = fixture();
  await f.client.getLanguageDb();
  const original = await readFile(f.statePath, 'utf8');
  for (const value of [null, {}, { db: {} }, { db: [] }, { db: 'invalid' }]) {
    f.language = value;
    await assert.rejects(f.client.getLanguageDb(), error => error.code === 'LANGUAGE_DB_UNAVAILABLE');
  }
  f.failLanguage = true;
  await assert.rejects(f.client.getLanguageDb(), error => error.code === 'NETWORK_ERROR');
  assert.equal(await readFile(f.statePath, 'utf8'), original);
});

test('concurrent language observations serialize baseline creation and leave no temporary files', async () => {
  const f = fixture();
  const clients = Array.from({ length: 3 }, () => new WebcoreClient(f.config, f.fetch));
  const results = await Promise.all(clients.map(client => client.getLanguageDb()));
  assert.equal(results.filter(result => result.language_compatibility.observation_status === 'first_observation').length, 1);
  assert.equal(results.filter(result => result.language_compatibility.observation_status === 'unchanged').length, 2);
  assert.ok(results.every(result => result.language_compatibility.tracking.saved));
  const names = await readdir(join(configDir, 'language-state'));
  assert.equal(names.some(name => name.endsWith('.lock') || name.endsWith('.tmp')), false);
});
