import { createHash } from 'node:crypto';
import { WebcoreError } from './client.js';

const canonical = value => Array.isArray(value) ? value.map(canonical) : (value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value);
export const hashJson = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export function pistonFingerprint(live) {
  const value = live?.data ?? live;
  if (value && typeof value === 'object' && value.piston) {
    const meta = value.meta ?? {};
    return { meta: Object.fromEntries(['id', 'name', 'author', 'bin', 'category'].filter(k => meta[k] !== undefined).map(k => [k, meta[k]])), piston: value.piston };
  }
  return value;
}
export function assertExpectedRemoteHash(live, expected) {
  if (hashJson(pistonFingerprint(live)) !== expected) throw new WebcoreError('Stale piston: current remote definition differs from the prepared version; prepare the update again.', 'STALE_PISTON');
  return true;
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const bodyKeys = new Set(['o', 'r', 'rn', 'rop', 's', 'v', 'z', 'n', 'cached', '$']);

// Pull/get responses are envelopes. Hubitat setup reads these compact keys at the payload root.
export function normalizePistonDraft(id, proposed) {
  if (!isObject(proposed)) throw new WebcoreError('Piston draft must be a JSON object.', 'INVALID_PISTON_BODY');
  let envelope = proposed;
  let input_format = 'body';
  if (Object.hasOwn(proposed, 'data')) {
    if (!isObject(proposed.data) || !Object.hasOwn(proposed.data, 'piston') || Object.hasOwn(proposed, 'piston') || Object.hasOwn(proposed, 's')) {
      throw new WebcoreError('Expected a single piston body or a pull response containing data.piston.', 'INVALID_PISTON_BODY');
    }
    envelope = proposed.data;
    input_format = 'data.piston';
  } else if (Object.hasOwn(proposed, 'piston')) {
    if (Object.hasOwn(proposed, 's')) throw new WebcoreError('Draft mixes a piston wrapper with body fields.', 'INVALID_PISTON_BODY');
    input_format = 'piston';
  }
  for (const meta of [proposed.meta, envelope.meta]) {
    if (meta?.id !== undefined && meta.id !== id) throw new WebcoreError('The draft metadata ID does not match the target piston.', 'PISTON_IDENTITY_MISMATCH');
  }
  const body = input_format === 'body' ? envelope : envelope.piston;
  if (!isObject(body) || !Array.isArray(body.s)) {
    throw new WebcoreError('Piston body must contain the native webCoRE s statement array. Wrapper metadata or a statements property is not an uploadable body.', 'INVALID_PISTON_BODY');
  }
  if (Object.keys(body).some(key => !bodyKeys.has(key))) throw new WebcoreError('Piston body contains unsupported root fields. Use the compact body returned by webCoRE; do not invent or translate its schema.', 'INVALID_PISTON_BODY');
  for (const key of ['s', 'r', 'v']) {
    if ((key === 's' || Object.hasOwn(body, key)) && (!Array.isArray(body[key]) || body[key].some(item => !isObject(item)))) {
      throw new WebcoreError(`Piston body ${key} must be an array of objects.`, 'INVALID_PISTON_BODY');
    }
  }
  if (body.o !== undefined && !isObject(body.o)) throw new WebcoreError('Piston body o options must be an object.', 'INVALID_PISTON_BODY');
  if (body.rn !== undefined && typeof body.rn !== 'boolean') throw new WebcoreError('Piston body rn must be boolean.', 'INVALID_PISTON_BODY');
  for (const key of ['rop', 'z', 'n']) {
    if (body[key] !== undefined && typeof body[key] !== 'string') throw new WebcoreError(`Piston body ${key} must be a string.`, 'INVALID_PISTON_BODY');
  }
  const payload = structuredClone(body);
  delete payload.cached;
  delete payload.$;
  return { body: payload, input_format };
}

// IDs can be regenerated anywhere in webCoRE's native tree.
const withoutGeneratedIds = value => Array.isArray(value) ? value.map(withoutGeneratedIds)
  : isObject(value) ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== '$').map(([key, item]) => [key, withoutGeneratedIds(item)])) : value;

export const PISTON_BODY_FINGERPRINT_VERSION = 2;
const statementTypes = new Set(['if', 'action', 'while', 'repeat', 'for', 'each', 'switch', 'every', 'do', 'on', 'exit', 'break']);
const comparisonTypes = new Set(['condition', 'restriction', 'event']);
const conditionalStatementTypes = new Set(['if', 'while', 'repeat', 'on']);

function removeGeneratedWarnings(node) {
  if (Array.isArray(node.w) && node.w.every(warning => typeof warning === 'string')) delete node.w;
}

function removeGeneratedSubscription(node) {
  // HE subscribeAll derives ct=c/t and boolean s; older native data can carry
  // the documented local marker. Other values are not silently discarded.
  if (node.ct === 'c' || node.ct === 't') delete node.ct;
  if (typeof node.s === 'boolean' || node.s === 'local') delete node.s;
}

// HE subscribeAll regenerates classification/subscription fields and warnings.
// Follow only native logic positions. Operand/literal objects can contain the same
// names and types; their ct, s and w remain part of the compared definition.
function normalizeLogicAnnotations(body) {
  const statements = nodes => {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (!isObject(node) || !statementTypes.has(node.t)) continue;
      removeGeneratedWarnings(node);
      if (node.t === 'switch') removeGeneratedSubscription(node);
      comparisons(node.r);
      statements(node.s);
      statements(node.e);
      if (conditionalStatementTypes.has(node.t)) comparisons(node.c);
      if (node.t === 'if' && Array.isArray(node.ei)) {
        for (const branch of node.ei) {
          if (!isObject(branch) || (branch.t !== undefined && branch.t !== 'if')) continue;
          comparisons(branch.c);
          statements(branch.s);
        }
      }
      if (node.t === 'switch' && Array.isArray(node.cs)) {
        for (const branch of node.cs) {
          if (isObject(branch) && (branch.t === 's' || branch.t === 'r')) statements(branch.s);
        }
      }
    }
  };
  const comparisons = nodes => {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (!isObject(node) || (!comparisonTypes.has(node.t) && node.t !== 'group')) continue;
      removeGeneratedWarnings(node);
      if (comparisonTypes.has(node.t)) removeGeneratedSubscription(node);
      if (node.t === 'group') {
        comparisons(node.c);
        comparisons(node.r);
      }
      statements(node.ts);
      statements(node.fs);
    }
  };
  statements(body.s);
  comparisons(body.r);
  return body;
}

export function pistonBodyFingerprint(body) {
  return normalizeLogicAnnotations(withoutGeneratedIds({ o: body.o ?? {}, r: body.r ?? [], rn: body.rn ?? false,
    rop: body.rop || 'and', s: body.s, v: body.v ?? [], z: body.z ?? '' }));
}

export function pistonBodySummary(body) {
  return { logic_sections: body.s.length, variables: (body.v ?? []).length, restrictions: (body.r ?? []).length };
}
const collectIds = (value, out = new Set()) => {
  if (Array.isArray(value)) for (const item of value) collectIds(item, out);
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (/^(device|deviceId|device_id|devices)$/i.test(key)) {
        const vals = Array.isArray(item) ? item : [item];
        for (const v of vals) if (typeof v === 'string' || typeof v === 'number') out.add(String(v));
      }
      collectIds(item, out);
    }
  }
  return out;
};

// HE evaluates c/e operands from their parsed exp tree. Display text is not an
// executable expression. Inspect only operand positions, never literal JSON v.
const expressionValueTypes = new Set(['integer', 'long', 'decimal', 'int32', 'int64', 'number', 'float', 'double',
  'boolean', 'bool', 'dynamic', 'string', 'enum', 'phone', 'uri', 'text', 'datetime', 'time', 'date', 'duration', 'operand']);
const directConstantTypes = new Set(['time', 'date', 'datetime']);

function validateExpressionTree(node, path, errors, depth = 0, allowOperator = false) {
  if (depth > 64) { errors.push(`${path}: expression nesting exceeds the supported validation depth.`); return; }
  if (!isObject(node) || typeof node.t !== 'string' || !node.t) {
    errors.push(`${path}: parsed expression must be an object with a native type.`);
    return;
  }
  if (node.err || node.ok === false || node.t === 'error') errors.push(`${path}: parsed expression contains an error; correct it in the webCoRE editor before preparing.`);
  if (node.t === 'expression' || node.t === 'function') {
    if (node.t === 'function' && (typeof node.n !== 'string' || !node.n.trim())) errors.push(`${path}: expression function requires a name.`);
    const items = node.i;
    // HE's parser emits i: [] for empty text. Preserve that native form and
    // zero-argument functions; neither is a missing exp tree.
    if (node.t === 'function' && items === undefined) return;
    if (!Array.isArray(items)) { errors.push(`${path}.i: expression items must be an array.`); return; }
    items.forEach((item, index) => validateExpressionTree(item, `${path}.i[${index}]`, errors, depth + 1, node.t === 'expression'));
  } else if (node.t === 'operator') {
    if (!allowOperator) errors.push(`${path}: expression operator must be inside an expression item list.`);
    if (typeof node.o !== 'string' || !node.o.trim()) errors.push(`${path}: expression operator requires its native o field.`);
  } else if (node.t === 'variable') {
    if (typeof node.x !== 'string' || !node.x.trim()) errors.push(`${path}: expression variable requires its native x field.`);
  } else if (node.t === 'device') {
    const ids = typeof node.id === 'string' ? [node.id] : node.id;
    const hasIds = Array.isArray(ids) && ids.length > 0 && ids.every(id => typeof id === 'string' && id.trim());
    const hasVariable = typeof node.x === 'string' && node.x.trim();
    const alreadyParsed = Array.isArray(node.v);
    if (!hasIds && !hasVariable && !alreadyParsed) errors.push(`${path}: expression device requires a device reference or device variable.`);
  } else if (expressionValueTypes.has(node.t)) {
    if (!Object.hasOwn(node, 'v')) errors.push(`${path}: expression value requires its native v field.`);
  } else if (node.t !== 'error') {
    errors.push(`${path}: unsupported parsed expression type; use the native expression returned by the connected webCoRE editor.`);
  }
}

function validateOperandExpression(operand, path, errors) {
  if (!isObject(operand) || !['c', 'e'].includes(operand.t)) return;
  if (operand.t === 'c' && directConstantTypes.has(operand.vt)) {
    if (!Object.hasOwn(operand, 'c')) errors.push(`${path}.c: time/date constant requires its value.`);
    return;
  }
  if (!isObject(operand.exp) || !Object.keys(operand.exp).length) {
    errors.push(`${path}.exp: native constant/expression operand requires a nonempty parsed exp tree; c/e text alone can cause Null expression on Hubitat.`);
    return;
  }
  validateExpressionTree(operand.exp, `${path}.exp`, errors);
}

function validateNativeOperandPositions(body, errors) {
  const operandFields = ['lo', 'ro', 'ro2', 'to', 'to2', 'wd'];
  const operands = (node, path) => {
    for (const key of operandFields) if (Object.hasOwn(node, key)) validateOperandExpression(node[key], `${path}.${key}`, errors);
  };
  const statements = (nodes, path) => {
    if (!Array.isArray(nodes)) return;
    nodes.forEach((node, index) => {
      if (!isObject(node) || !statementTypes.has(node.t)) return;
      const here = `${path}[${index}]`;
      operands(node, here);
      comparisons(node.r, `${here}.r`);
      statements(node.s, `${here}.s`);
      statements(node.e, `${here}.e`);
      if (conditionalStatementTypes.has(node.t)) comparisons(node.c, `${here}.c`);
      if (node.t === 'action' && Array.isArray(node.k)) {
        node.k.forEach((task, taskIndex) => {
          if (!isObject(task)) return;
          if (task.p !== undefined && !Array.isArray(task.p)) errors.push(`${here}.k[${taskIndex}].p: native command parameters must be an array.`);
          if (Array.isArray(task.p)) task.p.forEach((parameter, parameterIndex) => validateOperandExpression(parameter, `${here}.k[${taskIndex}].p[${parameterIndex}]`, errors));
        });
      }
      if (node.t === 'if' && Array.isArray(node.ei)) node.ei.forEach((branch, branchIndex) => {
        if (!isObject(branch)) return;
        comparisons(branch.c, `${here}.ei[${branchIndex}].c`);
        statements(branch.s, `${here}.ei[${branchIndex}].s`);
      });
      if (node.t === 'switch' && Array.isArray(node.cs)) node.cs.forEach((branch, branchIndex) => {
        if (!isObject(branch)) return;
        operands(branch, `${here}.cs[${branchIndex}]`);
        statements(branch.s, `${here}.cs[${branchIndex}].s`);
      });
    });
  };
  const comparisons = (nodes, path) => {
    if (!Array.isArray(nodes)) return;
    nodes.forEach((node, index) => {
      if (!isObject(node) || (!comparisonTypes.has(node.t) && node.t !== 'group')) return;
      const here = `${path}[${index}]`;
      operands(node, here);
      if (node.t === 'group') {
        comparisons(node.c, `${here}.c`);
        comparisons(node.r, `${here}.r`);
      }
      statements(node.ts, `${here}.ts`);
      statements(node.fs, `${here}.fs`);
    });
  };
  statements(body.s, '$.s');
  comparisons(body.r, '$.r');
  if (Array.isArray(body.v)) body.v.forEach((variable, index) => {
    if (isObject(variable)) validateOperandExpression(variable.v, `$.v[${index}].v`, errors);
  });
}

export function validatePiston(piston, inventory, db = {}) {
  const errors = [];
  if (!piston || typeof piston !== 'object' || Array.isArray(piston)) return ['Piston must be a JSON object.'];
  validateNativeOperandPositions(piston, errors);
  const devices = inventory?.devices ?? inventory ?? {};
  const known = new Set(Object.keys(devices).map(String));
  for (const id of collectIds(piston)) if (!known.has(id)) errors.push(`Unknown webCoRE-authorized device ID: ${id}`);
  const commandDb = db?.commands?.physical ?? db?.commands ?? {};
  const commandNames = new Set(Array.isArray(commandDb) ? commandDb.map(c => c?.n ?? c?.name).filter(Boolean) : Object.keys(commandDb));
  const attrDb = db?.attributes ?? {};
  const attrNames = new Set(Array.isArray(attrDb) ? attrDb.map(a => a?.n ?? a?.name).filter(Boolean) : Object.keys(attrDb));
  const deviceCommands = id => {
    const raw = devices[id]?.c ?? devices[id]?.commands ?? [];
    return new Map((Array.isArray(raw) ? raw : []).map(c => [c?.n ?? c?.name, c]).filter(([name]) => name));
  };
  const deviceAttributes = id => {
    const raw = devices[id]?.a ?? devices[id]?.attributes ?? [];
    return new Map((Array.isArray(raw) ? raw : []).map(a => [a?.n ?? a?.name, a]).filter(([name]) => name));
  };
  const asRefs = value => (Array.isArray(value) ? value : [value]).flatMap(v => {
    if (typeof v === 'string' || typeof v === 'number') return [String(v)];
    if (v && typeof v === 'object') return [v.id, v.deviceId, v.value].filter(x => typeof x === 'string' || typeof x === 'number').map(String);
    return [];
  });
  const validateArgs = (schema, supplied, path) => {
    if (!Array.isArray(schema) || schema.length === 0) return;
    const params = Array.isArray(supplied) ? supplied : (supplied && typeof supplied === 'object' ? supplied : []);
    const valFor = (p, i) => Array.isArray(params) ? params[i] : params[p?.n ?? p?.name];
    schema.forEach((p, i) => {
      const name = p?.n ?? p?.name ?? `argument ${i + 1}`;
      const value = valFor(p, i);
      if ((p?.m === 1 || p?.required === true || String(p?.n ?? '').startsWith('*')) && (value === undefined || value === null || value === '')) errors.push(`${path}: required command parameter is missing: ${String(name).replace(/^\*/, '')}`);
      if (value === undefined || value === null) return;
      const type = String(p?.t ?? p?.type ?? '').toLowerCase();
      if (['integer', 'int', 'number', 'decimal', 'float', 'double'].includes(type) && (typeof value !== 'number' || !Number.isFinite(value))) errors.push(`${path}: parameter ${name} must be numeric.`);
      if (['boolean', 'bool'].includes(type) && typeof value !== 'boolean') errors.push(`${path}: parameter ${name} must be boolean.`);
      const allowed = p?.c ?? p?.constraints ?? p?.allowedValues;
      if (Array.isArray(allowed) && !allowed.includes(value)) errors.push(`${path}: parameter ${name} is outside the allowed values.`);
    });
    if (Array.isArray(params) && params.length > schema.length) errors.push(`${path}: too many command parameters (expected at most ${schema.length}).`);
  };
  const walk = (node, path = '$', inheritedDevices = []) => {
    if (Array.isArray(node)) return node.forEach((item, i) => walk(item, `${path}[${i}]`, inheritedDevices));
    if (!node || typeof node !== 'object') return;
    let refs = inheritedDevices;
    for (const [key, value] of Object.entries(node)) if (/^(device|deviceId|device_id|deviceRef|devices)$/i.test(key)) {
      const found = asRefs(value);
      for (const id of found) if (!known.has(id)) errors.push(`${path}.${key}: unknown webCoRE-authorized device ID: ${id}`);
      if (found.length) refs = found;
    }
    const commandValue = node.command ?? node.commandName;
    const commandName = typeof commandValue === 'string' ? commandValue : (commandValue && typeof commandValue === 'object' ? commandValue.n ?? commandValue.name : undefined);
    if (typeof commandName === 'string') {
      const suppliedOperands = node.arguments ?? node.args ?? node.parameters ?? commandValue?.arguments ?? commandValue?.args ?? commandValue?.p;
      if (Array.isArray(suppliedOperands)) suppliedOperands.forEach((operand, index) => validateOperandExpression(operand, `${path}.arguments[${index}]`, errors));
      for (const id of refs.filter(d => known.has(d))) {
        const cmds = deviceCommands(id);
        if (cmds.size && !cmds.has(commandName)) errors.push(`${path}: device ${id} does not support command ${commandName}.`);
        const schema = cmds.get(commandName)?.p ?? cmds.get(commandName)?.parameters;
        const supplied = node.arguments ?? node.args ?? node.parameters ?? commandValue?.arguments ?? commandValue?.args ?? commandValue?.p;
        validateArgs(schema, supplied, `${path}.command(${commandName})`);
      }
      if (!refs.length && commandNames.size && !commandNames.has(commandName)) errors.push(`${path}: command is absent from live webCoRE command database: ${commandName}`);
    }
    for (const [key, value] of Object.entries(node)) {
      if (/^(attribute|attributeName)$/i.test(key) && typeof value === 'string') {
        const local = refs.filter(d => known.has(d)).flatMap(d => [...deviceAttributes(d).keys()]);
        if (local.length && !refs.some(d => deviceAttributes(d).has(value))) errors.push(`${path}.${key}: selected device does not support attribute ${value}.`);
        else if (!local.length && attrNames.size && !attrNames.has(value)) errors.push(`${path}.${key}: attribute is absent from live webCoRE database: ${value}`);
      }
      walk(value, `${path}.${key}`, refs);
    }
  };
  walk(piston);
  return [...new Set(errors)];
}

export function prepareUpdate(id, live, proposed, inventory, db = {}) {
  let normalized;
  try { normalized = normalizePistonDraft(id, proposed); }
  catch (error) { return { ok: false, id, code: error.code, errors: [error.message] }; }
  const body = normalized.body;
  const errors = validatePiston(body, inventory, db);
  if (errors.length) return { ok: false, id, errors };
  const liveData = live?.data ?? live;
  return { ok: true, id, expected_remote_hash: hashJson(pistonFingerprint(live)), proposed_hash: hashJson(body),
    proposed_body_hash: hashJson(pistonBodyFingerprint(body)), body_fingerprint_version: PISTON_BODY_FINGERPRINT_VERSION,
    payload_format: 'webcore-body', input_format: normalized.input_format,
    body_summary: pistonBodySummary(body), diff: { before: liveData?.piston ?? liveData, after: body }, proposed: body };
}
