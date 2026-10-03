import test from 'node:test';
import assert from 'node:assert/strict';
import { WebcoreError } from '../server/client.js';
import { applyPistonUpdate } from '../server/update.js';
import { hashJson, normalizePistonDraft, pistonBodyFingerprint, pistonFingerprint, prepareUpdate } from '../server/piston.js';

const body = () => ({ o: { cto: 0 }, r: [], rn: false, rop: 'and',
  s: [{ t: 'action', d: [], k: [{ c: 'sendPushNotification', p: [{ t: 'c', vt: 'string', c: 'Fixture notification' }] }], $: 91 }],
  v: [{ n: 'running', t: 'boolean', v: { t: 'c', vt: 'boolean', c: false } }], z: 'Dryer fixture 🔔' });

function fixture({ mutateStored, failReadback = false } = {}) {
  let live = { data: { meta: { id: 'pid', name: 'Dryer Notification', build: 27, active: true }, piston: { s: [], v: [] } } };
  const baseHash = hashJson(pistonFingerprint(live));
  let uploads = 0;
  let uploadedBody;
  const client = {
    async getPiston() {
      if (uploads && failReadback) throw new WebcoreError('fixture-secret must not be exposed', 'NETWORK_ERROR');
      return structuredClone(live);
    },
    async listDevices() { return {}; },
    async getLanguageDb() { return { db: {} }; },
    async savePiston(id, encoded, { beforeCommit }) {
      await beforeCommit();
      uploadedBody = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      uploads++;
      live = { data: { meta: { ...live.data.meta, name: uploadedBody.n || live.data.meta.name, build: 28, active: false }, piston: structuredClone({
        o: uploadedBody.o ?? {}, r: uploadedBody.r ?? [], rn: uploadedBody.rn ?? false,
        rop: uploadedBody.rop || 'and', s: uploadedBody.s ?? [], v: uploadedBody.v ?? [], z: uploadedBody.z ?? ''
      }), logs: ['runtime logs do not affect definition verification'], localVars: { running: true } } };
      mutateStored?.(live);
      return { status: 'ST_SUCCESS', build: 999, active: true,
        upload: { request_trace: [{ path: '/intf/dashboard/piston/set', http_status: 200, url_bytes: 900 }] } };
    }
  };
  return { client, baseHash, live: () => structuredClone(live), uploads: () => uploads, uploaded: () => structuredClone(uploadedBody) };
}

test('prepare unwraps supported drafts and diffs exactly the native body that will be uploaded', () => {
  const native = body();
  for (const proposed of [native, { meta: { id: 'pid' }, piston: native }, { data: { meta: { id: 'pid' }, piston: native }, db: {} }]) {
    const prepared = prepareUpdate('pid', { data: { piston: { s: [] } } }, proposed, {});
    assert.equal(prepared.ok, true);
    assert.equal(prepared.payload_format, 'webcore-body');
    assert.deepEqual(prepared.proposed, native);
    assert.deepEqual(prepared.diff.after, native);
    assert.equal(prepared.proposed_body_hash, hashJson(pistonBodyFingerprint(native)));
  }
});

test('non-native bodies, mixed wrappers, wrong IDs, and dropped root fields fail before a write', async () => {
  for (const proposed of [{}, { meta: { id: 'pid' } }, { piston: {} }, { piston: { statements: [{}] } },
    { s: null }, { s: ['invalid'] }, { s: [], v: {} }, { s: [], o: [] }, { s: [], rn: 'false' },
    { s: [], description: 'would be dropped' }, { s: [], piston: body() }, { data: { piston: body() }, piston: body() },
    { meta: { id: 'another' }, piston: body() }, { data: { meta: { id: 'another' }, piston: body() } }]) {
    const f = fixture();
    const prepared = prepareUpdate('pid', f.live(), proposed, {});
    assert.equal(prepared.ok, false);
    await assert.rejects(applyPistonUpdate(f.client, 'pid', proposed, f.baseHash));
    assert.equal(f.uploads(), 0);
  }
});

test('successful apply sends body only and reports build/state from a matching fresh read-back', async () => {
  for (const wrap of [native => native, native => ({ meta: { id: 'pid' }, piston: native }), native => ({ data: { meta: { id: 'pid' }, piston: native } })]) {
    const f = fixture({ mutateStored: live => { live.data.piston.s[0].$ = 1; live.data.piston.s[0].k[0].$ = 2; } });
    const draft = wrap(body());
    const original = structuredClone(draft);
    const saved = await applyPistonUpdate(f.client, 'pid', draft, f.baseHash);
    assert.equal(saved.applied, true);
    assert.equal(saved.verified, true);
    assert.equal(saved.verification.build, 28);
    assert.equal(saved.verification.active, false);
    assert.equal(saved.result.build, undefined);
    assert.equal(saved.result.active, undefined);
    assert.equal(saved.verification.expected_body_hash, saved.verification.stored_body_hash);
    assert.equal(saved.verification.body_summary.logic_sections, 1);
    assert.equal(saved.verification.body_summary.variables, 1);
    assert.deepEqual(f.uploaded(), body());
    assert.deepEqual(draft, original);
    assert.equal(f.uploads(), 1);
  }
});

test('verification allows server root defaults and generated IDs and verifies a requested rename', async () => {
  const f = fixture();
  const saved = await applyPistonUpdate(f.client, 'pid', { s: [], n: 'Renamed fixture' }, f.baseHash);
  assert.equal(saved.verified, true);
  assert.equal(saved.verification.selected_piston.name, 'Renamed fixture');
  assert.deepEqual(f.uploaded(), { s: [], n: 'Renamed fixture' });
  assert.deepEqual(normalizePistonDraft('pid', { s: [], cached: true, $: 4 }).body, { s: [] });
});

test('ST_SUCCESS with empty, previous, partial, or altered bodies is never applied success or retried', async () => {
  for (const change of [live => { live.data.piston = { s: [], v: [] }; },
    live => { live.data.piston.v = []; },
    live => { live.data.piston.s[0].k[0].p[0].c = 'Different fixture text'; },
    live => { live.data.piston.o.cto = 1; },
    live => { live.data.piston.z = 'Changed comment'; }]) {
    const f = fixture({ mutateStored: change });
    await assert.rejects(applyPistonUpdate(f.client, 'pid', body(), f.baseHash), error => {
      assert.equal(error.code, 'PISTON_READBACK_MISMATCH');
      assert.equal(error.details.accepted, true);
      assert.equal(error.details.applied, false);
      assert.equal(error.details.verified, false);
      assert.equal(error.details.retry_safe, false);
      assert.notEqual(error.details.expected_body_hash, error.details.stored_body_hash);
      assert.equal(JSON.stringify(error.details).includes('Fixture notification'), false);
      return true;
    });
    assert.equal(f.uploads(), 1);
  }
});

test('lost read-back reports accepted but unverified, without exposing credentials or repeating the save', async () => {
  const f = fixture({ failReadback: true });
  await assert.rejects(applyPistonUpdate(f.client, 'pid', body(), f.baseHash), error => {
    assert.equal(error.code, 'PISTON_READBACK_FAILED');
    assert.equal(error.details.applied, false);
    assert.equal(error.details.stored_definition_unknown, true);
    assert.equal(error.details.cause_code, 'NETWORK_ERROR');
    assert.equal(JSON.stringify(error).includes('fixture-secret'), false);
    return true;
  });
  assert.equal(f.uploads(), 1);
});

test('missing body and mismatched read-back identity fail closed after acceptance', async () => {
  for (const change of [live => { delete live.data.piston; }, live => { live.data.piston = null; },
    live => { live.data.meta.id = 'other'; }, live => { live.data.meta.name = 'Other piston'; }]) {
    const f = fixture({ mutateStored: change });
    await assert.rejects(applyPistonUpdate(f.client, 'pid', body(), f.baseHash), error => error.code === 'PISTON_READBACK_INVALID' && error.details.applied === false);
    assert.equal(f.uploads(), 1);
  }
});
