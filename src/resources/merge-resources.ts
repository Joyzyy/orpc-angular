import { type Resource, resourceFromSnapshots } from '@angular/core';

type MergedValue<T extends Record<string, Resource<unknown>>> = {
  [K in keyof T]: T[K] extends Resource<infer V> ? Exclude<V, undefined> : never;
};

/** First error wins; any loading → loading; value only once every source is defined (`null` counts) */
export function mergeResources<T extends Record<string, Resource<unknown>>>(
  sources: T,
): Resource<MergedValue<T> | undefined> {
  const entries = Object.entries(sources) as [string, Resource<unknown>][];
  return resourceFromSnapshots<MergedValue<T> | undefined>(() => {
    const snapshots = entries.map(([key, source]) => [key, source.snapshot()] as const);
    for (const [, snapshot] of snapshots) {
      if (snapshot.status === 'error') return snapshot;
    }
    const values = snapshots.map(
      ([key, snapshot]) => [key, (snapshot as { value: unknown }).value] as const,
    );
    const value = values.every(([, held]) => held !== undefined)
      ? (Object.fromEntries(values) as MergedValue<T>)
      : undefined;
    const loading = snapshots.some(
      ([, snapshot]) => snapshot.status === 'loading' || snapshot.status === 'reloading',
    );
    if (loading) return { status: 'loading', value };
    if (snapshots.some(([, snapshot]) => snapshot.status === 'idle'))
      return { status: 'idle', value };
    return { status: 'resolved', value };
  }) as Resource<MergedValue<T> | undefined>;
}
