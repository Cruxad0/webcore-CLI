import { createHash, randomUUID } from 'node:crypto';
import { WebcoreError } from './client.js';

const connectionKey = client => createHash('sha256')
  .update(JSON.stringify([client.config.baseUrl, client.config.accessToken]))
  .digest('hex');

function identity(record) {
  const id = record?.id ?? record?.i ?? record?.meta?.id;
  const name = record?.name ?? record?.n ?? record?.meta?.name;
  if (typeof id !== 'string' || !id.trim() || typeof name !== 'string' || !name.trim()) {
    throw new WebcoreError('A piston record has no usable ID or name; numbered selection is unavailable.', 'PISTON_IDENTITY_UNAVAILABLE');
  }
  return { id, name };
}

function activeState(record) {
  // Hubitat dashboard lists use meta.a; fetched piston metadata uses meta.active.
  for (const value of [record?.meta?.a, record?.meta?.active, record?.active, record?.a]) {
    if (typeof value === 'boolean') return value;
  }
  return null;
}

export function assertPistonIdentity(live, expected) {
  const actual = identity((live?.data ?? live)?.meta);
  if (actual.id !== expected.id || actual.name !== expected.name) {
    throw new WebcoreError('The fetched piston ID or name does not match the selected piston. Stop and resolve the original selection before analysis.', 'PISTON_IDENTITY_MISMATCH');
  }
  return actual;
}

export async function getVerifiedPiston(client, { id, expected_name }) {
  if (typeof id !== 'string' || !id.trim() || /^\d+$/.test(id)) {
    throw new WebcoreError('Use the exact piston ID returned by the list tool. For a numbered item use webcore_select_piston.', 'PISTON_ID_REQUIRED');
  }
  if (typeof expected_name !== 'string' || !expected_name.trim()) {
    throw new WebcoreError('Provide expected_name from the original piston list.', 'EXPECTED_NAME_REQUIRED');
  }
  const live = await client.getPiston(id);
  const actual = assertPistonIdentity(live, { id, name: expected_name });
  return { ...live, selected_piston: actual, identity_verified: true };
}

export class PistonSelectionStore {
  constructor({ now = Date.now, ttlMs = 24 * 60 * 60 * 1000, maxLists = 32 } = {}) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.maxLists = maxLists;
    this.snapshots = new Map();
  }

  prune() {
    for (const [key, snapshot] of this.snapshots) {
      if (snapshot.expiresAt <= this.now()) this.snapshots.delete(key);
    }
  }

  async list(client, scope = 'all') {
    if (!['all', 'active', 'paused'].includes(scope)) {
      throw new WebcoreError('scope must be all, active, or paused.', 'INVALID_LIST_SCOPE');
    }
    const records = await client.listPistons();
    const rows = records.map(record => ({ record, ...identity(record), active: activeState(record) }));
    if (new Set(rows.map(row => row.id)).size !== rows.length) {
      throw new WebcoreError('The piston list contains duplicate IDs; numbered selection is unavailable.', 'DUPLICATE_PISTON_ID');
    }
    const counts = {
      total_piston_count: rows.length,
      active_count: rows.filter(row => row.active === true).length,
      paused_count: rows.filter(row => row.active === false).length,
      unknown_status_count: rows.filter(row => row.active === null).length
    };
    if (scope !== 'all' && counts.unknown_status_count) {
      throw new WebcoreError('Some piston records have no explicit active state. Use scope=all; an active or paused numbered list cannot be verified.', 'PISTON_STATUS_UNAVAILABLE');
    }
    const filtered = rows.filter(row => scope === 'all' || row.active === (scope === 'active'));
    filtered.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true, sensitivity: 'base' }) || a.id.localeCompare(b.id, 'en'));
    const entries = filtered.map((row, i) => ({ number: i + 1, id: row.id, name: row.name, status: row.active === null ? 'unknown' : row.active ? 'active' : 'paused' }));
    const list_id = randomUUID();
    const expiresAt = this.now() + this.ttlMs;
    this.prune();
    while (this.snapshots.size >= this.maxLists) this.snapshots.delete(this.snapshots.keys().next().value);
    this.snapshots.set(list_id, { connection: connectionKey(client), scope, entries: structuredClone(entries), expiresAt });
    return {
      list_id, scope, piston_count: entries.length, ...counts,
      entries,
      display_list: entries.map(entry => `${entry.number}. ${entry.name} [${entry.status}]`).join('\n'),
      pistons: filtered.map(row => row.record),
      source: 'webCoRE dashboard',
      selection_expires_at: new Date(expiresAt).toISOString()
    };
  }

  async select(client, { list_id, number, expected_name }) {
    this.prune();
    const snapshot = this.snapshots.get(list_id);
    if (!snapshot) {
      throw new WebcoreError('The original numbered list is unavailable or expired. Use its exact ID and name if known, otherwise show a new list and ask the user to choose again. Never reuse the old number on a new list.', 'LIST_SNAPSHOT_EXPIRED');
    }
    if (snapshot.connection !== connectionKey(client)) {
      throw new WebcoreError('The connection changed since this list was created. Resolve the selection on the intended webCoRE instance.', 'LIST_CONNECTION_CHANGED');
    }
    if (!Number.isInteger(number) || number < 1 || number > snapshot.entries.length) {
      throw new WebcoreError('number must identify an entry in the original numbered list.', 'INVALID_PISTON_NUMBER');
    }
    const entry = snapshot.entries[number - 1];
    if (entry.name !== expected_name) {
      throw new WebcoreError('The expected name does not match that number in the referenced list. Use the name, ID, and list_id from the list shown to the user; do not select from a refreshed list.', 'SELECTION_NAME_MISMATCH');
    }
    const live = await getVerifiedPiston(client, { id: entry.id, expected_name: entry.name });
    return { ...live, selection: { list_id, number, scope: snapshot.scope, id: entry.id, name: entry.name } };
  }
}
