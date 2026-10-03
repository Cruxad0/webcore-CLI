import test from 'node:test';
import assert from 'node:assert/strict';
import { getVerifiedPiston, PistonSelectionStore } from '../server/selection.js';

function fixture() {
  let records = [
    ...Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, name: `A${i + 1}`, meta: { a: true } })),
    { id: 'day', name: 'Daytime Lights - V2', meta: { a: true } },
    { id: 'dryer', name: 'Dryer Notification', meta: { a: true } },
    { id: 'paused', name: 'A0 paused', meta: { a: false } }
  ];
  const fetched = [];
  const client = {
    config: { baseUrl: 'http://hub/apps/api/17', accessToken: 'fixture' },
    listPistons: async () => structuredClone(records),
    getPiston: async id => {
      fetched.push(id);
      const record = records.find(row => row.id === id);
      return { data: { meta: { id: record.id, name: record.name, active: record.meta.a }, piston: { statements: [] } } };
    }
  };
  return { client, fetched, change: next => { records = next(records); } };
}

test('original active #7 remains Daytime Lights after refresh makes #7 Dryer Notification', async () => {
  const f = fixture();
  const store = new PistonSelectionStore();
  const original = await store.list(f.client, 'active');
  assert.equal(original.entries[6].name, 'Daytime Lights - V2');
  assert.equal(original.piston_count, 8);
  assert.equal(original.total_piston_count, 9);
  f.change(records => records.map(row => row.id === 'day' ? { ...row, meta: { a: false } } : row).reverse());
  const refreshed = await store.list(f.client, 'active');
  assert.equal(refreshed.entries[6].name, 'Dryer Notification');
  assert.notEqual(refreshed.list_id, original.list_id);
  const selected = await store.select(f.client, { list_id: original.list_id, number: 7, expected_name: 'Daytime Lights - V2' });
  assert.equal(selected.identity_verified, true);
  assert.equal(selected.selected_piston.id, 'day');
  assert.equal(selected.selection.scope, 'active');
  assert.deepEqual(f.fetched, ['day']);
});

test('using a different list with the original name stops before any piston fetch', async () => {
  const f = fixture();
  const store = new PistonSelectionStore();
  await store.list(f.client, 'active');
  const all = await store.list(f.client, 'all');
  assert.notEqual(all.entries[6].name, 'Daytime Lights - V2');
  await assert.rejects(store.select(f.client, { list_id: all.list_id, number: 7, expected_name: 'Daytime Lights - V2' }), { code: 'SELECTION_NAME_MISMATCH' });
  assert.deepEqual(f.fetched, []);
});

test('fetched name or ID mismatch prevents the definition from reaching the assistant', async () => {
  const f = fixture();
  for (const meta of [{ id: 'dryer', name: 'Daytime Lights - V2' }, { id: 'day', name: 'Dryer Notification' }]) {
    f.client.getPiston = async () => ({ data: { meta, piston: { wrong: true } } });
    await assert.rejects(getVerifiedPiston(f.client, { id: 'day', expected_name: 'Daytime Lights - V2' }), { code: 'PISTON_IDENTITY_MISMATCH' });
  }
});

test('expired snapshots, connection changes, and invalid numbers cannot be reinterpreted', async () => {
  const f = fixture();
  let now = 1000;
  const store = new PistonSelectionStore({ now: () => now, ttlMs: 10 });
  const list = await store.list(f.client, 'active');
  const selection = { list_id: list.list_id, number: 7, expected_name: 'Daytime Lights - V2' };
  await assert.rejects(store.select(f.client, { ...selection, number: 7.5 }), { code: 'INVALID_PISTON_NUMBER' });
  f.client.config.baseUrl = 'http://other-hub/apps/api/17';
  await assert.rejects(store.select(f.client, selection), { code: 'LIST_CONNECTION_CHANGED' });
  now += 11;
  await assert.rejects(store.select(f.client, selection), { code: 'LIST_SNAPSHOT_EXPIRED' });
  await assert.rejects(new PistonSelectionStore().select(f.client, selection), { code: 'LIST_SNAPSHOT_EXPIRED' });
  assert.deepEqual(f.fetched, []);
});

test('unverifiable IDs or active states cannot produce a numbered filtered list', async () => {
  const f = fixture();
  const store = new PistonSelectionStore();
  f.change(records => [...records, { ...records[0] }]);
  await assert.rejects(store.list(f.client, 'all'), { code: 'DUPLICATE_PISTON_ID' });
  f.client.listPistons = async () => [{ id: 'day', name: 'Daytime Lights - V2' }];
  await assert.rejects(store.list(f.client, 'active'), { code: 'PISTON_STATUS_UNAVAILABLE' });
  const all = await store.list(f.client, 'all');
  assert.equal(all.unknown_status_count, 1);
  assert.equal(all.entries[0].status, 'unknown');
});
