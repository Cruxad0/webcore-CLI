#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { loadConfig } from './config.js';
import { WebcoreClient } from './client.js';
import { prepareUpdate } from './piston.js';
import { runDiagnostics } from './diagnostics.js';
import { getVerifiedPiston, PistonSelectionStore } from './selection.js';
import { applyPistonUpdate } from './update.js';
import packageInfo from '../package.json' with { type: 'json' };

const selections = new PistonSelectionStore();

const tools = [
  { name: 'webcore_status', description: 'Check the configured local or explicitly approved Hubitat Cloud connection. Report live webcore_version (coreVersion) and webcore_he_version (heVersion), separately from plugin_version. Call before drafting conditions; do not infer the live webCoRE version from the bundled reference or a screenshot.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'webcore_diagnose', description: 'Run read-only connection, dashboard response, piston-list, and authorized-device checks. Reports the running plugin_version and upload limits so installed/local version mismatches can be identified. Call after a tool error, unexpected empty result, or mismatch with the CLI. It retries empty piston results and returns sanitized status/content-type/error details without endpoint URLs, access tokens, session tokens, piston names, or device IDs. Upload failures also carry request_trace in their error details; do not perform a write just to diagnose it.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'webcore_list_devices', description: 'List devices selected and authorized in this webCoRE instance, with capabilities, attributes, current values, commands and argument constraints.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'webcore_get_device', description: 'Get one authorized device by exact webCoRE device ID or exact name.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } }, additionalProperties: false } },
  { name: 'webcore_list_pistons', description: 'Fetch the current piston list. Call this tool whenever the user asks for a new list or count. Returns an immutable list_id, scope, numbered entries, display_list, and piston_count. Display its exact numbers and order; do not filter, sort, or renumber them yourself. Use scope=active when asked for active pistons. For a follow-up such as select 7, use webcore_select_piston with the ORIGINAL list_id, number and name; do not refresh the list first. If piston_count is 0, verify connection status and call this tool once more. Report zero only for an explicit empty list.', inputSchema: { type: 'object', properties: { scope: { type: 'string', enum: ['all', 'active', 'paused'], description: 'Server-side list filter. Defaults to all.' } }, additionalProperties: false } },
  { name: 'webcore_select_piston', description: 'Open a numbered piston from the exact list previously displayed to the user. Requires the original list_id, one-based number, and expected_name from that same entry. Refreshing or switching scope must never change what an old number means. Stops if the list expired or any name/ID disagrees. Use this tool before announcing the selected name or analyzing a numbered piston; rely on its selected_piston and identity_verified output.', inputSchema: { type: 'object', properties: { list_id: { type: 'string', minLength: 1 }, number: { type: 'integer', minimum: 1 }, expected_name: { type: 'string', minLength: 1 } }, required: ['list_id', 'number', 'expected_name'], additionalProperties: false } },
  { name: 'webcore_get_piston', description: 'Read a piston by its exact ID and expected_name from the original list or user request. Verifies the fetched ID and name before returning a definition. For a numbered choice use webcore_select_piston with the original list_id instead. Do not announce a piston name or analyze it before identity_verified is true.', inputSchema: { type: 'object', properties: { id: { type: 'string', minLength: 1 }, expected_name: { type: 'string', minLength: 1 } }, required: ['id', 'expected_name'], additionalProperties: false } },
  { name: 'webcore_lookup_language', description: 'Fetch the current hub language DB and versions every time; return language_compatibility with db_version, a stable DB hash, changed_fields and persistent reference review warnings. Changes can occur with identical HE labels. A first observation/matching labels never certify compatibility. If reference_requires_review is true, explain the reason and inspect the intended live piston and current operand/comparison definitions before drafting. condition_reference is pinned to core v0.3.114.20220203 / HE v0.3.114.20240115_HE (September 19, 2025); it is not rewritten automatically. Use exact live comparison identifiers and requirements.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'webcore_prepare_piston_update', description: 'Normalize and validate the native webCoRE body against current inventory, returning its diff and body hash plus the live remote hash. Fresh language definitions and versions are checked; inspect language_compatibility and its persistent review warnings before presenting a draft as compatible. Accepts a compact body with s, or a pull/get wrapper containing piston or data.piston; metadata is never uploaded. Rejects missing s or invented descriptive root fields. No write occurs.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, proposed: { type: 'object', description: 'Native webCoRE body with s, or a get/pull wrapper with piston or data.piston. Preserve the native compact schema.' } }, required: ['id', 'proposed'], additionalProperties: false } },
  { name: 'webcore_apply_piston_update', description: 'Validate and upload only the prepared native piston body using URL-bounded requests and stale-hash checks before the final commit. Checks current language definitions/versions again and returns language_compatibility; if a new change requires review, inspect the intended live piston and current definitions before another reviewed edit. ST_SUCCESS confirms acceptance only: applied=true and verified=true require a fresh read-back with matching body hash and piston identity. Use verification.build, verification.active and verification.body_summary for success reports. Empty, altered, malformed or unreadable stored bodies return structured errors even after ST_SUCCESS; accepted=true does not mean verified success or an unchanged piston. Errors include safe upload traces and never automatically replay an accepted write. Never bypass validation or retry without reading the live piston first.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, proposed: { type: 'object', description: 'The prepared body or its original wrapper; only the normalized body is sent to Hubitat.' }, expected_remote_hash: { type: 'string' } }, required: ['id', 'proposed', 'expected_remote_hash'], additionalProperties: false } },
  { name: 'webcore_create_piston', description: 'Create an empty webCoRE piston. This creates a new piston in the Hubitat instance; requires confirm=true after the user approves the name.', inputSchema: { type: 'object', properties: { name: { type: 'string', minLength: 1 }, confirm: { type: 'boolean' } }, required: ['name', 'confirm'], additionalProperties: false } },
  { name: 'webcore_get_activity', description: 'Retrieve piston activity/log trace data from a log cursor.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, log: { type: ['string', 'number'] } }, required: ['id'], additionalProperties: false } },
  { name: 'webcore_test_piston', description: 'Run webCoRE test operation. This may execute real device actions; requires explicit authorize_live_test=true.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, authorize_live_test: { type: 'boolean' } }, required: ['id', 'authorize_live_test'], additionalProperties: false } },
  { name: 'webcore_pause_piston', description: 'Pause a piston.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } },
  { name: 'webcore_resume_piston', description: 'Resume a paused piston.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } }
];

async function invoke(name, a) {
  const config = await loadConfig();
  if (!config) throw new Error('Not configured. First ask whether webCoRE runs on Hubitat and where the local hub is. Find the local execute endpoint at Hubitat > Apps > webCoRE > choose any piston > Test run piston. Prefer local access; only offer the Hubitat Cloud URL as a fallback after explaining it is not local and getting explicit confirmation. Then run `node server/cli.js setup` from the plugin folder.');
  const c = new WebcoreClient(config);
  switch (name) {
    case 'webcore_status': { const r = await c.request('/intf/dashboard/load'); return { connected: true, plugin_version: packageInfo.version, connection_mode: c.config.connectionMode ?? 'local', hub: r.instance?.name ?? null, version: r.instance?.heVersion ?? r.instance?.coreVersion ?? null, webcore_version: r.instance?.coreVersion ?? null, webcore_he_version: r.instance?.heVersion ?? null }; }
    case 'webcore_diagnose': return runDiagnostics(c);
    case 'webcore_list_devices': return { devices: await c.listDevices() };
    case 'webcore_get_device': {
      if (!a.id && !a.name) throw new Error('Provide an exact device id or exact name.');
      const devices = await c.listDevices();
      const found = Object.entries(devices).filter(([id, d]) => a.id ? id === a.id : d.n === a.name);
      if (found.length !== 1) throw new Error(found.length ? `Device name is ambiguous; use one of these IDs: ${found.map(([id]) => id).join(', ')}` : 'No matching webCoRE-authorized device was found.');
      return { id: found[0][0], ...found[0][1] };
    }
    case 'webcore_list_pistons': {
      return selections.list(c, a.scope ?? 'all');
    }
    case 'webcore_select_piston': return selections.select(c, a);
    case 'webcore_get_piston': return getVerifiedPiston(c, a);
    case 'webcore_lookup_language': return c.getLanguageDb();
    case 'webcore_get_activity': return c.getActivity(a.id, a.log ?? 0);
    case 'webcore_test_piston': if (a.authorize_live_test !== true) throw new Error('Live piston testing requires authorize_live_test=true after reviewing the operation.'); else return c.testPiston(a.id);
    case 'webcore_pause_piston': return c.pausePiston(a.id);
    case 'webcore_resume_piston': return c.resumePiston(a.id);
    case 'webcore_create_piston': if (a.confirm !== true) throw new Error('Creating a piston requires confirm=true after the user approves its name.'); else return c.createPiston(a.name);
    case 'webcore_prepare_piston_update': {
      const [live, devices, db] = await Promise.all([c.getPiston(a.id), c.listDevices(), c.getLanguageDb()]);
      return { ...prepareUpdate(a.id, live, a.proposed, devices, db.db ?? db), language_compatibility: db.language_compatibility };
    }
    case 'webcore_apply_piston_update': {
      return applyPistonUpdate(c, a.id, a.proposed, a.expected_remote_hash);
    }
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async line => {
  let req;
  try {
    req = JSON.parse(line);
    if (req.method === 'notifications/initialized' || req.method?.startsWith('notifications/')) return;
    if (req.method === 'initialize') return send({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: req.params?.protocolVersion ?? '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'webcore-cli', version: packageInfo.version } } });
    if (req.method === 'ping') return send({ jsonrpc: '2.0', id: req.id, result: {} });
    if (req.method === 'tools/list') return send({ jsonrpc: '2.0', id: req.id, result: { tools } });
    if (req.method === 'tools/call') {
      const name = req.params?.name;
      const schema = tools.find(t => t.name === name)?.inputSchema;
      const args = req.params?.arguments ?? {};
      if (!schema) throw new Error(`Unknown tool: ${name}`);
      for (const key of schema.required ?? []) if (args[key] === undefined) throw new Error(`Missing required argument: ${key}`);
      for (const key of Object.keys(args)) if (!Object.hasOwn(schema.properties ?? {}, key) && schema.additionalProperties === false) throw new Error(`Unexpected argument: ${key}`);
      for (const [key, value] of Object.entries(args)) {
        const type = schema.properties?.[key]?.type;
        if (type === 'string' && typeof value !== 'string') throw new Error(`${key} must be a string.`);
        if (type === 'integer' && !Number.isInteger(value)) throw new Error(`${key} must be an integer.`);
        if (type === 'boolean' && typeof value !== 'boolean') throw new Error(`${key} must be a boolean.`);
        if (type === 'object' && (!value || typeof value !== 'object' || Array.isArray(value))) throw new Error(`${key} must be an object.`);
        const property = schema.properties?.[key];
        if (property?.enum && !property.enum.includes(value)) throw new Error(`${key} must be one of: ${property.enum.join(', ')}.`);
        if (property?.minimum !== undefined && value < property.minimum) throw new Error(`${key} must be at least ${property.minimum}.`);
        if (property?.minLength !== undefined && (value.trim().length < property.minLength)) throw new Error(`${key} must not be empty.`);
      }
      const result = await invoke(name, args);
      return send({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false } });
    }
    if (req.id !== undefined) send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'Method not found' } });
  } catch (error) {
    if (req?.id !== undefined) {
      const failure = { ok: false, error: { code: error.code ?? 'MCP_TOOL_ERROR', message: error.message, ...(error.details ? { details: error.details } : {}) } };
      send({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: JSON.stringify(failure) }], structuredContent: failure, isError: true } });
    }
  }
});
