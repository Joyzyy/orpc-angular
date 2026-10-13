import type { ClientContext } from '@orpc/client';
import type { StandardLinkTransportInterceptor } from '@orpc/client/standard';
import {
  type CachedSnapshot,
  isBrowserGet,
  toLazyResponse,
  toSnapshot,
} from '../kernel/link-snapshot';
import type { ORPCAngularContext } from '../kernel/orpc-angular-context';
import type { ORPCQueryCache } from '../kernel/orpc-query-cache';

export interface CacheInterceptorOptions {
  cache: ORPCQueryCache;
  isBrowser: boolean;
  timeoutMs: number;
}

export function cacheInterceptor<T extends ClientContext>(
  interceptorOptions: CacheInterceptorOptions,
): StandardLinkTransportInterceptor<T> {
  const { cache, isBrowser, timeoutMs } = interceptorOptions;

  return async (options) => {
    const context = options.context as ORPCAngularContext | undefined;
    const directive = context?.cache;

    if ((!directive && !context?.dedupe) || !isBrowserGet(options.request, isBrowser)) {
      return options.next();
    }

    const key = options.request.url;

    const cached = cache.get(key);
    if (cached) {
      return toLazyResponse(await cached);
    }

    // an abandoned get still completes and warms the cache
    const pending: Promise<CachedSnapshot> = options
      .next({ ...options, signal: AbortSignal.timeout(timeoutMs) })
      .then(toSnapshot)
      .then(
        (snapshot) => {
          if (!directive || snapshot.status >= 400) cache.deleteIfCurrent(key, pending);
          return snapshot;
        },
        (error: unknown) => {
          cache.deleteIfCurrent(key, pending);
          throw error;
        },
      );
    cache.set(key, pending, directive?.tags ?? []);
    return toLazyResponse(await pending);
  };
}
