import test from 'node:test';
import assert from 'node:assert/strict';
import { WebcoreError } from '../server/client.js';
import { hashJson, pistonBodyFingerprint, PISTON_BODY_FINGERPRINT_VERSION } from '../server/piston.js';
import { assertPreparedBodyHash, assertPreparedDraftHash, READBACK_RETRY_DELAYS_MS, verifyPistonUpdate } from '../server/verification.js';

const id = ':fixture-piston:';
const name = 'Fixture lamp piston';
const draft = () => ({
  s: [{ t: 'action', d: [':fixture-lamp:'], k: [{ c: 'off', p: [] }] }],
  v: [{ n: 'privateFixtureVariable', t: 'string', v: { t: 'c', vt: 'string', c: 'fixture-secret-variable' } }],
  z: 'fixture-private-comment'
});
const bodyHash = body => hashJson(pistonBodyFingerprint(body));
const selection = body => ({ id, expected_name: name, expected_body_hash: bodyHash(body) });
const live = (body, meta = {}) => ({ data: { meta: { id, name, build: 28, active: true, ...meta }, piston: structuredClone(body) } });

function readOnlyFixture(responses) {
  let reads = 0;
  const waits = [];
  const writes = [];
  const client = {
    async getPiston(requestedId) {
      assert.equal(requestedId, id);
      const response = responses[Math.min(reads++, responses.length - 1)];
      if (response instanceof Error) throw response;
      return structuredClone(response);
    },
    async savePiston() { writes.push('save'); throw new Error('Read-only verification attempted a save'); },
    async createPiston() { writes.push('create'); throw new Error('Read-only verification attempted creation'); },
    async testPiston() { writes.push('test'); throw new Error('Read-only verification attempted live device testing'); },
    async pausePiston() { writes.push('pause'); throw new Error('Read-only verification attempted pause'); },
    async resumePiston() { writes.push('resume'); throw new Error('Read-only verification attempted resume'); },
    async request() { writes.push('request'); throw new Error('Read-only verification attempted another endpoint'); }
  };
  return { client, reads: () => reads, writes, waits, options: { waitForRetry: async delay => { waits.push(delay); } } };
}

test('stored-definition verification retries a stale first read without writing or testing devices', async () => {
  const body = draft();
  const stale = structuredClone(body);
  stale.s[0].k[0].c = 'on';
  const fixture = readOnlyFixture([live(stale, { build: 27 }), live(body)]);
  const result = await verifyPistonUpdate(fixture.client, selection(body), { ...fixture.options, expectedBody: body });
  assert.equal(result.verified, true);
  assert.equal(result.persistence_verified, true);
  assert.equal(result.device_execution_verified, false);
  assert.equal(result.verification.scope, 'stored_definition');
  assert.equal(result.verification.expected_body_hash, bodyHash(body));
  assert.equal(result.verification.stored_body_hash, bodyHash(body));
  assert.equal(result.verification.body_fingerprint_version, PISTON_BODY_FINGERPRINT_VERSION);
  assert.equal(result.verification.build, 28);
  assert.equal(result.verification.active, true);
  assert.equal(result.verification.readback_attempt_count, 2);
  assert.deepEqual(result.verification.readback_attempts.map(attempt => attempt.code), ['PISTON_READBACK_MISMATCH', 'MATCH']);
  assert.deepEqual(fixture.waits, [250]);
  assert.deepEqual(fixture.writes, []);
});

test('a transient read failure is retried and its sensitive error message is omitted', async () => {
  const body = draft();
  const fixture = readOnlyFixture([new WebcoreError('http://hub.local/?access_token=fixture-secret-token', 'NETWORK_ERROR'), live(body)]);
  const result = await verifyPistonUpdate(fixture.client, selection(body), fixture.options);
  assert.equal(result.verified, true);
  assert.equal(fixture.reads(), 2);
  assert.equal(result.verification.readback_attempts[0].cause_code, 'NETWORK_ERROR');
  assert.equal(JSON.stringify(result).includes('fixture-secret-token'), false);
  assert.deepEqual(fixture.writes, []);
});

test('temporarily missing or invalid stored bodies can recover on a bounded read-only retry', async () => {
  const body = draft();
  for (const broken of [{ data: { meta: { id, name } } }, live({ s: null }), live({ statements: [] })]) {
    const fixture = readOnlyFixture([broken, live(body)]);
    const result = await verifyPistonUpdate(fixture.client, selection(body), fixture.options);
    assert.equal(result.verified, true);
    assert.equal(fixture.reads(), 2);
    assert.equal(result.verification.readback_attempts[0].code, 'PISTON_READBACK_INVALID');
    assert.deepEqual(fixture.writes, []);
  }
});

test('the third and final read may verify after two stale reads', async () => {
  const body = draft();
  const fixture = readOnlyFixture([live({ s: [] }), live({ s: [] }), live(body)]);
  const result = await verifyPistonUpdate(fixture.client, selection(body), fixture.options);
  assert.equal(result.verification.readback_attempt_count, 3);
  assert.equal(fixture.reads(), 3);
  assert.deepEqual(READBACK_RETRY_DELAYS_MS, [0, 250, 750]);
  assert.deepEqual(fixture.waits, [250, 750]);
  assert.deepEqual(fixture.writes, []);
});

test('persistent mismatches include differing paths and hashes without literal or variable values', async () => {
  const body = draft();
  const stored = structuredClone(body);
  stored.s[0].k[0].c = 'fixture-private-command';
  stored.v[0].v.c = 'fixture-secret-stored-variable';
  stored.s[0]['fixture-secret-key'] = 'fixture-secret-extra-value';
  const fixture = readOnlyFixture([live(stored)]);
  await assert.rejects(verifyPistonUpdate(fixture.client, selection(body), { ...fixture.options, expectedBody: body }), error => {
    assert.equal(error.code, 'PISTON_READBACK_MISMATCH');
    assert.equal(error.details.verified, false);
    assert.equal(error.details.persistence_verified, false);
    assert.equal(error.details.device_execution_verified, false);
    assert.equal(error.details.stored_definition_unknown, false);
    assert.equal(error.details.expected_body_hash, bodyHash(body));
    assert.equal(error.details.stored_body_hash, bodyHash(stored));
    assert.equal(error.details.readback_attempt_count, 3);
    assert.ok(error.details.differing_paths.includes('$.s[0].k[0].c'));
    assert.ok(error.details.differing_paths.includes('$.v[0].v.c'));
    assert.ok(error.details.differing_paths.includes('$.s[0].<field>'));
    const serialized = JSON.stringify(error);
    for (const privateValue of ['fixture-secret', 'fixture-private-command', 'privateFixtureVariable', 'fixture-private-comment']) {
      assert.equal(serialized.includes(privateValue), false);
    }
    return true;
  });
  assert.equal(fixture.reads(), 3);
  assert.deepEqual(fixture.waits, [250, 750]);
  assert.deepEqual(fixture.writes, []);
});

test('observing a different stored hash never replaces the originally intended draft hash', async () => {
  const body = draft();
  const stored = structuredClone(body);
  stored.s[0].k[0].c = 'on';
  const fixture = readOnlyFixture([live(stored)]);
  await assert.rejects(verifyPistonUpdate(fixture.client, selection(body), fixture.options), error => {
    assert.equal(error.code, 'PISTON_READBACK_MISMATCH');
    assert.equal(error.details.expected_body_hash, bodyHash(body));
    assert.equal(error.details.stored_body_hash, bodyHash(stored));
    assert.notEqual(error.details.expected_body_hash, error.details.stored_body_hash);
    assert.ok(error.details.readback_attempts.every(attempt => attempt.stored_body_hash === bodyHash(stored)));
    return true;
  });
  assert.equal(fixture.reads(), 3);
  assert.deepEqual(fixture.writes, []);
});

test('persistent network failures keep the final error and retry history sanitized', async () => {
  const body = draft();
  const sensitive = new Error('fixture-secret-url http://hub.local/?access_token=fixture-secret-token');
  sensitive.code = 'fixture-secret-code/with-url';
  sensitive.details = { token: 'fixture-secret-token', pin: 'fixture-secret-pin', body };
  const fixture = readOnlyFixture([sensitive]);
  await assert.rejects(verifyPistonUpdate(fixture.client, selection(body), fixture.options), error => {
    assert.equal(error.code, 'PISTON_READBACK_FAILED');
    assert.equal(error.details.cause_code, 'REQUEST_FAILED');
    assert.equal(error.details.stored_definition_unknown, true);
    assert.equal(error.details.readback_attempt_count, 3);
    assert.equal(JSON.stringify(error).includes('fixture-secret'), false);
    assert.ok(error.details.readback_attempts.every(attempt => attempt.cause_code === 'REQUEST_FAILED'));
    return true;
  });
  assert.equal(fixture.reads(), 3);
  assert.deepEqual(fixture.writes, []);
});

test('authentication and nontransient HTTP failures stop without further reads', async () => {
  const body = draft();
  for (const failure of [new WebcoreError('fixture-secret-auth', 'AUTH_ERROR'), Object.assign(new WebcoreError('fixture-secret-http', 'HTTP_ERROR'), { httpStatus: 404 })]) {
    const fixture = readOnlyFixture([failure, live(body)]);
    await assert.rejects(verifyPistonUpdate(fixture.client, selection(body), fixture.options), error => error.code === 'PISTON_READBACK_FAILED');
    assert.equal(fixture.reads(), 1);
    assert.deepEqual(fixture.waits, []);
    assert.deepEqual(fixture.writes, []);
  }
});

test('wrong stored ID or name fails immediately rather than following another piston', async () => {
  const body = draft();
  for (const meta of [{ id: ':other-fixture-id:' }, { name: 'Other private fixture name' }]) {
    const fixture = readOnlyFixture([live(body, meta), live(body)]);
    await assert.rejects(verifyPistonUpdate(fixture.client, selection(body), fixture.options), error => {
      assert.equal(error.code, 'PISTON_READBACK_INVALID');
      assert.equal(error.details.cause_code, 'PISTON_IDENTITY_MISMATCH');
      assert.equal(error.details.readback_attempt_count, 1);
      assert.equal(error.details.verified, false);
      assert.equal(JSON.stringify(error).includes('Other private fixture name'), false);
      return true;
    });
    assert.equal(fixture.reads(), 1);
    assert.deepEqual(fixture.waits, []);
    assert.deepEqual(fixture.writes, []);
  }
});

test('a draft/hash mismatch rejects before any stored read', async () => {
  const body = draft();
  const changed = structuredClone(body);
  changed.s[0].k[0].c = 'on';
  const fixture = readOnlyFixture([live(body)]);
  await assert.rejects(verifyPistonUpdate(fixture.client, selection(body), { ...fixture.options, expectedBody: changed }), error => {
    assert.equal(error.code, 'DRAFT_HASH_MISMATCH');
    assert.equal(error.details.expected_body_hash, bodyHash(body));
    assert.equal(error.details.proposed_body_hash, bodyHash(changed));
    assert.equal(error.details.body_fingerprint_version, 2);
    return true;
  });
  assert.equal(fixture.reads(), 0);
  assert.deepEqual(fixture.writes, []);
});

test('malformed expected body hashes reject before any read or write', async () => {
  const body = draft();
  for (const malformed of [undefined, null, '', 123, 'g'.repeat(64), 'a'.repeat(63), 'A'.repeat(64), ` ${bodyHash(body)}`, `${bodyHash(body)}\n`]) {
    const fixture = readOnlyFixture([live(body)]);
    await assert.rejects(verifyPistonUpdate(fixture.client, { ...selection(body), expected_body_hash: malformed }, fixture.options), error => error.code === 'EXPECTED_BODY_HASH_REQUIRED');
    assert.equal(fixture.reads(), 0);
    assert.deepEqual(fixture.writes, []);
  }
});

test('missing exact identity is rejected before a stored read', async () => {
  const body = draft();
  for (const [identity, code] of [[{ id: '7' }, 'PISTON_ID_REQUIRED'], [{ id: '' }, 'PISTON_ID_REQUIRED'], [{ expected_name: '' }, 'EXPECTED_NAME_REQUIRED']]) {
    const fixture = readOnlyFixture([live(body)]);
    await assert.rejects(verifyPistonUpdate(fixture.client, { ...selection(body), ...identity }, fixture.options), error => error.code === code);
    assert.equal(fixture.reads(), 0);
    assert.deepEqual(fixture.writes, []);
  }
});

test('assertPreparedBodyHash preserves the approved hash while rejecting changed logic', () => {
  const body = draft();
  const approvedHash = bodyHash(body);
  assert.equal(assertPreparedBodyHash(body, approvedHash), approvedHash);
  for (const mutation of [value => { value.s[0].k[0].c = 'on'; }, value => { value.v[0].v.c = 'changed fixture value'; }, value => { value.z = 'changed fixture comment'; }]) {
    const changed = structuredClone(body);
    mutation(changed);
    assert.throws(() => assertPreparedBodyHash(changed, approvedHash), error => error.code === 'DRAFT_HASH_MISMATCH');
  }
  assert.throws(() => assertPreparedBodyHash(body, 'not-a-hash'), error => error.code === 'EXPECTED_BODY_HASH_REQUIRED');
});

test('prepared payload hash rejects a changed rename even when the stored body hash is unchanged', () => {
  const body = { ...draft(), n: 'Approved rename' };
  const changed = { ...structuredClone(body), n: 'Different rename' };
  const approvedPayloadHash = hashJson(body);
  assert.equal(bodyHash(changed), bodyHash(body));
  assert.notEqual(hashJson(changed), approvedPayloadHash);
  assert.equal(assertPreparedDraftHash(body, approvedPayloadHash), approvedPayloadHash);
  assert.throws(() => assertPreparedDraftHash(changed, approvedPayloadHash), error => error.code === 'DRAFT_HASH_MISMATCH');
});

test('verification rejects a draft rename that differs from the expected identity before reading', async () => {
  const body = { ...draft(), n: 'Approved rename' };
  const fixture = readOnlyFixture([live(body, { name: 'Approved rename' })]);
  await assert.rejects(verifyPistonUpdate(fixture.client, selection(body), { ...fixture.options, expectedBody: body }), error => error.code === 'DRAFT_NAME_MISMATCH');
  assert.equal(fixture.reads(), 0);
  assert.deepEqual(fixture.waits, []);
  assert.deepEqual(fixture.writes, []);
});
