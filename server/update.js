import { WebcoreError } from './client.js';
import { assertExpectedRemoteHash, hashJson, normalizePistonDraft, pistonBodyFingerprint, pistonBodySummary, prepareUpdate } from './piston.js';
import { assertPistonIdentity } from './selection.js';

// Shared by CLI and MCP so validation, hash checks, and upload decisions stay identical.
export async function applyPistonUpdate(client, id, proposed, expectedRemoteHash) {
  const draft = structuredClone(proposed);
  const [live, devices, db] = await Promise.all([
    client.getPiston(id), client.listDevices(), client.getLanguageDb()
  ]);
  try {
    return { ...await applyWithLiveInventory(client, id, draft, expectedRemoteHash, live, devices, db),
      language_compatibility: db.language_compatibility };
  } catch (error) {
    if (db.language_compatibility) error.details = { ...error.details, language_compatibility: db.language_compatibility };
    throw error;
  }
}

async function applyWithLiveInventory(client, id, draft, expectedRemoteHash, live, devices, db) {
  assertExpectedRemoteHash(live, expectedRemoteHash);
  const original = assertPistonIdentity(live, { id, name: (live?.data ?? live)?.meta?.name });
  const prepared = prepareUpdate(id, live, draft, devices, db.db ?? db);
  if (!prepared.ok) throw new WebcoreError(`Validation failed: ${prepared.errors.join('; ')}`, prepared.code ?? 'VALIDATION_ERROR');
  const body = prepared.proposed;
  const encoded = Buffer.from(JSON.stringify(body), 'utf8').toString('base64');
  const beforeCommit = async () => assertExpectedRemoteHash(await client.getPiston(id), expectedRemoteHash);
  const result = await client.savePiston(id, encoded, { beforeCommit });
  const failure = (code, message, details = {}) => {
    const error = new WebcoreError(message, code);
    error.details = { upload_stage: 'read_back', accepted: true, applied: false, verified: false,
      commit_confirmation_unknown: false, stored_definition_unknown: true, retry_safe: false,
      expected_body_hash: prepared.proposed_body_hash, expected_body_summary: prepared.body_summary,
      request_trace: structuredClone(result.upload?.request_trace ?? []), ...details };
    return error;
  };
  let stored;
  try { stored = await client.getPiston(id); }
  catch (error) {
    throw failure('PISTON_READBACK_FAILED', 'webCoRE accepted the upload, but the saved definition could not be read. Success is unverified; inspect the live piston before any retry.', { cause_code: error.code ?? 'REQUEST_FAILED' });
  }
  let identity, storedBody;
  try {
    identity = assertPistonIdentity(stored, { id, name: body.n || original.name });
    storedBody = normalizePistonDraft(id, stored).body;
  } catch (error) {
    throw failure('PISTON_READBACK_INVALID', 'webCoRE accepted the upload, but read-back returned an invalid body or different piston identity. Do not report success or automatically repeat the write.', { cause_code: error.code ?? 'INVALID_RESPONSE' });
  }
  const stored_body_hash = hashJson(pistonBodyFingerprint(storedBody));
  const stored_body_summary = pistonBodySummary(storedBody);
  if (stored_body_hash !== prepared.proposed_body_hash) {
    throw failure('PISTON_READBACK_MISMATCH', 'webCoRE accepted the upload, but the stored logic does not match the draft. Do not report success or automatically repeat the write; inspect and prepare again.',
      { stored_definition_unknown: false, stored_body_hash, stored_body_summary });
  }
  const meta = (stored?.data ?? stored).meta;
  // Keep acknowledgement fields separate from authoritative metadata read after saving.
  return { applied: true, accepted: true, verified: true, id, result: { status: result.status, upload: result.upload }, verification: {
    verified: true, identity_verified: true, selected_piston: identity,
    expected_body_hash: prepared.proposed_body_hash, stored_body_hash, body_summary: stored_body_summary,
    build: Number.isInteger(meta.build) && meta.build > 0 ? meta.build : null,
    active: typeof meta.active === 'boolean' ? meta.active : null
  } };
}
