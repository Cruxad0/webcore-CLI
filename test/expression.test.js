import test from 'node:test';
import assert from 'node:assert/strict';
import { hashJson, pistonFingerprint, prepareUpdate, validatePiston } from '../server/piston.js';
import { applyPistonUpdate } from '../server/update.js';
import conditionReference from '../server/schema-reference.json' with { type: 'json' };

const message = () => ({ t: 'c', vt: 'string', c: 'Fixture message',
  exp: { t: 'expression', i: [{ t: 'string', v: 'Fixture message' }] } });
const action = parameter => ({ t: 'action', d: [], k: [{ c: 'sendPushNotification', p: [parameter] }] });
const body = parameter => ({ s: [action(parameter)], v: [] });
const errorsFor = parameter => validatePiston(body(parameter), {});

test('language lookup reference examples include valid parsed expressions', () => {
  for (const parameter of Object.values(conditionReference.operand_examples)) assert.deepEqual(errorsFor(parameter), []);
  assert.deepEqual(validatePiston({ s: [{ t: 'if', c: [conditionReference.condition_example], s: [] }] }, {}), []);
  assert.deepEqual(conditionReference.expression_operands.direct_constant_exceptions, ['time', 'date', 'datetime']);
});

test('native device and virtual notification parameters require exp, never just editable text', () => {
  for (const command of ['deviceNotification', 'sendPushNotification', 'sendNotificationToContacts']) {
    const draft = body({ t: 'c', vt: 'string', c: 'Fixture message' });
    draft.s[0].k[0].c = command;
    const before = structuredClone(draft);
    const errors = validatePiston(draft, {});
    assert.equal(errors.length, 1);
    assert.match(errors[0], /\$\.s\[0\]\.k\[0\]\.p\[0\]\.exp.*Null expression/);
    assert.deepEqual(draft, before);
  }
  assert.match(errorsFor({ t: 'e', e: 'Fixture expression' })[0], /\.exp/);
});

test('valid constants, calculated expressions and engine-cleaned operands retain native metadata', () => {
  const values = [message(), { t: 'c', vt: 'integer', c: 0, exp: { t: 'integer', v: 0 } },
    { t: 'c', vt: 'boolean', c: false, exp: { t: 'boolean', v: false } },
    { t: 'e', exp: { t: 'expression', i: [{ t: 'string', v: 'Value: ' }, { t: 'operator', o: '+' },
      { t: 'variable', x: 'value' }] } },
    { t: 'e', exp: { t: 'function', n: 'round', i: [{ t: 'expression', i: [{ t: 'decimal', v: 1.5 }] }] } },
    { t: 'e', exp: { t: 'function', n: 'now' } },
    { t: 'e', exp: { t: 'function', n: 'now', i: [] } },
    { t: 'e', exp: { t: 'device', id: 'fixture-device', a: 'temperature' } },
    { t: 'e', exp: { t: 'device', x: 'devices', a: 'temperature' } },
    { t: 'e', exp: { t: 'device', v: [], a: 'temperature' } }];
  for (const parameter of values) {
    const draft = body(parameter), before = structuredClone(draft);
    const prepared = prepareUpdate('pid', { data: { piston: { s: [] } } }, draft, {});
    assert.equal(prepared.ok, true, JSON.stringify(prepared.errors));
    assert.deepEqual(prepared.proposed, before);
    assert.deepEqual(draft, before);
  }
});

test('native empty text, null values, and optional nothing-selected operands remain valid', () => {
  for (const parameter of [{ t: 'c', vt: 'string', c: '', exp: { t: 'expression', i: [], str: '', ok: true } },
    { t: 'c', vt: 'string', exp: { t: 'string', v: '' } },
    { t: 'e', exp: { t: 'dynamic', v: null } }, { t: '', vt: 'string' }, { t: 'x', x: 'message' }]) {
    assert.deepEqual(errorsFor(parameter), []);
  }
});

test('date/time constants use direct c but numeric durations still require exp', () => {
  for (const vt of ['time', 'date', 'datetime']) {
    assert.deepEqual(errorsFor({ t: 'c', vt, c: 0 }), []);
    assert.match(errorsFor({ t: 'c', vt })[0], /\.c: time\/date constant requires its value/);
    assert.match(errorsFor({ t: 'e', vt, e: 'now()' })[0], /\.exp/);
  }
  for (const vt of ['integer', 'decimal', 'boolean', 'string', 's', 'm', 'h', 'ms']) {
    assert.match(errorsFor({ t: 'c', vt, c: 5 })[0], /\.exp/);
  }
});

test('missing, nonobject and malformed parsed trees fail with paths, without literal/parser error values', () => {
  const malformed = [undefined, null, [], {}, 'Fixture private text', { i: [] },
    { t: 'expression' }, { t: 'expression', i: {} }, { t: 'expression', i: [null] },
    { t: 'string' }, { t: 'function' }, { t: 'function', n: 'round', i: {} },
    { t: 'function', n: 'round', i: [{ t: 'operator', o: '+' }] },
    { t: 'variable', x: '' }, { t: 'device', id: [] },
    { t: 'operator', o: '+' }, { t: 'expression', i: [{ t: 'operator' }] },
    { t: 'invented', v: 'Fixture private text' },
    { t: 'expression', i: [], err: 'Fixture private text' },
    { t: 'string', v: 'Fixture private text', ok: false },
    { t: 'error', v: 'Fixture private text' }];
  for (const exp of malformed) {
    const errors = errorsFor({ t: 'e', e: 'Fixture private text', exp });
    assert.ok(errors.length > 0);
    assert.ok(errors.every(error => error.startsWith('$.s[0].k[0].p[0].exp')));
    assert.equal(JSON.stringify(errors).includes('Fixture private text'), false);
  }
});

test('nested parser errors and excessive expression depth are rejected without a validator crash', () => {
  assert.match(errorsFor({ t: 'e', exp: { t: 'expression', i: [{ t: 'function', n: 'round', i: [
    { t: 'expression', i: [{ t: 'decimal', v: 1.5, err: 'Fixture private text' }] }
  ] }] } })[0], /\.i\[0\]\.i\[0\]\.i\[0\]: parsed expression contains an error/);
  let exp = { t: 'string', v: 'Fixture message' };
  for (let i = 0; i < 66; i++) exp = { t: 'expression', i: [exp] };
  assert.match(errorsFor({ t: 'e', exp })[0], /nesting exceeds/);
});

test('operand fields in native comparisons and statements are checked, including timing', () => {
  for (const field of ['lo', 'ro', 'ro2', 'to', 'to2', 'wd']) {
    for (const t of ['condition', 'restriction', 'event']) {
      const draft = { s: [{ t: 'if', c: [{ t, [field]: { t: 'c', vt: 'string', c: 'Fixture message' } }] }] };
      assert.match(validatePiston(draft, {})[0], new RegExp(`\\$\\.s\\[0\\]\\.c\\[0\\]\\.${field}\\.exp`));
    }
    const draft = { s: [{ t: 'every', [field]: { t: 'e', e: 'Fixture expression' } }] };
    assert.match(validatePiston(draft, {})[0], new RegExp(`\\$\\.s\\[0\\]\\.${field}\\.exp`));
  }
});

test('nested branches, true/false actions, switch cases, restrictions and variable initializers are checked', () => {
  const broken = { t: 'c', vt: 'string', c: 'Fixture message' };
  const cases = [
    [{ s: [{ t: 'if', ei: [{ c: [], s: [action(broken)] }] }] }, '$.s[0].ei[0].s[0].k[0].p[0].exp'],
    [{ s: [{ t: 'if', e: [action(broken)] }] }, '$.s[0].e[0].k[0].p[0].exp'],
    [{ s: [{ t: 'while', c: [{ t: 'group', c: [{ t: 'condition', ts: [action(broken)] }] }] }] }, '$.s[0].c[0].c[0].ts[0].k[0].p[0].exp'],
    [{ s: [{ t: 'repeat', c: [{ t: 'condition', fs: [action(broken)] }] }] }, '$.s[0].c[0].fs[0].k[0].p[0].exp'],
    [{ s: [{ t: 'switch', cs: [{ t: 's', ro: broken, s: [action(message())] }] }] }, '$.s[0].cs[0].ro.exp'],
    [{ s: [{ t: 'switch', cs: [{ t: 's', s: [action(broken)] }] }] }, '$.s[0].cs[0].s[0].k[0].p[0].exp'],
    [{ s: [{ t: 'do', s: [action(broken)] }] }, '$.s[0].s[0].k[0].p[0].exp'],
    [{ s: [], r: [{ t: 'group', r: [{ t: 'restriction', ro: broken }] }] }, '$.r[0].r[0].ro.exp'],
    [{ s: [{ t: 'if', r: [{ t: 'restriction', ro: broken }] }] }, '$.s[0].r[0].ro.exp'],
    [{ s: [], v: [{ n: 'message', t: 'string', v: broken }] }, '$.v[0].v.exp']
  ];
  for (const [draft, path] of cases) assert.ok(validatePiston(draft, {}).some(error => error.startsWith(path)), path);
});

test('native command parameters must be arrays and descriptive command operands use the same guard', () => {
  const draft = body(message());
  draft.s[0].k[0].p = { text: message() };
  assert.match(validatePiston(draft, {})[0], /\.p: native command parameters must be an array/);
  for (const key of ['arguments', 'args', 'parameters']) {
    assert.match(validatePiston({ s: [{ command: 'deviceNotification', [key]: [{ t: 'c', c: 'Fixture message' }] }] }, {})[0], /\.arguments\[0\]\.exp/);
  }
});

test('literal JSON values are not interpreted as native operands or expression trees', () => {
  const literal = { t: 'condition', ro: { t: 'c', c: 'Fixture literal' }, s: [action({ t: 'c', c: 'Fixture literal' })], err: 'Fixture literal error' };
  const draft = body({ t: 'c', vt: 'dynamic', c: literal, exp: { t: 'dynamic', v: literal } });
  draft.v = [{ n: 'literal', t: 'dynamic', v: { t: 'e', exp: { t: 'dynamic', v: literal } } }];
  draft.o = { literal };
  assert.deepEqual(validatePiston(draft, {}), []);
});

test('prepare rejects malformed expressions in every supported wrapper and apply never calls upload or live test', async () => {
  const draft = body({ t: 'c', vt: 'string', c: 'Fixture private message' });
  const live = { data: { meta: { id: 'pid', name: 'Fixture' }, piston: { s: [] } } };
  let uploads = 0, tests = 0;
  const client = {
    async getPiston() { return structuredClone(live); },
    async listDevices() { return {}; },
    async getLanguageDb() { return { db: {} }; },
    async savePiston() { uploads++; throw new Error('Must not upload.'); },
    async testPiston() { tests++; throw new Error('Must not run a live test.'); }
  };
  for (const proposed of [draft, { piston: draft }, { data: { piston: draft } }]) {
    const prepared = prepareUpdate('pid', live, proposed, {});
    assert.equal(prepared.ok, false);
    assert.equal(prepared.proposed_body_hash, undefined);
    assert.equal(JSON.stringify(prepared).includes('Fixture private message'), false);
    await assert.rejects(applyPistonUpdate(client, 'pid', proposed, hashJson(pistonFingerprint(live))), error => {
      assert.equal(error.code, 'VALIDATION_ERROR');
      assert.match(error.message, /\.exp/);
      assert.equal(error.message.includes('Fixture private message'), false);
      return true;
    });
  }
  assert.equal(uploads, 0);
  assert.equal(tests, 0);
});
