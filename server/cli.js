#!/usr/bin/env node
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { readFile } from 'node:fs/promises';
import { parseEndpoint, WebcoreClient } from './client.js';
import { loadConfig, saveConfig, removeConfig, configPath } from './config.js';
import { hashJson, normalizePistonDraft, pistonBodyFingerprint, prepareUpdate } from './piston.js';
import { runDiagnostics } from './diagnostics.js';
import { applyPistonUpdate } from './update.js';
import { verifyPistonUpdate } from './verification.js';
import packageInfo from '../package.json' with { type: 'json' };

const [cmd, ...args] = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const print = value => stdout.write(`${JSON.stringify(value, null, 2)}\n`);
const debugEnabled = args.includes('--debug');
let setupPhase = 'command';
const debug = message => { if (debugEnabled) process.stderr.write(`[debug] ${message}\n`); };
async function confirmCloudAccess() {
  if (!stdin.isTTY) return false;
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = await rl.question('Local access is preferred. Continue with this non-local connection? [y/N] ');
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}
async function promptHidden(label) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') throw new Error('Interactive secret entry needs a terminal. Pass the value explicitly only in a private local session.');
  return new Promise((resolve, reject) => {
    let value = '';
    const restore = () => { stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData); };
    const onData = chunk => {
      for (const char of chunk.toString()) {
        if (char === '\u0003') { restore(); stdout.write('\n'); reject(new Error('Cancelled.')); return; }
        if (char === '\r' || char === '\n') { restore(); stdout.write('\n'); resolve(value.trim()); return; }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1); else value += char;
      }
    };
    stdout.write(label);
    stdin.resume(); stdin.setRawMode(true); stdin.on('data', onData);
  });
}
async function client() {
  const config = await loadConfig();
  if (!config) throw new Error(`Not configured. First run node server/cli.js setup on the computer that can reach Hubitat (config: ${configPath}).`);
  return new WebcoreClient({ ...config, debug: debugEnabled ? debug : undefined });
}
try {
  if (cmd === 'setup' || cmd === 'login') {
    setupPhase = 'starting';
    debug('setup started; endpoint and dashboard password values will be redacted');
    let source = flag('--from-url');
    let pin = flag('--pin');
    if (!source) {
      setupPhase = 'connection_type_prompt';
      debug('asking whether this instance runs on Hubitat');
      const rl = createInterface({ input: stdin, output: stdout });
      const usesHubitat = await rl.question('Does this webCoRE instance run on Hubitat? [y/N] ');
      rl.close();
      if (!/^y(es)?$/i.test(usesHubitat.trim())) throw new Error('This connector currently requires Hubitat-hosted webCoRE. Standalone webCoRE connections are not supported yet.');
      setupPhase = 'endpoint_prompt';
      debug('waiting for the hidden endpoint prompt');
      source = await promptHidden('Local webCoRE endpoint URL (preferred; contains an access token; input hidden): ');
    }
    if (!source) throw new Error('Usage: node server/cli.js login [--from-url <webCoRE endpoint URL>] [--pin <dashboard password>] [--allow-cloud]');
    setupPhase = 'endpoint_validation';
    const endpoint = parseEndpoint(source);
    debug(`endpoint accepted; connection mode=${endpoint.connectionMode}; URL and token omitted`);
    if (endpoint.connectionMode === 'cloud') {
      setupPhase = 'cloud_confirmation';
      stdout.write('WARNING: Hubitat Cloud is not local. Requests pass through cloud.hubitat.com.\n');
      const confirmed = args.includes('--allow-cloud') || await confirmCloudAccess();
      if (!confirmed) throw new Error('Cloud setup cancelled. Use the local webCoRE execute endpoint, or rerun with --allow-cloud only if you accept a non-local Hubitat Cloud connection.');
    }
    if (!pin) {
      setupPhase = 'dashboard_password_prompt';
      debug('waiting for the hidden webCoRE dashboard security password prompt');
      pin = await promptHidden('webCoRE dashboard security password (input hidden): ');
    }
    if (!pin) throw new Error('The webCoRE dashboard security password is required.');
    setupPhase = 'authentication';
    debug(`contacting webCoRE for ${endpoint.connectionMode} authentication; credentials omitted`);
    const c = new WebcoreClient({ ...endpoint, debug: debugEnabled ? debug : undefined });
    const result = await c.authenticate(pin);
    setupPhase = 'saving_credentials';
    debug('webCoRE authentication succeeded; saving credentials to the protected local config');
    await saveConfig({ ...endpoint, securityToken: result.securityToken });
    setupPhase = 'complete';
    debug('setup completed');
    print({ ok: true, authenticated: true, configuration: configPath, credentialsStored: 'local file mode 0600' });
  } else if (cmd === 'logout') {
    await removeConfig(); print({ ok: true, loggedOut: true });
  } else if (cmd === 'status') {
    const c = await client(); const result = await c.getDashboard();
    print({ ok: true, connected: true, dashboard_confirmed: true, snapshot_source: c.lastDashboardInfo.snapshot_source, plugin_version: packageInfo.version, connection_mode: c.config.connectionMode ?? 'local', hub: result.instance?.name ?? null, version: result.instance?.heVersion ?? result.instance?.coreVersion ?? null, webcore_version: result.instance?.coreVersion ?? null, webcore_he_version: result.instance?.heVersion ?? null });
  } else if (cmd === 'diagnose') {
    const c = await client(); print(await runDiagnostics(c));
  } else if (cmd === 'language') {
    const c = await client(); print(await c.getLanguageDb());
  } else if (cmd === 'devices') {
    const c = await client(); print({ devices: await c.listDevices() });
  } else if (cmd === 'pistons') {
    const c = await client(); const pistons = await c.listPistons();
    print({ piston_count: pistons.length, pistons, source: 'webCoRE dashboard' });
  } else if (cmd === 'pull') {
    const id = args[0]; if (!id) throw new Error('Usage: pull <piston-id>');
    const c = await client(); print(await c.getPiston(id));
  } else if (cmd === 'activity') {
    const id = args[0]; if (!id) throw new Error('Usage: activity <piston-id> [log-cursor]');
    const c = await client(); print(await c.getActivity(id, args[1] ?? 0));
  } else if (cmd === 'create') {
    const name = args[0]; if (!name || !args.includes('--confirm-create')) throw new Error('A new piston changes Hubitat. Usage: create <name> --confirm-create after approving the name.');
    const c = await client(); print(await c.createPiston(name));
  } else if (cmd === 'prepare') {
    const id = args[0], path = args[1]; if (!id || !path) throw new Error('Usage: prepare <piston-id> <proposed.json>');
    const c = await client(); const [live, inventory, db, proposed] = await Promise.all([c.getPiston(id), c.listDevices(), c.getLanguageDb(), readFile(path, 'utf8').then(JSON.parse)]);
    const result = { ...prepareUpdate(id, live, proposed, inventory, db.db ?? db), language_compatibility: db.language_compatibility };
    print(result); if (!result.ok) process.exitCode = 2;
  } else if (cmd === 'apply') {
    const id = args[0], path = args[1], expected = flag('--expected-hash');
    if (!id || !path || !expected || !args.includes('--confirm-apply')) throw new Error('Usage: apply <piston-id> <proposed.json> --expected-hash <hash> --confirm-apply after reviewing the prepared diff.');
    const c = await client(); const proposed = JSON.parse(await readFile(path, 'utf8'));
    print(await applyPistonUpdate(c, id, proposed, expected, { expectedBodyHash: flag('--expected-body-hash'), expectedProposedHash: flag('--expected-proposed-hash') }));
  } else if (cmd === 'verify') {
    const id = args[0], path = args[1] && !args[1].startsWith('--') ? args[1] : undefined;
    const expectedName = flag('--expected-name');
    if (!id || !expectedName || !path && !flag('--expected-body-hash')) throw new Error('Usage: verify <piston-id> [original-proposed.json] --expected-name <name> [--expected-body-hash <proposed_body_hash from prepare>]. This only reads the stored definition.');
    const c = await client();
    const body = path ? normalizePistonDraft(id, JSON.parse(await readFile(path, 'utf8'))).body : undefined;
    const expectedHash = flag('--expected-body-hash') ?? hashJson(pistonBodyFingerprint(body));
    print(await verifyPistonUpdate(c, { id, expected_name: expectedName, expected_body_hash: expectedHash }, { expectedBody: body }));
  } else if (cmd === 'test') {
    if (!args[0] || !args.includes('--authorize-live-test')) throw new Error('A live test can run devices; pass --authorize-live-test only after reviewing the piston and authorizing this test.');
    const c = await client(); print(await c.testPiston(args[0]));
  } else {
    stdout.write('webCoRE CLI\nCommands: setup [--debug], login [--from-url <URL>] [--pin <dashboard password>] [--allow-cloud], logout, status, diagnose, language, devices, pistons, pull <id>, prepare <id> <file>, apply <id> <file> --expected-hash <remote-hash> [--expected-body-hash <prepared-body-hash>] [--expected-proposed-hash <prepared-upload-hash>] --confirm-apply, verify <id> [original-proposed.json] --expected-name <name> [--expected-body-hash <prepared-body-hash>], activity <id>, create <name> --confirm-create, test <id> --authorize-live-test\n');
  }
} catch (error) {
  if (debugEnabled && (cmd === 'setup' || cmd === 'login')) debug(`setup failed during ${setupPhase}; error code=${error.code ?? 'CLI_ERROR'}; error details may be shared without credentials`);
  process.stderr.write(`${JSON.stringify({ error: error.message, code: error.code ?? 'CLI_ERROR', ...(error.details ? { details: error.details } : {}) })}\n`);
  process.exitCode = 1;
}
