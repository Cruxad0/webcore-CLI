import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('portable plugin and stdio MCP manifests parse and point inside the package', async () => {
  const plugin = JSON.parse(await readFile(new URL('../plugin.json', import.meta.url), 'utf8'));
  const mcp = JSON.parse(await readFile(new URL('../mcp.json', import.meta.url), 'utf8'));
  const compatibility = JSON.parse(await readFile(new URL('../.codex-plugin/plugin.json', import.meta.url), 'utf8'));
  assert.equal(plugin.name, 'webcore-cli');
  const packageInfo = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(plugin.version, '0.4.7');
  assert.equal(packageInfo.version, plugin.version);
  assert.equal(plugin.extensions['com.openai'].interface.displayName, 'webCoRE CLI');
  assert.ok(plugin.extensions['com.openai'].interface.shortDescription.length <= 30);
  assert.equal(compatibility.name, plugin.name);
  assert.equal(compatibility.version, plugin.version);
  assert.equal(compatibility.interface.defaultPrompt, plugin.extensions['com.openai'].interface.defaultPrompt);
  assert.match(compatibility.interface.defaultPrompt, /parsed exp tree/);
  assert.equal(mcp.mcpServers.webcore.type, 'stdio');
  assert.equal(mcp.mcpServers.webcore.command, 'node');
  assert.equal(mcp.mcpServers.webcore.args[0], '${PLUGIN_ROOT}/server/index.js');
});
