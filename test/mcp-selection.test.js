import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

test('MCP preserves original #7 across refresh and returns structured identity errors', async t => {
  let records = [
    ...Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, name: `A${i + 1}`, meta: { a: true } })),
    { id: 'day', name: 'Daytime Lights - V2', meta: { a: true } },
    { id: 'dryer', name: 'Dryer Notification', meta: { a: true } }
  ];
  const fetched = [];
  const hub = createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture');
    res.setHeader('content-type', 'application/javascript;charset=utf-8');
    if (url.pathname.endsWith('/load')) return res.end(`null(${JSON.stringify({ instance: { pistons: records } })})`);
    if (url.pathname.endsWith('/piston/get')) {
      const id = url.searchParams.get('id');
      fetched.push(id);
      const record = records.find(item => item.id === id);
      return res.end(JSON.stringify({ data: { meta: { id, name: record.name }, piston: { statements: [] } } }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
  hub.listen(0, '127.0.0.1');
  await once(hub, 'listening');
  const temp = await mkdtemp(join(tmpdir(), 'webcore-mcp-selection-'));
  const configDir = join(temp, 'webcore-toolkit');
  await mkdir(configDir);
  await writeFile(join(configDir, 'config.json'), JSON.stringify({
    baseUrl: `http://127.0.0.1:${hub.address().port}/apps/api/17`,
    accessToken: 'fixture-access', securityToken: 'fixture-session', connectionMode: 'local'
  }));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server/index.js', import.meta.url))], {
    env: { ...process.env, XDG_CONFIG_HOME: temp }, stdio: ['pipe', 'pipe', 'pipe']
  });
  let requestId = 0;
  let stderr = '';
  const pending = new Map();
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const response = JSON.parse(line);
    pending.get(response.id)?.(response.result);
  });
  const call = (name, args) => new Promise((resolve, reject) => {
    const id = ++requestId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP call timed out: ${name}; ${stderr}`)); }, 5000);
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

  const original = (await call('webcore_list_pistons', { scope: 'active' })).structuredContent;
  assert.equal(original.entries[6].name, 'Daytime Lights - V2');
  records = records.map(item => item.id === 'day' ? { ...item, meta: { a: false } } : item).reverse();
  const refreshed = (await call('webcore_list_pistons', { scope: 'active' })).structuredContent;
  assert.equal(refreshed.entries[6].name, 'Dryer Notification');
  const selected = await call('webcore_select_piston', { list_id: original.list_id, number: 7, expected_name: 'Daytime Lights - V2' });
  assert.equal(selected.isError, false);
  assert.equal(selected.structuredContent.selected_piston.id, 'day');
  const mismatch = await call('webcore_select_piston', { list_id: refreshed.list_id, number: 7, expected_name: 'Daytime Lights - V2' });
  assert.equal(mismatch.isError, true);
  assert.equal(mismatch.structuredContent.error.code, 'SELECTION_NAME_MISMATCH');
  assert.equal(mismatch.structuredContent.data, undefined);
  assert.deepEqual(fetched, ['day']);
  const wrongIdentity = await call('webcore_get_piston', { id: 'dryer', expected_name: 'Daytime Lights - V2' });
  assert.equal(wrongIdentity.structuredContent.error.code, 'PISTON_IDENTITY_MISMATCH');
  const invalidNumber = await call('webcore_select_piston', { list_id: original.list_id, number: 7.5, expected_name: 'Daytime Lights - V2' });
  assert.equal(invalidNumber.isError, true);
  assert.match(invalidNumber.structuredContent.error.message, /integer/);
});
