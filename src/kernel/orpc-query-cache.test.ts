import { describe, expect, it } from 'vitest';
import { ORPCQueryCache } from './orpc-query-cache';

function snapshot(body: unknown) {
  return Promise.resolve({ status: 200, headers: {}, body });
}

describe('ORPCQueryCache', () => {
  it('constructs as a plain class outside the Angular toolchain', () => {
    // no testbed: the built package must construct without the angular compiler
    expect(() => new ORPCQueryCache()).not.toThrow();
  });

  it('get/set round-trip a stored snapshot', async () => {
    const cache = new ORPCQueryCache();
    cache.set('key', snapshot('value'), ['tag']);
    const stored = cache.get('key');
    expect(stored).toBeDefined();
    await expect(stored).resolves.toEqual({ status: 200, headers: {}, body: 'value' });
  });

  it('get returns undefined for a missing key', () => {
    const cache = new ORPCQueryCache();
    expect(cache.get('missing')).toBeUndefined();
  });

  it('re-setting a key under new tags drops its old tag links (no over-invalidation)', () => {
    const cache = new ORPCQueryCache();
    cache.set('key', snapshot('a'), ['old']);
    cache.set('key', snapshot('b'), ['new']);

    cache.invalidate('old');
    expect(cache.get('key')).toBeDefined();

    cache.invalidate('new');
    expect(cache.get('key')).toBeUndefined();
  });

  it('invalidate drops every entry registered under the tag', () => {
    const cache = new ORPCQueryCache();
    cache.set('a', snapshot('a'), ['list']);
    cache.set('b', snapshot('b'), ['list']);
    cache.set('c', snapshot('c'), ['other']);

    cache.invalidate('list');

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBeDefined();
  });

  it('invalidate is exact-match, not a prefix match', () => {
    const cache = new ORPCQueryCache();
    cache.set('detail', snapshot('detail'), ['admin-user:1']);

    cache.invalidate('admin-user');

    expect(cache.get('detail')).toBeDefined();
  });

  it('invalidate cleans up multi-tag entries from every tag index', () => {
    const cache = new ORPCQueryCache();
    cache.set('shared', snapshot('shared'), ['tag-a', 'tag-b']);

    cache.invalidate('tag-a');
    expect(cache.get('shared')).toBeUndefined();

    cache.set('shared', snapshot('shared-2'), ['tag-b']);
    cache.invalidate('tag-b');
    expect(cache.get('shared')).toBeUndefined();
  });

  it('delete removes an entry from both the store and its tag index', () => {
    const cache = new ORPCQueryCache();
    cache.set('key', snapshot('value'), ['tag']);

    cache.delete('key');

    expect(cache.get('key')).toBeUndefined();
    cache.invalidate('tag'); // no-op, but proves the tag index no longer points at 'key'
  });

  it('clear drops every entry', () => {
    const cache = new ORPCQueryCache();
    cache.set('a', snapshot('a'), ['tag']);
    cache.set('b', snapshot('b'), []);

    cache.clear();

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeUndefined();
  });

  it('evicts the oldest entry once the LRU cap (100) is exceeded', () => {
    const cache = new ORPCQueryCache();
    for (let i = 0; i < 100; i++) {
      cache.set(`key-${i}`, snapshot(i), []);
    }

    cache.set('key-100', snapshot(100), []);

    expect(cache.get('key-0')).toBeUndefined();
    expect(cache.get('key-100')).toBeDefined();
  });

  it('honours a maxEntries override in place of the default cap', () => {
    const cache = new ORPCQueryCache({ maxEntries: 2 });
    cache.set('a', snapshot('a'), []);
    cache.set('b', snapshot('b'), []);
    cache.set('c', snapshot('c'), []);

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeDefined();
    expect(cache.get('c')).toBeDefined();
  });

  it('bounds the seed store by maxEntries independently of the wire store', () => {
    const cache = new ORPCQueryCache({ maxEntries: 2 });
    cache.setValue('seed:a', 'a', []);
    cache.setValue('seed:b', 'b', []);
    cache.setValue('seed:c', 'c', []);

    expect(cache.peekValue('seed:a')).toBeUndefined();
    expect(cache.peekValue('seed:c')).toBe('c');
  });

  it('bumps an entry to most-recently-used on read, sparing it from eviction', () => {
    const cache = new ORPCQueryCache();
    for (let i = 0; i < 100; i++) {
      cache.set(`key-${i}`, snapshot(i), []);
    }
    cache.get('key-0');

    cache.set('key-100', snapshot(100), []);

    expect(cache.get('key-0')).toBeDefined();
    expect(cache.get('key-1')).toBeUndefined();
  });

  it('setValue/peekValue round-trip a resolved output', () => {
    const cache = new ORPCQueryCache();
    cache.setValue('planet|{"id":"a"}', { name: 'a' }, ['planet:a']);

    expect(cache.peekValue('planet|{"id":"a"}')).toEqual({ name: 'a' });
    expect(cache.peekValue('missing')).toBeUndefined();
  });

  it('peekValue hands out clones — mutations never reach the stored copy', () => {
    const cache = new ORPCQueryCache();
    const original = { name: 'a' };
    cache.setValue('key', original, []);

    original.name = 'mutated-source';
    (cache.peekValue('key') as { name: string }).name = 'mutated-peek';

    expect(cache.peekValue('key')).toEqual({ name: 'a' });
  });

  it('invalidate drops values and wire snapshots under the same tag together', () => {
    const cache = new ORPCQueryCache();
    cache.set('/v1/planets/a', snapshot('wire'), ['planet:a']);
    cache.setValue('planet|{"id":"a"}', { name: 'a' }, ['planet:a']);

    cache.invalidate('planet:a');

    expect(cache.get('/v1/planets/a')).toBeUndefined();
    expect(cache.peekValue('planet|{"id":"a"}')).toBeUndefined();
  });

  it('clear drops values too', () => {
    const cache = new ORPCQueryCache();
    cache.setValue('key', 'value', []);

    cache.clear();

    expect(cache.peekValue('key')).toBeUndefined();
  });

  it('re-setting a value under new tags drops its old tag links', () => {
    const cache = new ORPCQueryCache();
    cache.setValue('key', 'a', ['old']);
    cache.setValue('key', 'b', ['new']);

    cache.invalidate('old');
    expect(cache.peekValue('key')).toBe('b');

    cache.invalidate('new');
    expect(cache.peekValue('key')).toBeUndefined();
  });

  it('caps values at 100 with LRU eviction, independent of the wire entries', () => {
    const cache = new ORPCQueryCache();
    for (let i = 0; i < 100; i++) {
      cache.setValue(`value-${i}`, i, []);
    }
    cache.set('/wire', snapshot('wire'), []);
    cache.peekValue('value-0');

    cache.setValue('value-100', 100, []);

    expect(cache.peekValue('value-0')).toBe(0);
    expect(cache.peekValue('value-1')).toBeUndefined();
    expect(cache.get('/wire')).toBeDefined();
  });
});
