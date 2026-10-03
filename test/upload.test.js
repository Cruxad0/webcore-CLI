import test from 'node:test';
import assert from 'node:assert/strict';
import { WebcoreClient, UPLOAD_URL_BYTE_LIMIT, UPLOAD_CHUNK_CHAR_LIMIT } from '../server/client.js';
import { applyPistonUpdate } from '../server/update.js';
import { hashJson, pistonFingerprint, prepareUpdate, validatePiston } from '../server/piston.js';

function fixture(options = {}) {
  const calls = [];
  let staged;
  let committed;
  let commits = 0;
  let rejected = false;
  const response = (status, body) => new Response(JSON.stringify(body), { status });
  const client = new WebcoreClient({ baseUrl: 'http://hub/apps/api/17', accessToken: 'access-secret', securityToken: 'session-secret' }, async url => {
    const u = new URL(url);
    const path = u.pathname;
    const params = Object.fromEntries(u.searchParams);
    const bytes = Buffer.byteLength(u.href);
    calls.push({ path, params, bytes });
    if (bytes > (options.maxUrlBytes ?? UPLOAD_URL_BYTE_LIMIT)) return response(414, {});
    if (path.endsWith('/set') && options.rejectSingle) return response(414, {});
    if (path.endsWith('/set.start')) {
      staged = Array(Number(params.chunks));
      return response(200, { status: 'ST_READY' });
    }
    if (path.endsWith('/set.chunk')) {
      if (options.rejectFirstChunk && !rejected) { rejected = true; return response(414, {}); }
      staged[Number(params.chunk)] = params.data;
      options.onChunk?.();
      return response(200, { status: options.chunkStatus ?? 'ST_READY' });
    }
    if (path.endsWith('/set.end')) {
      if (options.rejectEnd) return response(414, {});
      if (options.loseEndResponse) throw new Error('fixture connection lost');
      assert.ok(staged.every(chunk => typeof chunk === 'string'));
      committed = staged.join('');
      commits++;
      return response(200, { status: options.endStatus ?? 'ST_SUCCESS' });
    }
    if (path.endsWith('/set')) {
      committed = params.data;
      commits++;
      return response(200, { status: options.singleStatus ?? 'ST_SUCCESS' });
    }
    throw new Error(`Unexpected fixture path: ${path}`);
  });
  return { client, calls, committed: () => committed, commits: () => commits };
}

test('nested statement arrays validate without inCommand and still check inherited devices and required arguments', () => {
  const inventory = { d1: { c: [{ n: 'setLevel', p: [{ n: 'level', t: 'NUMBER', required: true }] }], a: [{ n: 'switch' }] } };
  const make = command => ({ piston: { s: [{ devices: ['d1'], actions: [[command]] }] } });
  assert.deepEqual(validatePiston(make({ command: 'setLevel', arguments: [20] }), inventory), []);
  assert.ok(validatePiston(make({ command: 'setLevel', arguments: ['20'] }), inventory).some(e => e.includes('must be numeric')));
  assert.ok(validatePiston(make({ command: 'setLevel' }), inventory).some(e => e.includes('required command parameter')));
  assert.ok(validatePiston(make({ command: 'turnBlue' }), inventory).some(e => e.includes('does not support command')));
  assert.ok(validatePiston(make({ deviceId: 'missing' }), inventory).some(e => e.includes('Unknown') || e.includes('unknown')));
  const draft = make({ command: 'setLevel', arguments: [20] });
  assert.equal(prepareUpdate('pid', { data: { piston: {} } }, draft, inventory).ok, true);
});

test('chunks respect encoded URL bytes, percent expansion, credential overhead, and the 1500-character cap', async () => {
  const f = fixture();
  const encoded = Buffer.alloc(3500, 0xff).toString('base64');
  let guards = 0;
  const saved = await f.client.savePiston('pid', encoded, { beforeCommit: async () => { guards++; } });
  assert.equal(saved.status, 'ST_SUCCESS');
  assert.equal(saved.upload.mode, 'chunked');
  assert.equal(f.committed(), encoded);
  assert.equal(guards, 2);
  assert.ok(f.calls.every(call => call.bytes <= UPLOAD_URL_BYTE_LIMIT));
  assert.ok(f.calls.filter(call => call.path.endsWith('/set.chunk')).every(call => call.params.data.length <= UPLOAD_CHUNK_CHAR_LIMIT));
  assert.equal(JSON.stringify(saved).includes('secret'), false);
});

test('a small successful write uses one bounded request and requires ST_SUCCESS', async () => {
  const f = fixture();
  const saved = await f.client.savePiston('pid', 'YWJj');
  assert.equal(saved.upload.mode, 'single');
  assert.equal(f.calls.length, 1);
  assert.equal(f.commits(), 1);
  const unconfirmed = fixture({ singleStatus: 'ST_UNKNOWN' });
  await assert.rejects(unconfirmed.client.savePiston('pid', 'YWJj'), error => error.code === 'UPLOAD_NOT_CONFIRMED' && error.details.commit_confirmation_unknown === true);
  assert.equal(unconfirmed.calls.length, 1);
});

test('an explicit single-request 414 switches to chunks and rechecks before the final commit', async () => {
  const f = fixture({ rejectSingle: true });
  let guards = 0;
  const encoded = 'A'.repeat(100);
  const saved = await f.client.savePiston('pid', encoded, { beforeCommit: async () => { guards++; } });
  assert.equal(saved.upload.mode, 'chunked');
  assert.equal(saved.upload.request_trace[0].http_status, 414);
  assert.equal(guards, 3);
  assert.equal(f.committed(), encoded);
  assert.equal(f.commits(), 1);
});

test('a rejected staged chunk replans smaller chunks and commits once', async () => {
  const f = fixture({ rejectFirstChunk: true });
  const encoded = 'A'.repeat(4000);
  const saved = await f.client.savePiston('pid', encoded);
  assert.equal(saved.upload.attempts, 2);
  assert.equal(saved.upload.largest_chunk_chars, 750);
  assert.equal(f.calls.filter(call => call.path.endsWith('/set.start')).length, 2);
  assert.equal(f.committed(), encoded);
  assert.equal(f.commits(), 1);
});

test('failed chunks and lost final responses do not get automatically committed or replayed', async () => {
  const failedChunk = fixture({ chunkStatus: 'ST_UNKNOWN' });
  await assert.rejects(failedChunk.client.savePiston('pid', 'A'.repeat(4000)), { code: 'UPLOAD_NOT_READY' });
  assert.equal(failedChunk.calls.some(call => call.path.endsWith('/set.end')), false);
  const lostEnd = fixture({ loseEndResponse: true });
  await assert.rejects(lostEnd.client.savePiston('pid', 'A'.repeat(4000)), error => error.code === 'NETWORK_ERROR' && error.details.upload_stage === 'set.end' && error.details.commit_confirmation_unknown);
  assert.equal(lostEnd.calls.filter(call => call.path.endsWith('/set.end')).length, 1);
  assert.equal(lostEnd.calls.filter(call => call.path.endsWith('/set.start')).length, 1);
  const rejectedEnd = fixture({ rejectEnd: true });
  await assert.rejects(rejectedEnd.client.savePiston('pid', 'A'.repeat(4000)), error => error.httpStatus === 414 && error.details.upload_stage === 'set.end');
  assert.equal(rejectedEnd.calls.filter(call => call.path.endsWith('/set.start')).length, 1);
  assert.equal(rejectedEnd.calls.filter(call => call.path.endsWith('/set.end')).length, 1);
  const unconfirmedEnd = fixture({ endStatus: 'ST_UNKNOWN' });
  await assert.rejects(unconfirmedEnd.client.savePiston('pid', 'A'.repeat(4000)), error => error.code === 'UPLOAD_NOT_CONFIRMED' && error.details.commit_confirmation_unknown);
  assert.equal(unconfirmedEnd.commits(), 1);
});

test('payloads requiring over 99 chunks fail before any upload request', async () => {
  const f = fixture();
  await assert.rejects(f.client.savePiston('pid', 'A'.repeat(1500 * 100)), { code: 'UPLOAD_TOO_LARGE' });
  assert.equal(f.calls.length, 0);
});

test('shared apply rejects stale bases and edits made during staging before set.end', async () => {
  let live = { data: { meta: { id: 'pid', name: 'Dryer Notification' }, piston: { s: [] } } };
  const baseHash = hashJson(pistonFingerprint(live));
  const draft = { meta: live.data.meta, piston: { s: [], z: 'A'.repeat(5000) } };
  const f = fixture({ onChunk: () => { live.data.piston = { s: [{ changed: true }] }; } });
  f.client.getPiston = async () => structuredClone(live);
  f.client.listDevices = async () => ({});
  f.client.getLanguageDb = async () => ({ db: {} });
  await assert.rejects(applyPistonUpdate(f.client, 'pid', draft, baseHash), error => error.code === 'STALE_PISTON' && error.details.upload_stage === 'hash_check');
  assert.equal(f.calls.some(call => call.path.endsWith('/set.end')), false);
  assert.equal(f.commits(), 0);
  f.calls.length = 0;
  await assert.rejects(applyPistonUpdate(f.client, 'pid', draft, baseHash), { code: 'STALE_PISTON' });
  assert.equal(f.calls.length, 0);
});

test('simultaneous uploads using the same session are rejected while staging', async () => {
  const f = fixture();
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const first = f.client.savePiston('pid', 'A'.repeat(4000), { beforeCommit: () => held });
  await assert.rejects(f.client.savePiston('other', 'YWJj'), { code: 'UPLOAD_BUSY' });
  release();
  await first;
  assert.equal(f.commits(), 1);
});
