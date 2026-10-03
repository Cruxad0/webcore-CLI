import test from 'node:test';
import assert from 'node:assert/strict';
import { WebcoreError } from '../server/client.js';
import { hashJson, pistonBodyFingerprint, pistonFingerprint } from '../server/piston.js';
import { applyPistonUpdate } from '../server/update.js';

function fixture(outcomes = []) {
  const draft = { s: [{ t: 'action', d: [], k: [{ c: 'sendPushNotification', p: [{ t: 'c', vt: 'string', c: 'Intended fixture text' }] }] }], v: [] };
  const original = { data: { meta: { id: 'pid', name: 'Fixture', build: 1, active: true }, piston: { s: [], v: [] } } };
  let current = structuredClone(original), writes = 0, tests = 0;
  const delays = [];
  const client = {
    async getPiston() {
      if (writes && outcomes.length) {
        const outcome = outcomes.shift();
        if (outcome === 'stale') return structuredClone(original);
        if (outcome === 'network') throw new WebcoreError('fixture-private-message', 'NETWORK_ERROR');
        if (outcome === 'wrong-id') return { data: { ...current.data, meta: { ...current.data.meta, id: 'other' } } };
        if (outcome === 'different') {
          const changed = structuredClone(current);
          changed.data.piston.s[0].k[0].p[0].c = 'Actual fixture mismatch';
          return changed;
        }
      }
      return structuredClone(current);
    },
    async listDevices() { return {}; },
    async getLanguageDb() { return { db: {} }; },
    async savePiston(id, encoded, { beforeCommit }) {
      await beforeCommit();
      writes++;
      current = { data: { meta: { id, name: 'Fixture', build: 2, active: false }, piston: JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) } };
      return { status: 'ST_SUCCESS', build: 999, upload: { request_trace: [{ path: '/intf/dashboard/piston/set', http_status: 200, url_bytes: 800 }] } };
    },
    async testPiston() { tests++; throw new Error('Live test must not be called.'); }
  };
  return { client, draft, expectedRemote: hashJson(pistonFingerprint(original)), expectedBody: hashJson(pistonBodyFingerprint(draft)),
    options: { readbackOptions: { waitForRetry: async delay => { delays.push(delay); } } }, delays, writes: () => writes, tests: () => tests };
}

test('apply reconciles a stale first read using exactly one upload and reports persistence separately from device testing', async () => {
  const f = fixture(['stale']);
  const result = await applyPistonUpdate(f.client, 'pid', f.draft, f.expectedRemote, { ...f.options, expectedBodyHash: f.expectedBody });
  assert.equal(result.applied, true);
  assert.equal(result.persistence_verified, true);
  assert.equal(result.device_execution_verified, false);
  assert.equal(result.verification.readback_attempt_count, 2);
  assert.equal(result.verification.readback_attempts[0].code, 'PISTON_READBACK_MISMATCH');
  assert.equal(result.verification.build, 2);
  assert.equal(result.verification.active, false);
  assert.deepEqual(f.delays, [250]);
  assert.equal(f.writes(), 1);
  assert.equal(f.tests(), 0);
});

test('apply recovers from a transient read error without repeating the accepted save', async () => {
  const f = fixture(['network']);
  const result = await applyPistonUpdate(f.client, 'pid', f.draft, f.expectedRemote, f.options);
  assert.equal(result.verified, true);
  assert.equal(result.verification.readback_attempt_count, 2);
  assert.equal(JSON.stringify(result).includes('fixture-private-message'), false);
  assert.equal(f.writes(), 1);
});

test('an actual changed operand remains accepted but unverified after bounded reads with value-free diagnostics', async () => {
  const f = fixture(['different', 'different', 'different']);
  await assert.rejects(applyPistonUpdate(f.client, 'pid', f.draft, f.expectedRemote, f.options), error => {
    assert.equal(error.code, 'PISTON_READBACK_MISMATCH');
    assert.equal(error.details.accepted, true);
    assert.equal(error.details.applied, false);
    assert.equal(error.details.retry_safe, false);
    assert.equal(error.details.device_execution_verified, false);
    assert.equal(error.details.readback_attempt_count, 3);
    assert.ok(error.details.differing_paths.includes('$.s[0].k[0].p[0].c'));
    assert.equal(JSON.stringify(error.details).includes('Actual fixture mismatch'), false);
    assert.equal(JSON.stringify(error.details).includes('Intended fixture text'), false);
    return true;
  });
  assert.deepEqual(f.delays, [250, 750]);
  assert.equal(f.writes(), 1);
});

test('wrong piston identity stops read-back immediately and never replays the write', async () => {
  const f = fixture(['wrong-id']);
  await assert.rejects(applyPistonUpdate(f.client, 'pid', f.draft, f.expectedRemote, f.options), error =>
    error.code === 'PISTON_READBACK_INVALID' && error.details.readback_attempt_count === 1);
  assert.deepEqual(f.delays, []);
  assert.equal(f.writes(), 1);
});

test('an approved body hash refuses a changed draft before upload', async () => {
  const f = fixture();
  const changed = structuredClone(f.draft);
  changed.z = 'Changed after approval';
  await assert.rejects(applyPistonUpdate(f.client, 'pid', changed, f.expectedRemote, { ...f.options, expectedBodyHash: f.expectedBody }), error => error.code === 'DRAFT_HASH_MISMATCH');
  assert.equal(f.writes(), 0);
});

test('the full prepared payload hash binds an approved rename before upload', async () => {
  const f = fixture();
  const approved = { ...f.draft, n: 'Approved rename' };
  const changed = { ...approved, n: 'Different rename' };
  assert.equal(hashJson(pistonBodyFingerprint(approved)), hashJson(pistonBodyFingerprint(changed)));
  await assert.rejects(applyPistonUpdate(f.client, 'pid', changed, f.expectedRemote,
    { ...f.options, expectedBodyHash: hashJson(pistonBodyFingerprint(approved)), expectedProposedHash: hashJson(approved) }), error => error.code === 'DRAFT_HASH_MISMATCH');
  assert.equal(f.writes(), 0);
});
