import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

test('CLI/MCP status, diagnose, language and listing survive HE now-only responses and configuration changes', async t => {
  const sessions = new Map();
  const rows = Array.from({ length: 20 }, (_, i) => ({ id: `fixture-piston-${i}`, n: `Fixture piston ${i}`, meta: { a: i < 11 } }));
  const devices = Object.fromEntries(Array.from({ length: 49 }, (_, i) => [`fixture-device-${i}`, { n: `Fixture device ${i}` }]));
  const body = { instance: { pistons: rows, coreVersion: 'v0.3.114.20220203', heVersion: 'v0.3.114.20240115_HE' } };
  let loads = 0, unchanged = 0, invalidToken = false;
  const hub = createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    const send = data => { res.setHeader('content-type', 'application/javascript'); res.end(`null(${JSON.stringify(data)})`); };
    if (url.pathname.endsWith('/load')) {
      loads++;
      if (invalidToken) return send({ error: 'ERR_INVALID_TOKEN' });
      const session = url.searchParams.get('session') ?? 'default';
      const serialized = JSON.stringify(body);
      const cached = sessions.get(session) === serialized;
      sessions.set(session, serialized);
      if (cached) unchanged++;
      return send(cached ? { now: Date.now() } : body);
    }
    if (url.pathname.endsWith('/getDb')) return send({ dbVersion: 'v0.3.114.20240115_HE', db: { attributes: { switch: { t: 'string' } } } });
    if (url.pathname.endsWith('/devices')) return send({ devices, complete: true });
    if (url.pathname.endsWith('/refresh')) return send({});
    res.statusCode = 404;
    send({});
  });
  hub.listen(0, '127.0.0.1');
  await once(hub, 'listening');
  const temp = await mkdtemp(join(tmpdir(), 'webcore-dashboard-mcp-'));
  await mkdir(join(temp, 'webcore-toolkit'));
  const configuration = { baseUrl: `http://127.0.0.1:${hub.address().port}/apps/api/17`, accessToken: 'fixture-secret-access', securityToken: 'fixture-secret-session' };
  const configPath = join(temp, 'webcore-toolkit/config.json');
  await writeFile(configPath, JSON.stringify(configuration));
  const env = { ...process.env, XDG_CONFIG_HOME: temp };
  const cli = fileURLToPath(new URL('../server/cli.js', import.meta.url));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server/index.js', import.meta.url))], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 0;
  lines.on('line', line => { const message = JSON.parse(line); pending.get(message.id)?.(message.result); });
  const call = (name, args = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Fixture MCP timeout: ${name}`)); }, 5000);
    pending.set(id, result => { clearTimeout(timer); pending.delete(id); resolve(result); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  });
  t.after(async () => {
    const exited = once(child, 'exit');
    child.stdin.end();
    const kill = setTimeout(() => child.kill(), 1000);
    await exited;
    clearTimeout(kill);
    lines.close();
    hub.closeAllConnections();
    await new Promise(resolve => hub.close(resolve));
    await rm(temp, { recursive: true, force: true });
  });

  const listed = (await call('webcore_list_pistons')).structuredContent;
  assert.equal(listed.piston_count, 20);
  assert.equal(listed.active_count, 11);
  const status = (await call('webcore_status')).structuredContent;
  assert.equal(status.webcore_he_version, body.instance.heVersion);
  assert.equal(status.snapshot_source, 'hub_confirmed_unchanged');
  const diagnosis = (await call('webcore_diagnose')).structuredContent;
  assert.equal(diagnosis.ok, true);
  assert.equal(diagnosis.checks.piston_list.count, 20);
  assert.equal(diagnosis.checks.authorized_devices.count, 49);
  assert.equal(JSON.stringify(diagnosis).includes('fixture-secret'), false);
  const language = (await call('webcore_lookup_language')).structuredContent;
  assert.equal(language.language_compatibility.live.webcore_he_version, body.instance.heVersion);
  assert.equal(sessions.size, 1);

  const concurrent = await Promise.all(Array.from({ length: 5 }, () => call('webcore_list_pistons', { scope: 'active' })));
  assert.ok(concurrent.every(result => !result.isError && result.structuredContent.piston_count === 11));
  assert.equal(sessions.size, 1);
  assert.ok(unchanged >= 8);
  assert.equal(loads, 9);

  // A changed local configuration must create a separate client/session and
  // cannot keep an old token's in-memory snapshot or request context.
  configuration.securityToken = 'fixture-secret-replacement-session';
  await writeFile(configPath, JSON.stringify(configuration));
  const reconfigured = (await call('webcore_status')).structuredContent;
  assert.equal(reconfigured.snapshot_source, 'hub_snapshot');
  assert.equal(sessions.size, 2);
  invalidToken = true;
  const failed = await call('webcore_list_pistons');
  assert.equal(failed.isError, true);
  assert.equal(failed.structuredContent.error.code, 'ERR_INVALID_TOKEN');
  assert.equal(failed.structuredContent.piston_count, undefined);
  invalidToken = false;
  assert.equal((await call('webcore_list_pistons')).structuredContent.piston_count, 20);

  const execute = promisify(execFile);
  for (const command of ['status', 'pistons', 'diagnose']) {
    const result = JSON.parse((await execute(process.execPath, [cli, command], { env })).stdout);
    if (command === 'status') assert.equal(result.webcore_he_version, body.instance.heVersion);
    if (command === 'pistons') assert.equal(result.piston_count, 20);
    if (command === 'diagnose') assert.equal(result.checks.piston_list.count, 20);
  }
});
