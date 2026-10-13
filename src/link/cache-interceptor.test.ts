import type { ClientOptions } from '@orpc/client';
import type { StandardLinkTransport } from '@orpc/client/standard';
import type { StandardLazyResponse, StandardRequest } from '@standard-server/core';
import { describe, expect, it, vi } from 'vitest';
import { asTransport } from '../../tests/as-transport';
import { cacheInterceptor } from './cache-interceptor';
import type { ORPCAngularContext } from '../kernel/orpc-angular-context';
import { ORPCQueryCache } from '../kernel/orpc-query-cache';

const TIMEOUT_MS = 30_000;

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

function options(
  context: ORPCAngularContext = {},
  signal?: AbortSignal,
): ClientOptions<ORPCAngularContext> {
  return { context, signal };
}

function okResponse(body: unknown, status = 200): StandardLazyResponse {
  return { status, headers: {}, resolveBody: () => Promise.resolve(body) };
}

describe('CacheLinkTransport', () => {
  it('bypasses the cache for non-GET requests even with a cache directive', async () => {
    const inner: StandardLinkTransport<ORPCAngularContext> = {
      send: vi.fn(async () => okResponse('x')),
    };
    const link = asTransport(
      cacheInterceptor({
        cache: new ORPCQueryCache(),
        isBrowser: true,
        timeoutMs: TIMEOUT_MS,
      }),
      inner,
    );

    await link.send(request({ method: 'POST' }), [], options({ cache: { tags: ['t'] } }));
    await link.send(request({ method: 'POST' }), [], options({ cache: { tags: ['t'] } }));

    expect(inner.send).toHaveBeenCalledTimes(2);
  });

  it('bypasses the cache when no cache directive is present', async () => {
    const inner: StandardLinkTransport<ORPCAngularContext> = {
      send: vi.fn(async () => okResponse('x')),
    };
    const link = asTransport(
      cacheInterceptor({
        cache: new ORPCQueryCache(),
        isBrowser: true,
        timeoutMs: TIMEOUT_MS,
      }),
      inner,
    );

    await link.send(request(), [], options());
    await link.send(request(), [], options());

    expect(inner.send).toHaveBeenCalledTimes(2);
  });

  it('bypasses the cache entirely on the server (isBrowser: false)', async () => {
    const inner: StandardLinkTransport<ORPCAngularContext> = {
      send: vi.fn(async () => okResponse('x')),
    };
    const link = asTransport(
      cacheInterceptor({
        cache: new ORPCQueryCache(),
        isBrowser: false,
        timeoutMs: TIMEOUT_MS,
      }),
      inner,
    );

    await link.send(request(), [], options({ cache: { tags: ['t'] } }));
    await link.send(request(), [], options({ cache: { tags: ['t'] } }));

    expect(inner.send).toHaveBeenCalledTimes(2);
  });

  it('never passes a caller signal to the shared fetch — it gets its own timeout bound instead; an aborted caller still resolves and caches', async () => {
    let innerOptions!: ClientOptions<ORPCAngularContext>;
    const inner: StandardLinkTransport<ORPCAngularContext> = {
      send: vi.fn(async (_req, _path, opts: ClientOptions<ORPCAngularContext>) => {
        innerOptions = opts;
        return okResponse('shared');
      }),
    };
    const cache = new ORPCQueryCache();
    const link = asTransport(
      cacheInterceptor({ cache, isBrowser: true, timeoutMs: TIMEOUT_MS }),
      inner,
    );

    const controller = new AbortController();
    const call = link.send(request(), [], options({ cache: { tags: ['t'] } }, controller.signal));
    controller.abort();

    const result = await call;
    expect(innerOptions.signal).not.toBe(controller.signal);
    expect(innerOptions.signal?.aborted).toBe(false);
    await expect(result.resolveBody()).resolves.toBe('shared');
    expect(cache.get(request().url)).toBeDefined();
  });

  it('dedup: the first caller aborting affects neither the inner fetch nor other callers', async () => {
    let resolveInner!: (response: StandardLazyResponse) => void;
    const inner: StandardLinkTransport<ORPCAngularContext> = {
      send: vi.fn(
        () =>
          new Promise<StandardLazyResponse>((resolve) => {
            resolveInner = resolve;
          }),
      ),
    };
    const cache = new ORPCQueryCache();
    const link = asTransport(
      cacheInterceptor({ cache, isBrowser: true, timeoutMs: TIMEOUT_MS }),
      inner,
    );

    const firstController = new AbortController();
    const first = link.send(
      request(),
      [],
      options({ cache: { tags: ['t'] } }, firstController.signal),
    );
    const second = link.send(request(), [], options({ cache: { tags: ['t'] } }));
    firstController.abort();
    resolveInner(okResponse('shared'));

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(inner.send).toHaveBeenCalledTimes(1);
    await expect(firstResult.resolveBody()).resolves.toBe('shared');
    await expect(secondResult.resolveBody()).resolves.toBe('shared');
    expect(cache.get(request().url)).toBeDefined();
  });

  it('serves a cache hit without calling inner a second time', async () => {
    const inner: StandardLinkTransport<ORPCAngularContext> = {
      send: vi.fn(async () => okResponse({ value: 1 })),
    };
    const link = asTransport(
      cacheInterceptor({
        cache: new ORPCQueryCache(),
        isBrowser: true,
        timeoutMs: TIMEOUT_MS,
      }),
      inner,
    );

    const first = await link.send(request(), [], options({ cache: { tags: ['t'] } }));
    const second = await link.send(request(), [], options({ cache: { tags: ['t'] } }));

    expect(inner.send).toHaveBeenCalledTimes(1);
    await expect(first.resolveBody()).resolves.toEqual({ value: 1 });
    await expect(second.resolveBody()).resolves.toEqual({ value: 1 });
  });

  it('serves each consumer a clone — mutating one result cannot poison the cache', async () => {
    const inner: StandardLinkTransport<ORPCAngularContext> = {
      send: vi.fn(async () => okResponse({ items: [1, 2, 3] })),
    };
    const link = asTransport(
      cacheInterceptor({
        cache: new ORPCQueryCache(),
        isBrowser: true,
        timeoutMs: TIMEOUT_MS,
      }),
      inner,
    );

    const first = await link.send(request(), [], options({ cache: { tags: ['t'] } }));
    const firstBody = (await first.resolveBody()) as { items: number[] };
    firstBody.items.push(999);

    const second = await link.send(request(), [], options({ cache: { tags: ['t'] } }));

    expect(inner.send).toHaveBeenCalledTimes(1);
    await expect(second.resolveBody()).resolves.toEqual({ items: [1, 2, 3] });
  });

  it('dedupes concurrent identical GETs onto a single in-flight call', async () => {
    let resolveInner!: (response: StandardLazyResponse) => void;
    const inner: StandardLinkTransport<ORPCAngularContext> = {
      send: vi.fn(
        () =>
          new Promise<StandardLazyResponse>((resolve) => {
            resolveInner = resolve;
          }),
      ),
    };
    const link = asTransport(
      cacheInterceptor({
        cache: new ORPCQueryCache(),
        isBrowser: true,
        timeoutMs: TIMEOUT_MS,
      }),
      inner,
    );

    const first = link.send(request(), [], options({ cache: { tags: ['t'] } }));
    const second = link.send(request(), [], options({ cache: { tags: ['t'] } }));

    resolveInner(okResponse('shared'));

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(inner.send).toHaveBeenCalledTimes(1);
    await expect(firstResult.resolveBody()).resolves.toBe('shared');
    await expect(secondResult.resolveBody()).resolves.toBe('shared');
  });

  it('does not cache error responses (status >= 400) and refetches next call', async () => {
    const inner: StandardLinkTransport<ORPCAngularContext> = {
      send: vi
        .fn()
        .mockResolvedValueOnce(okResponse('error body', 500))
        .mockResolvedValueOnce(okResponse('ok body', 200)),
    };
    const link = asTransport(
      cacheInterceptor({
        cache: new ORPCQueryCache(),
        isBrowser: true,
        timeoutMs: TIMEOUT_MS,
      }),
      inner,
    );

    const first = await link.send(request(), [], options({ cache: { tags: ['t'] } }));
    expect(first.status).toBe(500);

    const second = await link.send(request(), [], options({ cache: { tags: ['t'] } }));
    expect(second.status).toBe(200);
    expect(inner.send).toHaveBeenCalledTimes(2);
  });

  it('does not cache a rejected inner call and refetches next call', async () => {
    const inner: StandardLinkTransport<ORPCAngularContext> = {
      send: vi
        .fn()
        .mockRejectedValueOnce(new Error('network down'))
        .mockResolvedValueOnce(okResponse('ok body', 200)),
    };
    const link = asTransport(
      cacheInterceptor({
        cache: new ORPCQueryCache(),
        isBrowser: true,
        timeoutMs: TIMEOUT_MS,
      }),
      inner,
    );

    await expect(link.send(request(), [], options({ cache: { tags: ['t'] } }))).rejects.toThrow(
      'network down',
    );

    const second = await link.send(request(), [], options({ cache: { tags: ['t'] } }));
    expect(second.status).toBe(200);
    expect(inner.send).toHaveBeenCalledTimes(2);
  });

  it('an invalidated entry settling in error does not evict the entry that replaced it', async () => {
    const resolvers: ((response: StandardLazyResponse) => void)[] = [];
    const inner: StandardLinkTransport<ORPCAngularContext> = {
      send: vi.fn(
        () =>
          new Promise<StandardLazyResponse>((resolve) => {
            resolvers.push(resolve);
          }),
      ),
    };
    const cache = new ORPCQueryCache();
    const link = asTransport(
      cacheInterceptor({ cache, isBrowser: true, timeoutMs: TIMEOUT_MS }),
      inner,
    );

    const stale = link.send(request(), [], options({ cache: { tags: ['t'] } }));
    cache.invalidate('t');
    const fresh = link.send(request(), [], options({ cache: { tags: ['t'] } }));

    // the invalidated call settles 4xx afterwards; its cleanup must target its own entry
    resolvers[0]!(okResponse('gone', 404));
    await stale;
    resolvers[1]!(okResponse('current'));
    await fresh;

    expect(cache.get(request().url)).toBeDefined();
    const replay = await link.send(request(), [], options({ cache: { tags: ['t'] } }));
    expect(inner.send).toHaveBeenCalledTimes(2);
    await expect(replay.resolveBody()).resolves.toBe('current');
  });

  it('invalidate(tag) drops the entry so the next call refetches', async () => {
    const inner: StandardLinkTransport<ORPCAngularContext> = {
      send: vi
        .fn()
        .mockResolvedValueOnce(okResponse('first'))
        .mockResolvedValueOnce(okResponse('second')),
    };
    const cache = new ORPCQueryCache();
    const link = asTransport(
      cacheInterceptor({ cache, isBrowser: true, timeoutMs: TIMEOUT_MS }),
      inner,
    );

    await link.send(request(), [], options({ cache: { tags: ['t'] } }));
    cache.invalidate('t');
    const second = await link.send(request(), [], options({ cache: { tags: ['t'] } }));

    expect(inner.send).toHaveBeenCalledTimes(2);
    await expect(second.resolveBody()).resolves.toBe('second');
  });
});

const DEDUPE: ORPCAngularContext = { dedupe: true };

function pendingInner() {
  const resolvers: ((response: StandardLazyResponse) => void)[] = [];
  const send = vi.fn(
    () =>
      new Promise<StandardLazyResponse>((resolve) => {
        resolvers.push(resolve);
      }),
  );
  return {
    transport: { send } satisfies StandardLinkTransport<ORPCAngularContext>,
    send,
    resolvers,
  };
}

describe('CacheLinkTransport dedupe directive', () => {
  it('joins concurrent callers onto one request, then refetches once it settled — join, not memoize', async () => {
    const { transport, send, resolvers } = pendingInner();
    const link = asTransport(
      cacheInterceptor({
        cache: new ORPCQueryCache(),
        isBrowser: true,
        timeoutMs: TIMEOUT_MS,
      }),
      transport,
    );

    const joined = [
      link.send(request(), [], options(DEDUPE)),
      link.send(request(), [], options(DEDUPE)),
    ];
    resolvers[0]!(okResponse('shared'));
    for (const result of await Promise.all(joined)) {
      await expect(result.resolveBody()).resolves.toBe('shared');
    }

    const later = link.send(request(), [], options(DEDUPE));
    resolvers[1]!(okResponse('fresh'));

    expect(send).toHaveBeenCalledTimes(2);
    await expect((await later).resolveBody()).resolves.toBe('fresh');
  });

  it('propagates a rejection to every joined caller and clears the key', async () => {
    const inner: StandardLinkTransport<ORPCAngularContext> = {
      send: vi
        .fn()
        .mockRejectedValueOnce(new Error('down'))
        .mockResolvedValueOnce(okResponse('ok')),
    };
    const link = asTransport(
      cacheInterceptor({
        cache: new ORPCQueryCache(),
        isBrowser: true,
        timeoutMs: TIMEOUT_MS,
      }),
      inner,
    );

    const first = link.send(request(), [], options(DEDUPE));
    const joined = link.send(request(), [], options(DEDUPE));
    await expect(first).rejects.toThrow('down');
    await expect(joined).rejects.toThrow('down');

    const third = await link.send(request(), [], options(DEDUPE));
    expect(third.status).toBe(200);
    expect(inner.send).toHaveBeenCalledTimes(2);
  });

  it('clear() drops a flight, and that flight settling later does not evict its replacement', async () => {
    const { transport, send, resolvers } = pendingInner();
    const cache = new ORPCQueryCache();
    const link = asTransport(
      cacheInterceptor({
        cache,
        isBrowser: true,
        timeoutMs: TIMEOUT_MS,
      }),
      transport,
    );

    const outgoing = link.send(request(), [], options(DEDUPE));
    cache.clear();
    const incoming = link.send(request(), [], options(DEDUPE));
    resolvers[0]!(okResponse('previous user'));
    await outgoing;

    const joiner = link.send(request(), [], options(DEDUPE));
    resolvers[1]!(okResponse('current user'));

    expect(send).toHaveBeenCalledTimes(2);
    await expect((await outgoing).resolveBody()).resolves.toBe('previous user');
    await expect((await incoming).resolveBody()).resolves.toBe('current user');
    await expect((await joiner).resolveBody()).resolves.toBe('current user');
  });
});
