import { signal, type Signal, type WritableSignal } from '@angular/core';
import type { CachedSnapshot } from './link-snapshot';
import { ORPCCache } from './orpc-cache';

interface CacheEntry {
  snapshot: Promise<CachedSnapshot>;
  tags: string[];
}

interface ValueEntry {
  value: unknown;
  tags: string[];
}

const DEFAULT_MAX_ENTRIES = 100;

export interface ORPCQueryCacheOptions {
  onInvalidate?: () => void;
  maxEntries?: number;
}

// keyed by url alone (no vary): anything that changes a body must be procedure input, never a header
// one instance per app: shared across ssr requests it leaks one user's responses to another
export class ORPCQueryCache extends ORPCCache {
  // a seed write from a load older than this is dropped
  epoch = 0;

  private readonly entries = new Map<string, CacheEntry>();
  // shares a key space with `entries`; `seed:` keys cannot collide with urls
  private readonly values = new Map<string, ValueEntry>();
  private readonly tagIndex = new Map<string, Set<string>>();
  private readonly tagVersions = new Map<string, WritableSignal<number>>();

  private readonly onInvalidate?: () => void;
  private readonly maxEntries: number;

  constructor(options: ORPCQueryCacheOptions = {}) {
    super();
    this.onInvalidate = options.onInvalidate;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  get(key: string): Promise<CachedSnapshot> | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.snapshot;
  }

  set(key: string, snapshot: Promise<CachedSnapshot>, tags: string[]): void {
    this.delete(key);
    if (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) this.delete(oldestKey);
    }
    this.entries.set(key, { snapshot, tags });
    this.indexTags(key, tags);
  }

  setValue(key: string, value: unknown, tags: string[]): void {
    this.delete(key);
    if (this.values.size >= this.maxEntries) {
      const oldestKey = this.values.keys().next().value;
      if (oldestKey !== undefined) this.delete(oldestKey);
    }
    this.values.set(key, { value: structuredClone(value), tags });
    this.indexTags(key, tags);
  }

  peekValue(key: string): unknown {
    const entry = this.values.get(key);
    if (!entry) return undefined;
    this.values.delete(key);
    this.values.set(key, entry);
    return structuredClone(entry.value);
  }

  deleteIfCurrent(key: string, snapshot: Promise<CachedSnapshot>): void {
    if (this.entries.get(key)?.snapshot === snapshot) this.delete(key);
  }

  delete(key: string): void {
    const entry = this.entries.get(key) ?? this.values.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.values.delete(key);
    for (const tag of entry.tags) {
      const keys = this.tagIndex.get(tag);
      if (!keys) continue;
      keys.delete(key);
      if (keys.size === 0) this.tagIndex.delete(tag);
    }
  }

  tagVersion(tag: string): Signal<number> {
    let version = this.tagVersions.get(tag);
    if (!version) {
      version = signal(0);
      this.tagVersions.set(tag, version);
    }
    return version;
  }

  invalidate(...tags: string[]): void {
    this.epoch++;
    this.onInvalidate?.();
    for (const tag of tags) {
      const keys = this.tagIndex.get(tag);
      if (keys) for (const key of keys) this.delete(key);
      this.tagVersions.get(tag)?.update((version) => version + 1);
    }
  }

  clear(): void {
    this.epoch++;
    this.entries.clear();
    this.values.clear();
    this.tagIndex.clear();
  }

  invalidateAll(): void {
    this.clear();
    this.onInvalidate?.();
    for (const version of this.tagVersions.values()) version.update((v) => v + 1);
  }

  private indexTags(key: string, tags: string[]): void {
    for (const tag of tags) {
      const keys = this.tagIndex.get(tag) ?? new Set<string>();
      keys.add(key);
      this.tagIndex.set(tag, keys);
    }
  }
}
