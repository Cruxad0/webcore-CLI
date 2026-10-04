import test from 'node:test';
import assert from 'node:assert/strict';
import { hashJson, PISTON_BODY_FINGERPRINT_VERSION, pistonBodyFingerprint, prepareUpdate } from '../server/piston.js';

const constant = (vt, c, type = vt) => ({ t: 'c', vt, c, exp: { t: 'expression', i: [{ t: type, v: c }] } });
const action = (command = 'on') => ({ t: 'action', d: ['lamp'], tcp: 'c',
  k: [{ c: command, p: [constant('integer', 10)] }], z: 'Action comment' });
const condition = () => ({ t: 'condition', co: 'stays',
  lo: { t: 'p', d: ['sensor'], a: 'motion', g: 'any' },
  ro: constant('string', 'active'), ro2: constant('integer', 2),
  to: constant('m', 5, 'integer'), to2: constant('m', 10, 'integer'),
  sm: 'auto', wt: 'l', wd: constant('s', 1, 'integer'),
  ts: [action()], fs: [action('off')], z: 'Condition comment' });
const restriction = () => ({ t: 'restriction', co: 'is',
  lo: { t: 'x', x: 'enabled' }, ro: constant('boolean', true) });
const literal = () => ({ t: 'condition', s: ['literal statement value'], ct: 't', w: ['literal warning value'],
  c: [{ t: 'condition', s: false, ct: 'c', w: ['nested literal'] }] });
const body = () => ({ o: { cto: 0 }, r: [{ t: 'group', rop: 'and', r: [restriction()] }], rn: false, rop: 'and',
  s: [
    { t: 'if', o: 'and', c: [{ t: 'group', o: 'and', n: false, c: [condition()] }],
      s: [action()], e: [action('off')], ei: [{ c: [condition()], s: [action('setLevel')] }],
      r: [restriction()], z: 'If comment' },
    { t: 'on', c: [{ t: 'event', lo: { t: 'p', d: ['sensor'], a: 'motion', g: 'any' } }], s: [action()] },
    { t: 'switch', lo: { t: 'x', x: 'mode' }, cs: [
      { t: 's', ro: constant('string', 'home'), s: [{ t: 'if', c: [condition()], s: [action()] }] },
      { t: 'r', ro: constant('integer', 1), ro2: constant('integer', 3), s: [action()] }
    ], e: [action('off')] }
  ],
  v: [{ n: 'enabled', t: 'boolean', v: constant('boolean', true) }], z: 'Piston comment' });
const fingerprintHash = value => hashJson(pistonBodyFingerprint(value));

test('fingerprint scheme is explicit and preparing keeps the original upload body intact', () => {
  const draft = body();
  const original = structuredClone(draft);
  draft.s[0].c[0].c[0].ct = 't';
  draft.s[0].c[0].c[0].s = true;
  const prepared = prepareUpdate('pid', { data: { piston: { s: [] } } }, draft, {});
  assert.equal(PISTON_BODY_FINGERPRINT_VERSION, 2);
  assert.equal(prepared.body_fingerprint_version, 2);
  assert.equal(prepared.ok, true);
  assert.deepEqual(prepared.proposed, draft);
  assert.equal(prepared.proposed_body_hash, fingerprintHash(original));
  const before = structuredClone(draft);
  pistonBodyFingerprint(draft);
  assert.deepEqual(draft, before);
});

test('native generated IDs, subscription markers, classifications and warnings do not change a logic hash', () => {
  const draft = body();
  const stored = structuredClone(draft);
  const nodes = [stored.s[0], stored.s[0].c[0], stored.s[0].c[0].c[0], stored.s[0].s[0],
    stored.s[0].c[0].c[0].ts[0], stored.s[0].c[0].c[0].fs[0],
    stored.s[0].ei[0].c[0], stored.s[0].ei[0].s[0], stored.s[0].r[0],
    stored.r[0], stored.r[0].r[0], stored.s[1], stored.s[1].c[0], stored.s[1].s[0],
    stored.s[2], stored.s[2].cs[0].s[0], stored.s[2].cs[0].s[0].c[0],
    stored.s[2].cs[1].s[0], stored.s[2].e[0]];
  nodes.forEach((node, i) => { node.$ = i + 1; node.w = [`Generated warning ${i}`]; });
  for (const node of [stored.s[0].c[0].c[0], stored.s[0].ei[0].c[0], stored.s[0].r[0],
    stored.r[0].r[0], stored.s[1].c[0], stored.s[2].cs[0].s[0].c[0]]) {
    node.ct = 't'; node.s = true;
  }
  stored.s[2].ct = 'c';
  stored.s[2].s = false;
  assert.equal(fingerprintHash(stored), fingerprintHash(draft));
  assert.deepEqual(pistonBodyFingerprint(stored), pistonBodyFingerprint(draft));
});

test('supported engine markers are ignored while malformed or unknown annotation values stay compared', () => {
  for (const s of [true, false, 'local']) for (const ct of ['t', 'c']) {
    const stored = body();
    Object.assign(stored.s[0].c[0].c[0], { s, ct, w: [] });
    assert.equal(fingerprintHash(stored), fingerprintHash(body()));
  }
  for (const fields of [{ ct: 'unknown' }, { s: ['actual content'] }, { s: { user: true } },
    { s: 'user content' }, { w: ['warning', { user: true }] }, { w: { user: true } }]) {
    const stored = body();
    Object.assign(stored.s[0].c[0].c[0], fields);
    assert.notEqual(fingerprintHash(stored), fingerprintHash(body()));
  }
});

test('commands, operands, durations, policies, branches, options, variables and comments stay meaningful', () => {
  const changes = [
    value => { value.s[0].s[0].k[0].c = 'off'; },
    value => { value.s[0].s[0].d = ['another-lamp']; },
    value => { value.s[0].s[0].k[0].p[0].c = 20; },
    value => { value.s[0].c[0].c[0].co = 'changes_to'; },
    value => { value.s[0].c[0].c[0].lo.a = 'switch'; },
    value => { value.s[0].c[0].c[0].ro.c = 'inactive'; },
    value => { value.s[0].c[0].c[0].ro2.c = 3; },
    value => { value.s[0].c[0].c[0].to.c = 6; },
    value => { value.s[0].c[0].c[0].to2.c = 11; },
    value => { value.s[0].c[0].c[0].sm = 'never'; },
    value => { value.s[0].c[0].c[0].wt = 's'; },
    value => { value.s[0].c[0].c[0].wd.c = 2; },
    value => { value.s[0].c[0].c[0].ts[0].k[0].c = 'off'; },
    value => { value.s[0].c[0].c[0].fs = []; },
    value => { value.s[0].s[0].tcp = 'never'; },
    value => { value.s[0].c[0].n = true; },
    value => { value.s[0].ei[0].c[0].ro.c = 'inactive'; },
    value => { value.s[0].ei[0].s = []; },
    value => { value.s[0].e = []; },
    value => { value.s[2].cs[0].s = []; },
    value => { value.s[2].cs[1].ro2.c = 4; },
    value => { value.r[0].r[0].co = 'is_not'; },
    value => { value.o.cto = 1; },
    value => { value.v[0].v.c = false; },
    value => { value.z = 'Changed comment'; },
    value => { value.s[0].c[0].c[0].z = 'Changed condition comment'; },
    value => { value.s.push(action('off')); }
  ];
  const expected = fingerprintHash(body());
  changes.forEach((change, i) => {
    const changed = body();
    change(changed);
    assert.notEqual(fingerprintHash(changed), expected, `meaningful change ${i + 1} must remain visible`);
  });
});

test('condition-like literal objects in operands, variables and options are never treated as logic nodes', () => {
  const draft = body();
  draft.s[0].s[0].k[0].p[0] = { t: 'c', vt: 'dynamic', c: literal() };
  draft.s[0].c[0].c[0].ro = { t: 'c', vt: 'dynamic', c: literal() };
  draft.v[0].v = { t: 'c', vt: 'dynamic', c: literal() };
  draft.o.literal = literal();
  const actual = pistonBodyFingerprint(draft);
  assert.deepEqual(actual.s[0].s[0].k[0].p[0].c, literal());
  assert.deepEqual(actual.s[0].c[0].c[0].ro.c, literal());
  assert.deepEqual(actual.v[0].v.c, literal());
  assert.deepEqual(actual.o.literal, literal());
  for (const getLiteral of [value => value.s[0].s[0].k[0].p[0].c,
    value => value.s[0].c[0].c[0].ro.c, value => value.v[0].v.c, value => value.o.literal]) {
    for (const key of ['s', 'ct', 'w']) {
      const changed = structuredClone(draft);
      delete getLiteral(changed)[key];
      assert.notEqual(fingerprintHash(changed), fingerprintHash(draft), `literal ${key} must stay compared`);
    }
  }
});

test('switch metadata normalization preserves statement arrays and case operand types', () => {
  const draft = body();
  const stored = structuredClone(draft);
  stored.s[2].ct = 'c';
  stored.s[2].s = true;
  assert.equal(fingerprintHash(stored), fingerprintHash(draft));
  assert.equal(pistonBodyFingerprint(stored).s[2].cs[0].t, 's');
  stored.s[2].s = [action('off')];
  assert.notEqual(fingerprintHash(stored), fingerprintHash(draft));
  assert.deepEqual(pistonBodyFingerprint(stored).s[2].s, [action('off')]);
  stored.s[2].s[0].k[0].c = 'on';
  const changed = structuredClone(draft);
  changed.s[2].s = [action('off')];
  assert.notEqual(fingerprintHash(stored), fingerprintHash(changed));
});

test('unknown structures and non-derived statement fields retain condition-like data', () => {
  const draft = body();
  draft.s.push({ t: 'custom', c: [literal()], s: [literal()], w: ['user content'] });
  draft.s[0].ct = 't';
  draft.s[0].k = [literal()];
  const actual = pistonBodyFingerprint(draft);
  assert.deepEqual(actual.s.at(-1), draft.s.at(-1));
  assert.deepEqual(actual.s[0].k, draft.s[0].k);
  assert.equal(actual.s[0].ct, 't');
});
