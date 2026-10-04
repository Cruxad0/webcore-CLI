import test from 'node:test';
import assert from 'node:assert/strict';
import { WebcoreClient, normalizePistonList } from '../server/client.js';
import { runDiagnostics } from '../server/diagnostics.js';

const config = { baseUrl: 'http://fixture.invalid/apps/api/17', accessToken: 'fixture-secret-access', securityToken: 'fixture-secret-session' };
const snapshot = () => ({ instance: { name: 'fixture-secret-hub', coreVersion: 'v0.3.114.20220203', heVersion: 'v0.3.114.20240115_HE', pistons: [{ id: 'fixture-secret-id', n: 'fixture-secret-piston', active: true }] }, now: 1 });
function hubFixture() {
  const f = { body: snapshot(), sessions: new Map(), requests: [] };
  f.fetch = async input => {
    const url = new URL(input);
    f.requests.push(url);
    let body;
    if (url.pathname.endsWith('/load')) {
      const session = url.searchParams.get('session') ?? 'default';
      const encoded = JSON.stringify(f.body);
      // Reproduce HE's per-session change-detection protocol, not an invented
      // response wrapper. A default session may already belong to another chat.
      body = f.sessions.get(session) === encoded ? { now: Date.now() } : f.body;
      f.sessions.set(session, encoded);
    } else if (url.pathname.endsWith('/devices')) body = { devices: { 'fixture-secret-device': { n: 'fixture-secret-device-name' } }, complete: true };
    else if (url.pathname.endsWith('/refresh')) body = {};
    else throw new Error('Unexpected fixture request');
    return new Response(`null(${JSON.stringify(body)})`, { headers: { 'content-type': 'application/javascript' } });
  };
  f.client = new WebcoreClient(config, f.fetch);
  return f;
}

test('dashboard session avoids the default cache shared with other chats and CLI processes', async () => {
  const f = hubFixture();
  f.sessions.set('default', JSON.stringify(f.body));
  assert.equal((await f.client.listPistons()).length, 1);
  assert.match(f.requests[0].searchParams.get('session'), /^webcore-cli-/);
  assert.notEqual(f.requests[0].searchParams.get('session'), 'default');
});

test('fresh now-only confirmations preserve pistons and versions without another snapshot request', async () => {
  const f = hubFixture();
  const first = await f.client.getDashboard();
  first.instance.pistons.length = 0;
  first.instance.coreVersion = 'mutated';
  const second = await f.client.getDashboard();
  assert.equal(second.instance.pistons.length, 1);
  assert.equal(second.instance.coreVersion, 'v0.3.114.20220203');
  assert.equal(f.client.lastDashboardInfo.snapshot_source, 'hub_confirmed_unchanged');
  assert.deepEqual(f.client.lastDashboardInfo.attempts, [{ attempt: 1, response_kind: 'unchanged' }]);
  assert.equal((await f.client.listPistons()).length, 1);
  assert.equal(f.requests.length, 3);
  assert.equal(f.sessions.size, 1);
});

test('a changed hub snapshot immediately replaces prior piston/version data', async () => {
  const f = hubFixture();
  await f.client.getDashboard();
  f.body.instance.pistons.push({ id: 'p2', n: 'Second fixture', active: false });
  f.body.instance.heVersion = 'v0.3.115.20261004_HE';
  const current = await f.client.getDashboard();
  assert.equal(current.instance.pistons.length, 2);
  assert.equal(current.instance.heVersion, 'v0.3.115.20261004_HE');
  assert.equal(f.client.lastDashboardInfo.snapshot_source, 'hub_snapshot');
});

test('separate clients cannot inherit another client session or snapshot', async () => {
  const f = hubFixture();
  await f.client.getDashboard();
  const other = new WebcoreClient(config, f.fetch);
  assert.equal((await other.listPistons()).length, 1);
  assert.notEqual(f.requests[0].searchParams.get('session'), f.requests[1].searchParams.get('session'));
  assert.equal(other.lastDashboardInfo.snapshot_source, 'hub_snapshot');
});

test('concurrent dashboard reads serialize so no marker is paired with an unavailable snapshot', async () => {
  const f = hubFixture();
  let inflight = 0, peak = 0;
  const fetcher = f.client.fetch;
  f.client.fetch = async input => {
    inflight++;
    peak = Math.max(peak, inflight);
    await new Promise(resolve => setTimeout(resolve, 2));
    try { return await fetcher(input); } finally { inflight--; }
  };
  const results = await Promise.all(Array.from({ length: 10 }, () => f.client.listPistons()));
  assert.equal(peak, 1);
  assert.ok(results.every(list => list.length === 1));
  assert.equal(f.sessions.size, 1);
});

test('a first unchanged marker recovers using the second session slot exactly once', async () => {
  const sessions = [];
  const c = new WebcoreClient(config, async input => {
    sessions.push(new URL(input).searchParams.get('session'));
    return new Response(JSON.stringify(sessions.length === 1 ? { now: Date.now() } : snapshot()));
  });
  assert.equal((await c.listPistons()).length, 1);
  assert.equal(sessions.length, 2);
  assert.notEqual(sessions[0], sessions[1]);
  assert.equal(c.lastDashboardInfo.attempts.length, 2);
});

test('markers without a matching snapshot fail after bounded reads instead of fabricating zero', async () => {
  let requests = 0;
  const c = new WebcoreClient(config, async () => { requests++; return new Response(JSON.stringify({ now: Date.now() })); });
  await assert.rejects(c.listPistons(), error => error.code === 'DASHBOARD_SNAPSHOT_UNAVAILABLE' && error.details.attempts.length === 2);
  assert.equal(requests, 2);
  assert.equal(c.dashboardSnapshot, null);
});

test('parseable HTTP 200 junk is a dashboard failure even when devices remain readable', async () => {
  const f = hubFixture();
  f.body = { 'fixture-secret-key': 'fixture-secret-value' };
  const report = await runDiagnostics(f.client);
  assert.equal(report.ok, false);
  assert.equal(report.checks.dashboard.ok, false);
  assert.equal(report.checks.dashboard.transport_ok, true);
  assert.equal(report.checks.piston_list.skipped, true);
  assert.equal(report.checks.authorized_devices.count, 1);
  assert.equal(report.errors[0].code, 'DASHBOARD_RESPONSE_INVALID');
  assert.equal(JSON.stringify(report).includes('fixture-secret'), false);
});

test('malformed/extra-field markers invalidate a cached snapshot and cannot fall back to it', async () => {
  const f = hubFixture();
  await f.client.getDashboard();
  for (const malformed of [{}, { now: 'fixture-secret' }, { now: 1, error: 'fixture-secret' }, { instance: null }, []]) {
    f.body = malformed;
    await assert.rejects(f.client.listPistons(), error => error.code === 'DASHBOARD_RESPONSE_INVALID');
    assert.equal(f.client.dashboardSnapshot, null);
  }
});

test('network and authentication failures invalidate snapshots rather than returning old success', async () => {
  const f = hubFixture();
  await f.client.getDashboard();
  const fetcher = f.client.fetch;
  f.client.fetch = async () => { throw new Error('fixture-secret-network-url'); };
  await assert.rejects(f.client.listPistons(), error => error.code === 'NETWORK_ERROR');
  assert.equal(f.client.dashboardSnapshot, null);
  f.client.fetch = async () => new Response(JSON.stringify({ error: 'ERR_INVALID_TOKEN' }));
  await assert.rejects(f.client.listPistons(), error => error.code === 'ERR_INVALID_TOKEN');
  assert.equal(f.client.dashboardSnapshot, null);
  f.client.fetch = fetcher;
  assert.equal((await f.client.listPistons()).length, 1);
});

test('diagnostics use confirmed unchanged snapshots, omit values and show the source', async () => {
  const f = hubFixture();
  await f.client.listPistons();
  const report = await runDiagnostics(f.client);
  assert.equal(report.ok, true);
  assert.equal(report.checks.dashboard.snapshot_source, 'hub_confirmed_unchanged');
  assert.equal(report.checks.piston_list.count, 1);
  assert.equal(report.webcore_he_version, 'v0.3.114.20240115_HE');
  assert.equal(JSON.stringify(report).includes('fixture-secret'), false);
});

test('an explicit empty list stays empty after a live unchanged confirmation', async () => {
  const f = hubFixture();
  f.body.instance.pistons = [];
  const report = await runDiagnostics(f.client);
  assert.equal(report.ok, true);
  assert.equal(report.checks.piston_list.count, 0);
  assert.equal(report.checks.piston_list.confirmed_empty, true);
});

test('malformed keyed lists, singular bodies and duplicate identities never become a partial/zero count', () => {
  for (const data of [
    { instance: { pistons: { p1: null } } },
    { instance: { pistons: { p1: 'fixture-secret' } } },
    { instance: { pistons: 42 }, pistons: [] },
    { instance: { pistons: null } },
    { instance: { pistons: [{ id: 'p1' }] } },
    { instance: { pistons: [{ id: 'p1', n: 'A' }, { id: 'p1', n: 'B' }] } },
    { piston: {} }, { piston: { s: [], v: [] } }
  ]) assert.throws(() => normalizePistonList(data), error => error.code === 'PISTON_LIST_MALFORMED');
  assert.deepEqual(normalizePistonList({ instance: { pistons: {} } }), []);
});

test('diagnostics sanitize untrusted error text, error codes and version values', async () => {
  const f = hubFixture();
  f.body.instance.coreVersion = 'fixture-secret-core';
  f.body.instance.heVersion = 'fixture-secret-HE';
  f.client.listDevices = async () => { throw Object.assign(new Error('fixture-secret-error-text'), { code: 'fixture-secret-error-code' }); };
  const report = await runDiagnostics(f.client);
  assert.equal(report.webcore_version, null);
  assert.equal(report.webcore_he_version, null);
  assert.equal(report.errors[0].code, 'DIAGNOSTIC_ERROR');
  assert.equal(JSON.stringify(report).includes('fixture-secret'), false);
});

test('concurrent non-dashboard metadata cannot replace dashboard response details', async () => {
  let finishDashboard;
  const c = new WebcoreClient(config, async input => {
    if (new URL(input).pathname.endsWith('/load')) {
      return { status: 200, ok: true, headers: new Headers({ 'content-type': 'application/javascript' }), text: () => new Promise(resolve => { finishDashboard = () => resolve(JSON.stringify(snapshot())); }) };
    }
    return new Response('{}', { status: 201, headers: { 'content-type': 'application/json' } });
  });
  const pending = c.getDashboard();
  while (!finishDashboard) await new Promise(resolve => setImmediate(resolve));
  await c.request('/intf/dashboard/refresh');
  finishDashboard();
  await pending;
  assert.equal(c.lastDashboardInfo.status, 200);
  assert.equal(c.lastDashboardInfo.contentType, 'application/javascript');
  assert.equal(c.lastDashboardInfo.path, '/intf/dashboard/load');
});

test('a concurrent success cannot make a failed dashboard transport look successful', async () => {
  let rejectDashboard;
  const c = new WebcoreClient(config, async input => {
    if (new URL(input).pathname.endsWith('/load')) return new Promise((resolve, reject) => { rejectDashboard = reject; });
    return new Response('{}', { status: 201 });
  });
  const pending = c.getDashboard();
  const rejected = assert.rejects(pending, error => error.code === 'NETWORK_ERROR');
  while (!rejectDashboard) await new Promise(resolve => setImmediate(resolve));
  await c.request('/intf/dashboard/refresh');
  rejectDashboard(new Error('fixture-secret-network-url'));
  await rejected;
  assert.equal(c.lastDashboardInfo.status, null);
  assert.equal(c.lastDashboardInfo.parsed, false);
  assert.deepEqual(c.lastDashboardInfo.attempts, [{ attempt: 1, response_kind: 'failed', code: 'NETWORK_ERROR' }]);
  assert.equal(c.dashboardSnapshot, null);
});

test('a truncated response body reports a sanitized network error and discards the snapshot', async () => {
  const f = hubFixture();
  await f.client.getDashboard();
  f.client.fetch = async () => ({ status: 200, ok: true, headers: new Headers(), text: async () => { throw new Error('fixture-secret-body-error'); } });
  await assert.rejects(f.client.getDashboard(), error => error.code === 'NETWORK_ERROR' && !JSON.stringify(error).includes('fixture-secret'));
  assert.equal(f.client.dashboardSnapshot, null);
});
