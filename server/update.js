import { WebcoreError } from './client.js';
import { assertExpectedRemoteHash, prepareUpdate } from './piston.js';
import { assertPistonIdentity } from './selection.js';
import { assertPreparedBodyHash, assertPreparedDraftHash, verifyPistonUpdate } from './verification.js';

// Shared by CLI and MCP so validation, hash checks, and upload decisions stay identical.
export async function applyPistonUpdate(client, id, proposed, expectedRemoteHash, { expectedBodyHash, expectedProposedHash, readbackOptions } = {}) {
  const draft = structuredClone(proposed);
  const [live, devices, db] = await Promise.all([
    client.getPiston(id), client.listDevices(), client.getLanguageDb()
  ]);
  try {
    return { ...await applyWithLiveInventory(client, id, draft, expectedRemoteHash, live, devices, db, expectedBodyHash, expectedProposedHash, readbackOptions),
      language_compatibility: db.language_compatibility };
  } catch (error) {
    if (db.language_compatibility) error.details = { ...error.details, language_compatibility: db.language_compatibility };
    throw error;
  }
}

async function applyWithLiveInventory(client, id, draft, expectedRemoteHash, live, devices, db, expectedBodyHash, expectedProposedHash, readbackOptions) {
  assertExpectedRemoteHash(live, expectedRemoteHash);
  const original = assertPistonIdentity(live, { id, name: (live?.data ?? live)?.meta?.name });
  const prepared = prepareUpdate(id, live, draft, devices, db.db ?? db);
  if (!prepared.ok) throw new WebcoreError(`Validation failed: ${prepared.errors.join('; ')}`, prepared.code ?? 'VALIDATION_ERROR');
  const body = prepared.proposed;
  if (expectedProposedHash !== undefined) assertPreparedDraftHash(body, expectedProposedHash);
  if (expectedBodyHash !== undefined) assertPreparedBodyHash(body, expectedBodyHash);
  const encoded = Buffer.from(JSON.stringify(body), 'utf8').toString('base64');
  const beforeCommit = async () => assertExpectedRemoteHash(await client.getPiston(id), expectedRemoteHash);
  const result = await client.savePiston(id, encoded, { beforeCommit });
  let verified;
  try {
    verified = await verifyPistonUpdate(client, { id, expected_name: body.n || original.name, expected_body_hash: prepared.proposed_body_hash },
      { ...readbackOptions, expectedBody: body });
  }
  catch (error) {
    error.details = { ...error.details, upload_stage: 'read_back', accepted: true, applied: false, verified: false,
      commit_confirmation_unknown: false, retry_safe: false, expected_body_summary: prepared.body_summary,
      request_trace: structuredClone(result.upload?.request_trace ?? []) };
    throw error;
  }
  return { ...verified, applied: true, accepted: true, result: { status: result.status, upload: result.upload } };
}
