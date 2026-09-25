import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEVELOPER_MODE_STORAGE_KEY,
  readDeveloperMode,
  writeDeveloperMode,
} from './developerMode.js';

function storage(values = {}) {
  return {
    values: new Map(Object.entries(values)),
    getItem(key) { return this.values.get(key) ?? null; },
    setItem(key, value) { this.values.set(key, String(value)); },
  };
}

test('developer mode defaults off when storage has no saved state', () => {
  assert.equal(readDeveloperMode(storage()), false);
});

test('developer mode restores only the persisted true value', () => {
  const store = storage({ [DEVELOPER_MODE_STORAGE_KEY]: 'true' });
  assert.equal(readDeveloperMode(store), true);
  store.setItem(DEVELOPER_MODE_STORAGE_KEY, 'false');
  assert.equal(readDeveloperMode(store), false);
});

test('developer mode writes a boolean state to storage', () => {
  const store = storage();
  writeDeveloperMode(true, store);
  assert.equal(store.getItem(DEVELOPER_MODE_STORAGE_KEY), 'true');
  writeDeveloperMode(false, store);
  assert.equal(store.getItem(DEVELOPER_MODE_STORAGE_KEY), 'false');
});