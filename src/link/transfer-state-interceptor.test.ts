import { ORPC_ANGULAR_CONTEXT_SYMBOL } from '../kernel/orpc-angular-context';
import type { StateKey, TransferState } from '@angular/core';
import type { ClientOptions } from '@orpc/client';
import type { StandardLinkTransport } from '@orpc/client/standard';
import type { StandardHeaders, StandardLazyResponse, StandardRequest } from '@standard-server/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ORPCAngularContext } from '../kernel/orpc-angular-context';
import { asTransport } from '../../tests/as-transport';
import { transferStateInterceptor } from './transfer-state-interceptor';

function request(overrides: Partial<StandardRequest> = {}): StandardRequest {
  return {
    method: 'GET',
    url: '/things/1',
    headers: {},
    body: undefined,
    signal: undefined,
    ...overrides,
  };
}

function options(): ClientOptions<ORPCAngularContext> {
  return { context: {} };
}

function okResponse(body: unknown, headers: StandardHeaders = {}): StandardLazyResponse {
  return { status: 200, headers, resolveBody: () => Promise.resolve(body) };
}

function fakeTransferState(): TransferState {
  const store = new Map<string, unknown>();
  return {
    get: <T>(key: StateKey<T>, defaultValue: T) =>
      store.has(key as string) ? (store.get(key as string) as T) : defaultValue,
    set: <T>(key: StateKey<T>, value: T) => void store.set(key as string, value),
    remove: <T>(key: StateKey<T>) => void store.delete(key as string),
    get isEmpty() {
      return store.size === 0;
    },
  } as unknown as TransferState;
}

function serverThenBrowser(
  response: StandardLazyResponse,
  isCacheActive: () => boolean = () => true,
) {
  const transferState = fakeTransferState();
  const inner: StandardLinkTransport<ORPCAngularContext> = { send: vi.fn(async () => response) };
  const server = asTransport(
    transferStateInterceptor({
      transferState,
      isBrowser: false,
      isCacheActive,
    }),
    inner,
  );
  const browser = asTransport(
    transferStateInterceptor({
      transferState,
      isBrowser: true,
      isCacheActive,
    }),
    inner,
  );
  return { inner, server, browser };
}

describe('TransferStateLinkTransport', () => {
  it('replays a server-stored GET for every matching browser call until stability', async () => {
    const { inner, server, browser } = serverThenBrowser(okResponse({ value: 1 }));

    await server.send(request(), [], options());
    const first = await browser.send(request(), [], options());
    const second = await browser.send(request(), [], options());

    await expect(first.resolveBody()).resolves.toEqual({ value: 1 });
    await expect(second.resolveBody()).resolves.toEqual({ value: 1 });
    expect(inner.send).toHaveBeenCalledTimes(1);
  });

  it('serves repeated server-side GETs for the same URL from the stored entry', async () => {
    const { inner, server } = serverThenBrowser(okResponse({ value: 1 }));

    await server.send(request(), [], options());
    const deduped = await server.send(request(), [], options());

    await expect(deduped.resolveBody()).resolves.toEqual({ value: 1 });
    expect(inner.send).toHaveBeenCalledTimes(1);
  });

  it('isolates replayed bodies — mutating one replay does not poison the next', async () => {
    const { server, browser } = serverThenBrowser(okResponse({ value: 1 }));

    await server.send(request(), [], options());
    const first = await (await browser.send(request(), [], options())).resolveBody();
    (first as { value: number }).value = 99;
    const second = await (await browser.send(request(), [], options())).resolveBody();

    expect(second).toEqual({ value: 1 });
  });

  it('matches keys across query-param order', async () => {
    const { inner, server, browser } = serverThenBrowser(okResponse({ value: 1 }));

    await server.send(request({ url: '/things/1?b=2&a=1' }), [], options());
    const replayed = await browser.send(request({ url: '/things/1?a=1&b=2' }), [], options());

    await expect(replayed.resolveBody()).resolves.toEqual({ value: 1 });
    expect(inner.send).toHaveBeenCalledTimes(1);
  });

  it('does not store non-2xx responses', async () => {
    const { inner, server, browser } = serverThenBrowser({
      status: 304,
      headers: {},
      resolveBody: () => Promise.resolve(null),
    });

    await server.send(request(), [], options());
    await browser.send(request(), [], options());

    expect(inner.send).toHaveBeenCalledTimes(2);
  });

  it('does not store a response carrying set-cookie', async () => {
    const { inner, server, browser } = serverThenBrowser(
      okResponse({ value: 1 }, { 'set-cookie': 'session=abc' }),
    );

    await server.send(request(), [], options());
    await browser.send(request(), [], options());

    expect(inner.send).toHaveBeenCalledTimes(2);
  });

  it.each(['no-store', 'no-cache', 'private, max-age=0'])(
    'does not store a response marked cache-control: %s',
    async (cacheControl) => {
      const { inner, server, browser } = serverThenBrowser(
        okResponse({ value: 1 }, { 'cache-control': cacheControl }),
      );

      await server.send(request(), [], options());
      await browser.send(request(), [], options());

      expect(inner.send).toHaveBeenCalledTimes(2);
    },
  );

  it('still stores a response with a cacheable cache-control', async () => {
    const { inner, server, browser } = serverThenBrowser(
      okResponse({ value: 1 }, { 'cache-control': 'public, max-age=60' }),
    );

    await server.send(request(), [], options());
    await browser.send(request(), [], options());

    expect(inner.send).toHaveBeenCalledTimes(1);
  });

  it('stops replaying a stored GET once the cache is inactive', async () => {
    let active = true;
    const { inner, server, browser } = serverThenBrowser(okResponse({ value: 1 }), () => active);

    await server.send(request(), [], options());
    active = false;
    await browser.send(request(), [], options());

    expect(inner.send).toHaveBeenCalledTimes(2);
  });

  it('does not store responses on the server once the cache is inactive', async () => {
    let active = false;
    const { inner, server, browser } = serverThenBrowser(okResponse({ value: 1 }), () => active);

    await server.send(request(), [], options());
    active = true;
    await browser.send(request(), [], options());

    expect(inner.send).toHaveBeenCalledTimes(2);
  });

  it('passes non-GET requests through untouched on both sides', async () => {
    const { inner, server, browser } = serverThenBrowser(okResponse({ value: 1 }));

    await server.send(request({ method: 'POST' }), [], options());
    await browser.send(request({ method: 'POST' }), [], options());

    expect(inner.send).toHaveBeenCalledTimes(2);
  });

  it('neither stores nor replays when the call context sets transferCache: false', async () => {
    const { inner, server, browser } = serverThenBrowser(okResponse({ value: 1 }));
    const optOut = {
      context: { [ORPC_ANGULAR_CONTEXT_SYMBOL]: { transferCache: false as const } },
    };

    await server.send(request(), [], optOut);
    await browser.send(request(), [], optOut);

    expect(inner.send).toHaveBeenCalledTimes(2);
  });

  describe('dev-mode warnings', () => {
    const globals = globalThis as { ngDevMode?: boolean };

    beforeEach(() => {
      globals.ngDevMode = true;
      vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      delete globals.ngDevMode;
      vi.restoreAllMocks();
    });

    it('warns when the server skips a write, naming the reason', async () => {
      const { server } = serverThenBrowser(
        okResponse({ value: 1 }, { 'cache-control': 'no-store' }),
      );

      await server.send(request(), [], options());

      expect(console.warn).toHaveBeenCalledWith(
        expect.stringMatching(/write skipped for .+: cache-control: no-store/),
      );
    });

    it('warns when a browser GET misses while the store holds SSR state', async () => {
      const { server, browser } = serverThenBrowser(okResponse({ value: 1 }));

      await server.send(request({ url: '/other' }), [], options());
      await browser.send(request(), [], options());

      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('TransferState miss'));
    });

    it('stays silent on a miss when the store is empty (no SSR render happened)', async () => {
      const { browser } = serverThenBrowser(okResponse({ value: 1 }));

      await browser.send(request(), [], options());

      expect(console.warn).not.toHaveBeenCalled();
    });

    it('stays silent when the response is stored and replayed', async () => {
      const { server, browser } = serverThenBrowser(okResponse({ value: 1 }));

      await server.send(request(), [], options());
      await browser.send(request(), [], options());

      expect(console.warn).not.toHaveBeenCalled();
    });

    it('stays silent outside dev mode', async () => {
      delete globals.ngDevMode;
      const { browser } = serverThenBrowser(okResponse({ value: 1 }));

      await browser.send(request(), [], options());

      expect(console.warn).not.toHaveBeenCalled();
    });
  });
});
