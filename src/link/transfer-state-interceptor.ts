import { makeStateKey, type StateKey, type TransferState } from '@angular/core';
import type { ClientContext } from '@orpc/client';
import type { StandardLinkTransportInterceptor } from '@orpc/client/standard';
import type { StandardHeaders, StandardRequest } from '@standard-server/core';
import { type CachedSnapshot, toLazyResponse, toSnapshot } from '../kernel/link-snapshot';
import { operationContext } from '../kernel/orpc-angular-context';

declare const ngDevMode: boolean | undefined;

function isDevMode(): boolean {
  return typeof ngDevMode !== 'undefined' && !!ngDevMode;
}

export interface TransferStateInterceptorOptions {
  transferState: TransferState;
  isBrowser: boolean;
  isCacheActive: () => boolean;
}

// entries are not consumed on read; replay ends when isCacheActive flips
export function transferStateInterceptor<T extends ClientContext>(
  interceptorOptions: TransferStateInterceptorOptions,
): StandardLinkTransportInterceptor<T> {
  const { transferState, isBrowser, isCacheActive } = interceptorOptions;

  return async (options) => {
    const { request } = options;
    if (
      request.method !== 'GET' ||
      operationContext(options.context)?.transferCache === false ||
      !isCacheActive()
    ) {
      return options.next();
    }

    const key = cacheKey(request);

    const cached = transferState.get<CachedSnapshot | null>(key, null);
    if (cached) return toLazyResponse(cached);

    if (isBrowser) {
      // an empty store means no ssr render, so a miss is expected
      if (isDevMode() && !transferState.isEmpty) {
        console.warn(
          `[orpc-angular] TransferState miss for ${key} — the SSR render did not embed this response ` +
            `(not fetched on the server, write skipped, or the URL differs between server and browser).`,
        );
      }
      return options.next();
    }

    const snapshot = await toSnapshot(await options.next());
    if (
      isSuccess(snapshot.status) &&
      !isUncacheableResponse(snapshot.headers) &&
      isTransferable(snapshot.body)
    ) {
      transferState.set<CachedSnapshot | null>(key, {
        status: snapshot.status,
        // decoding needs only content-type; the rest would bloat the html
        headers: { 'content-type': contentType(snapshot.headers) },
        body: snapshot.body,
      });
    } else if (isDevMode()) {
      console.warn(
        `[orpc-angular] TransferState write skipped for ${key}: ${skipReason(snapshot.status, snapshot.headers)}.`,
      );
    }
    // not cloned: one caller
    return {
      status: snapshot.status,
      headers: snapshot.headers,
      resolveBody: () => Promise.resolve(snapshot.body),
    };
  };
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

function skipReason(status: number, headers: StandardHeaders): string {
  if (!isSuccess(status)) return `status ${status}`;
  if (headers['set-cookie'] !== undefined) return 'response sets a cookie';
  if (isUncacheableResponse(headers)) return `cache-control: ${String(headers['cache-control'])}`;
  return 'body is not plain JSON';
}

function contentType(headers: StandardHeaders): string | undefined {
  const value = headers['content-type'];
  return Array.isArray(value) ? value[0] : value;
}

const UNCACHEABLE_CACHE_CONTROL_DIRECTIVES = new Set(['no-store', 'no-cache', 'private']);

// ssr html may be cdn-cached, so embedded state must not carry per-user data
function isUncacheableResponse(headers: StandardHeaders): boolean {
  if (headers['set-cookie'] !== undefined) return true;
  const cacheControl = headers['cache-control'];
  const value = Array.isArray(cacheControl) ? cacheControl.join(',') : cacheControl;
  if (value === undefined) return false;
  return value
    .split(',')
    .some((directive) =>
      UNCACHEABLE_CACHE_CONTROL_DIRECTIVES.has(directive.split('=')[0].trim().toLowerCase()),
    );
}

// request.url is origin-less, so server and browser key identically
function cacheKey(request: StandardRequest): StateKey<CachedSnapshot | null> {
  const [pathname, rawSearch = ''] = request.url.split('?');
  const params = new URLSearchParams(rawSearch);
  params.sort();
  const search = params.toString();
  return makeStateKey(`orpc:GET:${pathname}${search ? `?${search}` : ''}`);
}

function isTransferable(body: unknown): boolean {
  if (body === undefined) return false;
  if (body === null) return true;
  if (typeof body !== 'object') return true;
  const proto = Object.getPrototypeOf(body);
  return Array.isArray(body) || proto === Object.prototype || proto === null;
}
