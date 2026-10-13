import {
  type BaseResourceOptions,
  computed,
  effect,
  inject,
  Injector,
  type Resource,
  resource,
  resourceFromSnapshots,
  type ResourceParamsContext,
  ResourceParamsStatus,
  type ResourceRef,
  type Signal,
  untracked,
  type ValueEqualityFn,
} from '@angular/core';
import type { PromiseWithError } from '@orpc/client';
import type { ORPCAngularContext } from '../kernel/orpc-angular-context';
import { ORPCQueryCache } from '../kernel/orpc-query-cache';
import { replaceEqualDeep } from '../kernel/replace-equal-deep';
import {
  onTagBump,
  procedureInput,
  resolveContext,
  resourceCallContext,
  resourceParams,
  stableStringify,
} from './resource-input';

/** A procedure client, or any function shaped like one */
export type ORPCCall<TInput, TOutput, TError = Error> = (
  input: TInput,
  options?: { signal?: AbortSignal; context?: ORPCAngularContext },
) => PromiseWithError<TOutput, TError>;

export interface ORPCResourceRef<T, TError extends Error = Error> extends Resource<T> {
  readonly error: Signal<TError | undefined>;
  reload(): boolean;
  destroy(): void;
  // redeclared so narrowing keeps `reload`
  hasValue(
    this: T extends undefined ? this : never,
  ): this is ORPCResourceRef<Exclude<T, undefined>, TError>;
  hasValue(): boolean;
}

// pick, not omit: a new angular option must be listed here before it reaches resource()
export interface ORPCResourceOptions<TOutput = unknown, TInput = undefined> extends Pick<
  BaseResourceOptions<TOutput, unknown>,
  'defaultValue' | 'injector'
> {
  /** `undefined` idles */
  input?: (ctx: ResourceParamsContext) => TInput | undefined;
  when?: () => boolean;
  /** Not reactive. Invalidating one of its `cache.tags` reloads */
  context?: ORPCAngularContext | (() => ORPCAngularContext);
  /**
   * Static key, unique per declaration, that hydrates the value from SSR. Skips the
   * no-store/set-cookie guards. Use one procedure per `id`: with `cache` tags it also keys
   * the client-side seed
   */
  id?: string;
  /** Without `defaultValue`, never dedups across a `when` gate cycle: Angular uses `===` when either side is `undefined` */
  equal?: ValueEqualityFn<TOutput>;
  debugName?: string;
}

/** GET procedures only. `value()` throws in the error state: read it behind `hasValue()` */
export function orpcResource<TOutput, TInput = undefined, TError extends Error = Error>(
  call: ORPCCall<TInput, TOutput, TError>,
  options: ORPCResourceOptions<TOutput, TInput> & { defaultValue: NoInfer<TOutput> },
): ORPCResourceRef<TOutput, TError>;
export function orpcResource<TOutput, TInput = undefined, TError extends Error = Error>(
  call: ORPCCall<TInput, TOutput, TError>,
  options?: ORPCResourceOptions<TOutput, TInput>,
): ORPCResourceRef<TOutput | undefined, TError>;
export function orpcResource<TOutput, TInput = undefined, TError extends Error = Error>(
  call: ORPCCall<TInput, TOutput, TError>,
  options?: ORPCResourceOptions<TOutput, TInput>,
): ORPCResourceRef<TOutput | undefined, TError> {
  const cache =
    options?.id || options?.context
      ? (options?.injector ?? inject(Injector)).get(ORPCQueryCache, null)
      : null;

  let loadEpoch = cache?.epoch ?? 0;

  const seedKey = (params: unknown) => `seed:${options?.id}|${stableStringify(params)}`;

  let lastLoaded: TOutput | undefined;
  const share = (value: TOutput): TOutput => (lastLoaded = replaceEqualDeep(lastLoaded, value));

  const inner = resource({
    id: options?.id,
    defaultValue: options?.defaultValue,
    equal: options?.equal,
    injector: options?.injector,
    debugName: options?.debugName,
    params: (ctx) => resourceParams(options, ctx),
    loader: ({ params, abortSignal, previous }) => {
      if (cache) loadEpoch = cache.epoch;
      if (cache && options?.id && previous.status === 'idle') {
        const held = cache.peekValue(seedKey(params));
        if (held !== undefined) return Promise.resolve(share(held as TOutput));
      }
      return call(procedureInput(options, params), {
        signal: abortSignal,
        context: resourceCallContext(options),
      }).then(share);
    },
  });

  if (!cache) return inner as ORPCResourceRef<TOutput | undefined, TError>;

  onTagBump(cache, options, () => inner.reload());

  if (!options?.id) return inner as ORPCResourceRef<TOutput | undefined, TError>;

  const seedParams = () => {
    try {
      return resourceParams(options, peekContext);
    } catch {
      return undefined;
    }
  };

  effect(
    () => {
      const snapshot = inner.snapshot();
      if (snapshot.status !== 'resolved') return;
      untracked(() => {
        if (loadEpoch !== cache.epoch) return;
        const context = resolveContext(options?.context);
        const params = seedParams();
        if (context?.cache && params !== undefined) {
          cache.setValue(seedKey(params), snapshot.value, context.cache.tags);
        }
      });
    },
    { injector: options?.injector },
  );

  return withSeed<TOutput, TError>(inner, () => {
    const params = seedParams();
    return params === undefined
      ? undefined
      : (cache.peekValue(seedKey(params)) as TOutput | undefined);
  });
}

// angular's params context is internal to `resource()`, any throw means no seed
const peekContext: ResourceParamsContext = {
  chain: (other) => {
    const snapshot = other.snapshot();
    if (snapshot.status === 'resolved' || snapshot.status === 'local') return snapshot.value;
    throw ResourceParamsStatus.LOADING;
  },
};

function withSeed<T, TError extends Error>(
  inner: ResourceRef<T | undefined>,
  peek: () => T | undefined,
): ORPCResourceRef<T | undefined, TError> {
  const peeked = computed(peek);
  const seeded = resourceFromSnapshots<T | undefined>(() => {
    const snapshot = inner.snapshot();
    if (snapshot.status !== 'loading' || snapshot.value !== undefined) return snapshot;
    const held = peeked();
    return held === undefined ? snapshot : { status: 'resolved', value: held };
  });

  return Object.assign(seeded, {
    reload: () => inner.reload(),
    destroy: () => inner.destroy(),
  }) as ORPCResourceRef<T | undefined, TError>;
}
