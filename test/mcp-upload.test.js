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

const execute = promisify(execFile);

test('CLI and MCP prepare nested drafts and apply through bounded chunk URLs using the same validator', async t => {
  const base = { meta: { id: 'pid', name: 'Dryer Notification', build: 26, active: true }, piston: { o: {}, r: [], rn: false, rop: 'and', s: [], v: [], z: '' } };
  const draft = { ...base, piston: { ...base.piston, s: [{ devices: ['d1'], tasks: [{ command: 'on', arguments: [] }] }], z: 'X'.repeat(6000) } };
  let current = structuredClone(base);
  let staged;
  let commits = 0;
  let oversized = 0;
  let saveEmpty = false;
  const uploadedBodies = [];
  const commit = encoded => {
    const body = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    // Emulate Hubitat setup: only compact body-root keys are persisted, even for ST_SUCCESS.
    uploadedBodies.push(body);
    current = { meta: { ...current.meta, build: current.meta.build + 1 }, piston: {
      o: body.o ?? {}, r: body.r ?? [], rn: body.rn ?? false, rop: body.rop || 'and',
      s: saveEmpty ? [] : body.s ?? [], v: saveEmpty ? [] : body.v ?? [], z: body.z ?? ''
    } };
    commits++;
  };
  const hub = createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture');
    const send = body => res.end(`null(${JSON.stringify(body)})`);
    res.setHeader('content-type', 'application/javascript;charset=utf-8');
    if (Buffer.byteLength(req.url) > 2048) { oversized++; res.statusCode = 414; return send({}); }
    if (url.pathname.endsWith('/piston/get')) return send({ data: current });
    if (url.pathname.endsWith('/piston/getDb')) return send({ dbVersion: 'v0.3.114.20240115_HE', db: { commands: { physical: { on: { n: 'on' } } } } });
    if (url.pathname.endsWith('/dashboard/load')) return send({ instance: { coreVersion: 'v0.3.114.20220203', heVersion: 'v0.3.114.20240115_HE' } });
    if (url.pathname.endsWith('/devices')) return send({ devices: { d1: { n: 'Lamp', c: [{ n: 'on', p: [] }], a: [{ n: 'switch' }] } }, complete: true });
    if (url.pathname.endsWith('/refresh')) return send({ d1: { switch: 'off' } });
    if (url.pathname.endsWith('/set.start')) {
      staged = Array(Number(url.searchParams.get('chunks')));
      return send({ status: 'ST_READY' });
    }
    if (url.pathname.endsWith('/set.chunk')) {
      const data = url.searchParams.get('data');
      assert.ok(data.length <= 1500);
      staged[Number(url.searchParams.get('chunk'))] = data;
      return send({ status: 'ST_READY' });
    }
    if (url.pathname.endsWith('/set.end')) {
      commit(staged.join(''));
      return send({ status: 'ST_SUCCESS' });
    }
    if (url.pathname.endsWith('/set')) {
      commit(url.searchParams.get('data'));
      return send({ status: 'ST_SUCCESS' });
    }
    res.statusCode = 404;
    send({});
  });
  hub.listen(0, '127.0.0.1');
  await once(hub, 'listening');
  const temp = await mkdtemp(join(tmpdir(), 'webcore-upload-'));
  const configDir = join(temp, 'webcore-toolkit');
  await mkdir(configDir);
  await writeFile(join(configDir, 'config.json'), JSON.stringify({
    baseUrl: `http://127.0.0.1:${hub.address().port}/apps/api/17`, accessToken: 'fixture-access-secret', securityToken: 'fixture-session-secret'
  }));
  const file = join(temp, 'draft.json');
  await writeFile(file, JSON.stringify(draft));
  const env = { ...process.env, XDG_CONFIG_HOME: temp };
  const cli = fileURLToPath(new URL('../server/cli.js', import.meta.url));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server/index.js', import.meta.url))], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let requestId = 0;
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const response = JSON.parse(line);
    pending.get(response.id)?.(response.result);
  });
  const call = (name, args) => new Promise((resolve, reject) => {
    const id = ++requestId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP call timed out: ${name}`)); }, 5000);
    pending.set(id, result => { clearTimeout(timer); pending.delete(id); resolve(result); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  });
  t.after(async () => {
    const exit = once(child, 'exit');
    child.stdin.end();
    const kill = setTimeout(() => child.kill(), 1000);
    await exit;
    clearTimeout(kill);
    lines.close();
    hub.closeAllConnections();
    await new Promise(resolve => hub.close(resolve));
    await rm(temp, { recursive: true, force: true });
  });

  const preparedCli = JSON.parse((await execute(process.execPath, [cli, 'prepare', 'pid', file], { env })).stdout);
  assert.equal(preparedCli.ok, true);
  assert.equal(preparedCli.language_compatibility.observation_status, 'first_observation');
  assert.equal(preparedCli.language_compatibility.compatibility_verified, false);
  const appliedCli = await execute(process.execPath, [cli, 'apply', 'pid', file, '--expected-hash', preparedCli.expected_remote_hash, '--confirm-apply', '--debug'], { env });
  const savedCli = JSON.parse(appliedCli.stdout);
  assert.equal(savedCli.applied, true);
  assert.equal(savedCli.result.status, 'ST_SUCCESS');
  assert.equal(savedCli.result.upload.mode, 'chunked');
  assert.equal(savedCli.verified, true);
  assert.equal(savedCli.verification.build, 27);
  assert.equal(savedCli.language_compatibility.observation_status, 'unchanged');
  assert.equal(savedCli.language_compatibility.live.language_hash, preparedCli.language_compatibility.live.language_hash);
  assert.deepEqual(current.piston, draft.piston);
  assert.deepEqual(uploadedBodies[0], draft.piston);
  assert.match(appliedCli.stderr, /upload path=.*set.chunk/);
  assert.equal(appliedCli.stderr.includes('secret'), false);

  current = structuredClone(base);
  const preparedMcp = (await call('webcore_prepare_piston_update', { id: 'pid', proposed: draft })).structuredContent;
  assert.equal(preparedMcp.ok, true);
  const lookupMcp = (await call('webcore_lookup_language', {})).structuredContent;
  assert.equal(lookupMcp.condition_reference.reference_status, 'unverified');
  assert.equal(lookupMcp.language_compatibility.live.language_hash, preparedMcp.language_compatibility.live.language_hash);
  const savedMcp = await call('webcore_apply_piston_update', { id: 'pid', proposed: draft, expected_remote_hash: preparedMcp.expected_remote_hash });
  assert.equal(savedMcp.isError, false);
  assert.equal(savedMcp.structuredContent.result.status, 'ST_SUCCESS');
  assert.equal(savedMcp.structuredContent.result.upload.mode, 'chunked');
  assert.equal(savedMcp.structuredContent.verified, true);
  assert.equal(savedMcp.structuredContent.verification.build, 27);
  assert.equal(savedMcp.structuredContent.language_compatibility.observation_status, 'unchanged');
  assert.deepEqual(current.piston, draft.piston);
  assert.deepEqual(uploadedBodies[1], draft.piston);
  assert.equal(commits, 2);
  assert.equal(oversized, 0);
  assert.equal(JSON.stringify(savedMcp).includes('secret'), false);

  const invalid = structuredClone(draft);
  invalid.piston.s[0].tasks[0].command = 'turnBlue';
  const refused = await call('webcore_apply_piston_update', { id: 'pid', proposed: invalid, expected_remote_hash: (await call('webcore_prepare_piston_update', { id: 'pid', proposed: draft })).structuredContent.expected_remote_hash });
  assert.equal(refused.isError, true);
  assert.equal(refused.structuredContent.error.code, 'VALIDATION_ERROR');
  assert.equal(refused.structuredContent.error.details.language_compatibility.compatibility_verified, false);
  assert.equal(commits, 2);

  // Both entry points must refuse to report success when Hubitat accepts an empty body.
  saveEmpty = true;
  const hash = (await call('webcore_prepare_piston_update', { id: 'pid', proposed: draft })).structuredContent.expected_remote_hash;
  const emptyMcp = await call('webcore_apply_piston_update', { id: 'pid', proposed: draft, expected_remote_hash: hash });
  assert.equal(emptyMcp.isError, true);
  assert.equal(emptyMcp.structuredContent.error.code, 'PISTON_READBACK_MISMATCH');
  assert.equal(emptyMcp.structuredContent.error.details.accepted, true);
  assert.equal(emptyMcp.structuredContent.error.details.applied, false);
  assert.equal(emptyMcp.structuredContent.error.details.stored_body_summary.logic_sections, 0);
  const emptyCliPrepared = JSON.parse((await execute(process.execPath, [cli, 'prepare', 'pid', file], { env })).stdout);
  await assert.rejects(execute(process.execPath, [cli, 'apply', 'pid', file, '--expected-hash', emptyCliPrepared.expected_remote_hash, '--confirm-apply'], { env }), error => {
    assert.equal(error.code, 1);
    assert.equal(error.stdout, '');
    const failure = JSON.parse(error.stderr);
    assert.equal(failure.code, 'PISTON_READBACK_MISMATCH');
    assert.equal(failure.details.applied, false);
    return true;
  });
  assert.equal(commits, 4);
  assert.equal(oversized, 0);
});
