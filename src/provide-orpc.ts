import {
  APP_BOOTSTRAP_LISTENER,
  ApplicationRef,
  type EnvironmentProviders,
  inject,
  InjectionToken,
  makeEnvironmentProviders,
} from '@angular/core';
import { ORPCCache } from './kernel/orpc-cache';
import { ORPCQueryCache } from './kernel/orpc-query-cache';

export interface ProvideORPCOptions {
  /** LRU bound for each store. @default 100 */
  maxCacheEntries?: number;
}

// false once the app is stable or a tag is invalidated
export const TRANSFER_CACHE_WINDOW = new InjectionToken<{ active: boolean }>(
  'ORPC_ANGULAR_TRANSFER_CACHE_WINDOW',
);

/** Provides the cache and the SSR TransferState window. Provide it in the application root */
export function provideORPC(options: ProvideORPCOptions = {}): EnvironmentProviders {
  return makeEnvironmentProviders([
    { provide: TRANSFER_CACHE_WINDOW, useFactory: () => ({ active: true }) },
    {
      provide: ORPCQueryCache,
      useFactory: () => {
        const window = inject(TRANSFER_CACHE_WINDOW);
        return new ORPCQueryCache({
          maxEntries: options.maxCacheEntries,
          onInvalidate: () => {
            window.active = false;
          },
        });
      },
    },
    { provide: ORPCCache, useExisting: ORPCQueryCache },
    {
      provide: APP_BOOTSTRAP_LISTENER,
      multi: true,
      useFactory: () => {
        const appRef = inject(ApplicationRef);
        const window = inject(TRANSFER_CACHE_WINDOW);
        return () => {
          appRef.whenStable().then(() => {
            window.active = false;
          });
        };
      },
    },
  ]);
}
