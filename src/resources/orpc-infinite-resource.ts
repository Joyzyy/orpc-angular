import {
  computed,
  effect,
  inject,
  Injector,
  linkedSignal,
  resource,
  type Signal,
  untracked,
} from '@angular/core';
import type { ORPCAngularContext } from '../kernel/orpc-angular-context';
import { ORPCQueryCache } from '../kernel/orpc-query-cache';
import type { ORPCCall } from './orpc-resource';
import { onTagBump, resolveContext, resourceCallContext, stableStringify } from './resource-input';

export interface PageRange {
  offset: number;
  limit: number;
}

export interface ORPCInfiniteResourceOptions<TInput, TOutput, TItem> {
  /** `undefined` idles. A change to any signal read here restarts at the first page */
  input: (range: PageRange) => TInput | undefined;
  /**
   * Rows are dropped when this changes; any other input change keeps them until
   * the new first page lands. @default the whole input
   */
  key?: () => unknown;
  pageSize: number;
  items: (page: TOutput) => readonly TItem[];
  /** @default the page came back full: `items(page).length >= range.limit` */
  hasMore?: (page: TOutput, range: PageRange) => boolean;
  when?: () => boolean;
  /** Invalidating one of its `cache.tags` refetches every loaded row in one request */
  context?: ORPCAngularContext | (() => ORPCAngularContext);
  /**
   * Hydrates the loaded rows from SSR, with the same rules as `orpcResource`'s `id`. With
   * `cache` tags, a recreated list also comes back at full depth
   */
  id?: string;
  injector?: Injector;
}

export interface ORPCInfiniteResourceRef<TOutput, TItem, TError extends Error = Error> {
  pages: Signal<readonly TOutput[]>;
  items: Signal<TItem[]>;
  /** `false` after an error, so a scroll sentinel cannot loop on retries */
  hasMore: Signal<boolean>;
  isLoading: Signal<boolean>;
  isInitialLoading: Signal<boolean>;
  isLoadingMore: Signal<boolean>;
  error: Signal<TError | undefined>;
  loadMore(count?: number): void;
  reload(): void;
}

interface Request<TOutput> extends PageRange {
  before: readonly TOutput[];
}

interface Loaded<TOutput> {
  pages: readonly TOutput[];
  range: PageRange;
}

export function orpcInfiniteResource<TOutput, TItem, TInput, TError extends Error = Error>(
  call: ORPCCall<TInput, TOutput, TError>,
  options: ORPCInfiniteResourceOptions<TInput, TOutput, TItem>,
): ORPCInfiniteResourceRef<TOutput, TItem, TError> {
  const injector = options.injector ?? inject(Injector);
  const firstPage = (): PageRange => ({ offset: 0, limit: options.pageSize });

  const list = computed(() => options.input(firstPage()));
  const key = options.key ? computed(options.key) : list;
  const cache = injector.get(ORPCQueryCache, null);
  const seeds = cache && options.id ? cache : null;
  const seedKey = () => `seed:${options.id}|${stableStringify(untracked(list))}`;

  let loadEpoch = cache?.epoch ?? 0;

  const request = linkedSignal<unknown, Request<TOutput>>({
    source: list,
    computation: () => ({ ...firstPage(), before: [] }),
  });

  const inner = resource({
    id: options.id,
    injector,
    params: () => {
      if (options.when && !options.when()) return undefined;
      const current = request();
      const input = options.input({ offset: current.offset, limit: current.limit });
      return input === undefined ? undefined : { input, request: current };
    },
    loader: async ({ params, abortSignal, previous }): Promise<Loaded<TOutput>> => {
      if (cache) loadEpoch = cache.epoch;
      if (seeds && previous.status === 'idle') {
        const held = seeds.peekValue(seedKey()) as Loaded<TOutput> | undefined;
        if (held) return held;
      }
      const { offset, limit, before } = params.request;
      const page = await call(params.input, {
        signal: abortSignal,
        context: resourceCallContext(options),
      });
      return { pages: [...before, page], range: { offset, limit } };
    },
  });

  // angular drops value() on every params change, hold it within one key
  const loaded = linkedSignal<
    { key: unknown; value: Loaded<TOutput> | undefined },
    Loaded<TOutput> | undefined
  >({
    source: () => ({ key: key(), value: inner.hasValue() ? inner.value() : undefined }),
    computation: (current, previous) =>
      current.value ??
      (previous?.source.key === current.key ? previous?.value : undefined) ??
      (seeds?.peekValue(seedKey()) as Loaded<TOutput> | undefined),
  });

  if (seeds) {
    effect(
      () => {
        if (inner.status() !== 'resolved') return;
        const value = inner.value();
        untracked(() => {
          const tags = resolveContext(options.context)?.cache?.tags;
          if (loadEpoch === seeds.epoch && tags) seeds.setValue(seedKey(), value, tags);
        });
      },
      { injector },
    );
  }

  const pages = computed(() => loaded()?.pages ?? []);
  const items = computed(() => pages().flatMap((page) => options.items(page)));

  const hasMore = computed(() => {
    const held = loaded();
    const last = held?.pages.at(-1);
    if (!held || last === undefined || inner.status() === 'error') return false;
    return options.hasMore
      ? options.hasMore(last, held.range)
      : options.items(last).length >= held.range.limit;
  });

  // angular's reload() is a no-op while loading
  const reload = () => {
    if (untracked(inner.isLoading)) return;
    const held = untracked(loaded);
    request.set({
      offset: 0,
      limit: held ? held.range.offset + held.range.limit : options.pageSize,
      before: [],
    });
  };

  if (cache) onTagBump(cache, { ...options, injector }, reload);

  return {
    pages,
    items,
    hasMore,
    isLoading: inner.isLoading,
    isInitialLoading: computed(() => inner.isLoading() && !loaded()),
    isLoadingMore: computed(() => inner.isLoading() && request().offset > 0),
    error: computed(() => inner.error() as TError | undefined),
    loadMore: (count = options.pageSize) => {
      const held = untracked(loaded);
      if (!held || untracked(inner.isLoading) || !untracked(hasMore)) return;
      request.set({
        offset: held.range.offset + held.range.limit,
        limit: count,
        before: held.pages,
      });
    },
    reload,
  };
}
