import assert from 'node:assert/strict';
import { test } from 'node:test';
import { en } from '../src/i18n/en.ts';
import { es } from '../src/i18n/es.ts';

function keysOf(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) return [`${prefix}[${value.length}]`];
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => keysOf(child, prefix ? `${prefix}.${key}` : key));
  }
  return [prefix];
}

test('the Spanish dictionary mirrors the English one key for key', () => {
  assert.deepEqual(keysOf(es).sort(), keysOf(en).sort());
});

test('no dictionary string is empty or left as a placeholder', () => {
  const walk = (value: unknown, path: string) => {
    if (typeof value === 'string') {
      assert.ok(value.trim().length > 0, `${path} is empty`);
      assert.ok(!/lorem ipsum/i.test(value) && !/\b(TODO|TBD|FIXME)\b/.test(value), `${path} still holds a placeholder`);
      return;
    }
    if (Array.isArray(value)) value.forEach((item, index) => walk(item, `${path}[${index}]`));
    else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) walk(child, path ? `${path}.${key}` : key);
    }
  };
  walk(en, 'en');
  walk(es, 'es');
});
