import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPin, normalizePistonList, parseEndpoint, parseWebcoreResponse, WebcoreClient } from '../server/client.js';
import { assertExpectedRemoteHash, hashJson, pistonFingerprint, prepareUpdate, validatePiston } from '../server/piston.js';
import { runDiagnostics } from '../server/diagnostics.js';

test('parseEndpoint extracts local app API root from an execute URL', () => {
  assert.deepEqual(parseEndpoint('http://hub.local:8080/apps/api/17/execute/:piston:?access_token=abc'), { baseUrl: 'http://hub.local:8080/apps/api/17', accessToken: 'abc', connectionMode: 'local' });
});

test('parseEndpoint accepts Hubitat cloud app URLs as an explicit cloud mode', () => {
  assert.deepEqual(parseEndpoint('https://cloud.hubitat.com/api/hub-uuid/apps/17/execute/:piston:?access_token=abc'), { baseUrl: 'https://cloud.hubitat.com/api/hub-uuid/apps/17', accessToken: 'abc', connectionMode: 'cloud' });
  assert.throws(() => parseEndpoint('https://example.com/api/hub-uuid/apps/17/execute/:piston:?access_token=abc'), /URL must be a local/);
  assert.throws(() => parseEndpoint('https://cloud.hubitat.com/api/hub-uuid/apps/17/execute/:piston:'), /access_token/);
});

test('PIN hash uses webCoRE pin: prefix', () => {
  assert.equal(hashPin('1234'), '7f67da6c7cae7867e1ad526b20cf71df');
});

test('webCoRE application/javascript callback response is parsed as JSON without evaluation', async () => {
  const responseBody = 'null({"instance":{"token":"session-token"}})';
  assert.deepEqual(parseWebcoreResponse(responseBody), { instance: { token: 'session-token' } });
  assert.throws(() => parseWebcoreResponse('alert("not JSON")'), /neither JSON nor JSONP/);

  const c = new WebcoreClient({ baseUrl: 'http://hub/apps/api/17', accessToken: 'secret' }, async () => new Response(responseBody, { headers: { 'content-type': 'application/javascript;charset=utf-8' } }));
  const result = await c.authenticate('1234');
  assert.equal(result.securityToken, 'session-token');
});

test('authorized inventory pagination merges current live states', async () => {
  const calls = [];
  const fakeFetch = async url => {
    calls.push(new URL(url));
    const u = new URL(url);
    const body = u.pathname.endsWith('/devices')
      ? (u.searchParams.get('offset') === '0' ? { devices: { d1: { n: 'Lamp', cn: ['Switch'], a: [{ n: 'switch', t: 'string' }], c: [{ n: 'on', p: [] }] } }, complete: false, nextOffset: 1 } : { devices: { d2: { n: 'Motion' } }, complete: true })
      : { d1: { switch: 'off' }, d2: { motion: 'inactive' } };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const c = new WebcoreClient({ baseUrl: 'http://hub/apps/api/17', accessToken: 'secret', securityToken: 'session' }, fakeFetch);
  const devices = await c.listDevices();
  assert.equal(Object.keys(devices).length, 2);
  assert.deepEqual(devices.d1.currentState, { switch: 'off' });
  assert.equal(calls.every(url => url.searchParams.get('access_token') === 'secret' && url.searchParams.get('token') === 'session'), true);
});

test('piston list comes from webCoRE dashboard instance metadata', async () => {
  const c = new WebcoreClient({ baseUrl: 'http://hub/apps/api/17', accessToken: 'secret', securityToken: 'session' }, async () => new Response(JSON.stringify({ instance: { pistons: [{ id: 'p1', n: 'Morning' }] } }), { status: 200 }));
  assert.deepEqual(await c.listPistons(), [{ id: 'p1', n: 'Morning' }]);
});

test('piston lists normalize keyed responses and reject missing list data', () => {
  assert.deepEqual(normalizePistonList({ instance: { pistons: { p1: { n: 'Morning', active: true }, p2: { id: 'custom', n: 'Evening' } } } }), [
    { n: 'Morning', active: true, id: 'p1' },
    { id: 'custom', n: 'Evening' }
  ]);
  assert.deepEqual(normalizePistonList({ instance: { pistons: [] } }), []);
  assert.throws(() => normalizePistonList({ instance: { name: 'Hub' } }), error => error.code === 'PISTON_LIST_UNAVAILABLE');
});

test('diagnostics retries an empty piston list and keeps credentials out of its report', async () => {
  let loadCalls = 0;
  const fakeFetch = async url => {
    const path = new URL(url).pathname;
    if (path.endsWith('/load')) {
      loadCalls++;
      const pistons = loadCalls === 1 ? [] : [{ id: 'p1', n: 'Morning' }];
      return new Response(JSON.stringify({ instance: { pistons } }), {
        status: 200,
        headers: { 'content-type': 'application/javascript;charset=utf-8' }
      });
    }
    if (path.endsWith('/devices')) return new Response(JSON.stringify({ devices: { d1: { n: 'Lamp' } }, complete: true }), { status: 200 });
    if (path.endsWith('/refresh')) return new Response(JSON.stringify({ d1: { switch: 'off' } }), { status: 200 });
    throw new Error('Unexpected endpoint');
  };
  const c = new WebcoreClient({
    baseUrl: 'http://hub/apps/api/17',
    accessToken: 'access-secret',
    securityToken: 'session-secret',
    connectionMode: 'local'
  }, fakeFetch);
  const report = await runDiagnostics(c);
  assert.equal(report.ok, true);
  assert.equal(report.checks.dashboard.content_type, 'application/javascript');
  assert.equal(report.checks.piston_list.count, 1);
  assert.equal(report.checks.piston_list.attempts, 2);
  assert.equal(report.checks.piston_list.changed_between_reads, true);
  assert.equal(report.checks.authorized_devices.count, 1);
  assert.equal(JSON.stringify(report).includes('secret'), false);
});

test('piston validation rejects unknown device IDs, commands, and attributes', () => {
  const errors = validatePiston({ deviceId: 'missing', command: 'notACommand', attribute: 'notAnAttribute' }, { d1: { c: [{ n: 'on' }], a: [{ n: 'switch' }] } }, { commands: { physical: { on: { n: 'on' } } }, attributes: { switch: { n: 'switch' } } });
  assert.equal(errors.length, 3);
});

test('piston validation checks command support and required typed arguments per device', () => {
  const inventory = { d1: { c: [{ n: 'setLevel', p: [{ n: 'level', t: 'NUMBER', m: 1 }] }], a: [{ n: 'switch' }] } };
  const errors = validatePiston({ deviceId: 'd1', command: 'setLevel', arguments: [] }, inventory, {});
  assert.ok(errors.some(e => e.includes('required command parameter')));
  assert.ok(validatePiston({ deviceId: 'd1', command: 'turnBlue' }, inventory, {}).some(e => e.includes('does not support command')));
});

test('prepared update is validated and bound to the live remote hash', () => {
  const live = { data: { meta: { id: 'pid', name: 'Piston', modified: 10 }, piston: { s: [] }, logs: [{ t: 10 }] } };
  const proposed = { meta: { id: 'pid', name: 'Piston' }, piston: { s: [] } };
  const result = prepareUpdate('pid', live, proposed, { d1: {} }, {});
  assert.equal(result.ok, true);
  assert.equal(result.expected_remote_hash, hashJson(pistonFingerprint(live)));
  assert.equal(assertExpectedRemoteHash(live, result.expected_remote_hash), true);
  assert.equal(assertExpectedRemoteHash({ data: { ...live.data, logs: [{ t: 20 }], meta: { ...live.data.meta, modified: 20 } } }, result.expected_remote_hash), true);
  assert.throws(() => assertExpectedRemoteHash({ data: { ...live.data, piston: { statements: [{ id: 'changed' }] } } }, result.expected_remote_hash), /Stale piston/);
  assert.notEqual(hashJson({ name: 'Piston', statements: [{ id: 'changed' }] }), result.expected_remote_hash);
});
