import { isPlatformBrowser } from '@angular/common';
import { inject, PLATFORM_ID, TransferState } from '@angular/core';
import type { ClientContext } from '@orpc/client';
import type { StandardLinkOptions, StandardLinkPlugin } from '@orpc/client/standard';
import { ORPCQueryCache } from '../kernel/orpc-query-cache';
import { TRANSFER_CACHE_WINDOW } from '../provide-orpc';
import { cacheInterceptor } from './cache-interceptor';
import { resourceGuardInterceptor } from './resource-guard-interceptor';
import { transferStateInterceptor } from './transfer-state-interceptor';

export interface ORPCAngularLinkPluginOptions {
  /**
   * Bounds a cached or deduped GET, which runs on its own signal so an abandoned caller
   * still warms the cache. @default 30_000
   */
  sharedRequestTimeout?: number;
}

/**
 * Adds the tag cache, request dedupe and SSR TransferState replay to any `StandardLink`
 * (`RPCLink`, `OpenAPILink`, ...). Construct it in an injection context, after `provideORPC()`
 */
export class ORPCAngularLinkPlugin<T extends ClientContext> implements StandardLinkPlugin<T> {
  readonly name = 'orpc-angular';

  private readonly cache = inject(ORPCQueryCache);
  private readonly window = inject(TRANSFER_CACHE_WINDOW);
  private readonly transferState = inject(TransferState);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  constructor(private readonly options: ORPCAngularLinkPluginOptions = {}) {}

  init(options: StandardLinkOptions<T>): StandardLinkOptions<T> {
    return {
      ...options,
      transportInterceptors: [
        ...(options.transportInterceptors ?? []),
        resourceGuardInterceptor<T>(),
        cacheInterceptor<T>({
          cache: this.cache,
          isBrowser: this.isBrowser,
          timeoutMs: this.options.sharedRequestTimeout ?? 30_000,
        }),
        transferStateInterceptor<T>({
          transferState: this.transferState,
          isBrowser: this.isBrowser,
          isCacheActive: () => this.window.active,
        }),
      ],
    };
  }
}
