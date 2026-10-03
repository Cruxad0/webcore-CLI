import { WebcoreError } from './client.js';
import { hashJson, normalizePistonDraft, pistonBodyFingerprint, pistonBodySummary, PISTON_BODY_FINGERPRINT_VERSION } from './piston.js';
import { assertPistonIdentity } from './selection.js';

export const READBACK_RETRY_DELAYS_MS = Object.freeze([0, 250, 750]);
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeFields = new Set('o r rn rop s v z t c e ei cs k p d a g n x vt lo co ro ro2 to to2 sm ts fs tcp cto op ot w ct value type name command arguments devices'.split(' '));

// Report structural differences, never operand values, variable contents or comments.
function differingPaths(expected, actual, path = '$', out = [], limit = 32) {
  if (out.length >= limit || Object.is(expected, actual)) return out;
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) out.push(`${path}.length`);
    for (let i = 0; i < Math.min(expected.length, actual.length) && out.length < limit; i++) differingPaths(expected[i], actual[i], `${path}[${i}]`, out, limit);
  } else if (object(expected) && object(actual)) {
    for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
      if (out.length >= limit) break;
      const next = `${path}.${safeFields.has(key) ? key : '<field>'}`;
      if (!Object.hasOwn(expected, key) || !Object.hasOwn(actual, key)) out.push(next);
      else differingPaths(expected[key], actual[key], next, out, limit);
    }
  } else out.push(path);
  return [...new Set(out)];
}

export function assertPreparedBodyHash(body, expected) {
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) throw new WebcoreError('Use the proposed_body_hash from the approved preparation as expected_body_hash.', 'EXPECTED_BODY_HASH_REQUIRED');
  const actual = hashJson(pistonBodyFingerprint(body));
  if (actual !== expected) {
    const error = new WebcoreError('The draft differs from the approved prepared body, or its hash used another fingerprint version. Prepare and review it again with this plugin version before applying.', 'DRAFT_HASH_MISMATCH');
    error.details = { expected_body_hash: expected, proposed_body_hash: actual, body_fingerprint_version: PISTON_BODY_FINGERPRINT_VERSION };
    throw error;
  }
  return actual;
}

// The upload hash also binds rename n and exact payload fields excluded from the
// stored semantic fingerprint. Both hashes originate from the approved prepare.
export function assertPreparedDraftHash(body, expected) {
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) throw new WebcoreError('Use proposed_hash from the approved preparation as expected_proposed_hash.', 'EXPECTED_PROPOSED_HASH_REQUIRED');
  const actual = hashJson(body);
  if (actual !== expected) {
    const error = new WebcoreError('The upload payload changed after preparation, including its requested rename or metadata. Prepare and review the intended draft again.', 'DRAFT_HASH_MISMATCH');
    error.details = { expected_proposed_hash: expected, proposed_hash: actual };
    throw error;
  }
  return actual;
}

export async function verifyPistonUpdate(client, { id, expected_name, expected_body_hash }, { expectedBody, waitForRetry = wait } = {}) {
  if (typeof id !== 'string' || !id.trim() || /^\d+$/.test(id)) throw new WebcoreError('Provide the exact piston ID, not a number from a list.', 'PISTON_ID_REQUIRED');
  if (typeof expected_name !== 'string' || !expected_name.trim()) throw new WebcoreError('Provide the expected piston name from the original selection or approved rename.', 'EXPECTED_NAME_REQUIRED');
  if (typeof expected_body_hash !== 'string' || !/^[a-f0-9]{64}$/.test(expected_body_hash)) throw new WebcoreError('Provide proposed_body_hash from the original approved preparation, not stored_body_hash from a failed read-back.', 'EXPECTED_BODY_HASH_REQUIRED');
  if (expectedBody) {
    assertPreparedBodyHash(expectedBody, expected_body_hash);
    if (expectedBody.n && expectedBody.n !== expected_name) throw new WebcoreError('The expected name disagrees with the intended draft rename. Use the name from the approved draft.', 'DRAFT_NAME_MISMATCH');
  }
  const attempts = [];
  let last, lastFingerprint;
  for (const [index, delay] of READBACK_RETRY_DELAYS_MS.entries()) {
    if (delay) await waitForRetry(delay);
    client.debug?.(`read-back attempt=${index + 1}; credentials and body values omitted`);
    let stored;
    try { stored = await client.getPiston(id); }
    catch (error) {
      const causeCode = typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : 'REQUEST_FAILED';
      last = { code: 'PISTON_READBACK_FAILED', cause_code: causeCode, stored_definition_unknown: true };
      attempts.push({ attempt: index + 1, ...last });
      if (['ERR_INVALID_TOKEN', 'ERR_INVALID_ID', 'AUTH_ERROR'].includes(causeCode) || error.httpStatus && error.httpStatus < 500 && ![408, 429].includes(error.httpStatus)) break;
      continue;
    }
    let identity;
    try { identity = assertPistonIdentity(stored, { id, name: expected_name }); }
    catch (error) {
      last = { code: 'PISTON_READBACK_INVALID', cause_code: error.code ?? 'PISTON_IDENTITY_UNAVAILABLE', stored_definition_unknown: true };
      attempts.push({ attempt: index + 1, ...last });
      // Never reconcile a different piston or silently follow a rename by another editor.
      if (error.code === 'PISTON_IDENTITY_MISMATCH') break;
      continue;
    }
    let body;
    try { body = normalizePistonDraft(id, stored).body; }
    catch (error) {
      last = { code: 'PISTON_READBACK_INVALID', cause_code: error.code ?? 'INVALID_PISTON_BODY', stored_definition_unknown: true };
      attempts.push({ attempt: index + 1, identity_verified: true, ...last });
      continue;
    }
    lastFingerprint = pistonBodyFingerprint(body);
    const storedHash = hashJson(lastFingerprint);
    const summary = pistonBodySummary(body);
    const matching = storedHash === expected_body_hash;
    last = { code: matching ? 'MATCH' : 'PISTON_READBACK_MISMATCH', stored_definition_unknown: false, stored_body_hash: storedHash, stored_body_summary: summary };
    attempts.push({ attempt: index + 1, identity_verified: true, ...last });
    if (!matching) continue;
    const meta = (stored?.data ?? stored).meta;
    return { id, verified: true, persistence_verified: true, device_execution_verified: false, verification: {
      scope: 'stored_definition', verified: true, identity_verified: true, selected_piston: identity,
      expected_body_hash, stored_body_hash: storedHash, body_fingerprint_version: PISTON_BODY_FINGERPRINT_VERSION, body_summary: summary,
      build: Number.isInteger(meta.build) && meta.build > 0 ? meta.build : null,
      active: typeof meta.active === 'boolean' ? meta.active : null,
      readback_attempt_count: attempts.length, readback_attempts: attempts,
      device_execution_verified: false
    } };
  }
  const message = last.code === 'PISTON_READBACK_MISMATCH'
    ? 'The stored definition still differs from the intended draft after bounded read-only checks. Inspect the differing fields; do not repeat a write automatically.'
    : last.code === 'PISTON_READBACK_INVALID'
      ? 'The read-back has an invalid body or different piston identity. Verification failed; inspect the intended piston before any correction.'
      : 'The stored definition could not be read after bounded checks. Persistence is unverified; use read-only verification before considering another write.';
  const error = new WebcoreError(message, last.code);
  error.details = { verified: false, persistence_verified: false, device_execution_verified: false,
    verification_scope: 'stored_definition', expected_body_hash, body_fingerprint_version: PISTON_BODY_FINGERPRINT_VERSION,
    ...last, readback_attempt_count: attempts.length, readback_attempts: attempts,
    ...(expectedBody && last.code === 'PISTON_READBACK_MISMATCH' ? { differing_paths: differingPaths(pistonBodyFingerprint(expectedBody), lastFingerprint) } : {}) };
  throw error;
}
