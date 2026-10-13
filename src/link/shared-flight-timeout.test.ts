import { describe, expect, it, vi } from 'vitest';
import { asTransport } from '../../tests/as-transport';
import { cacheInterceptor } from './cache-interceptor';
import { ORPCQueryCache } from '../kernel/orpc-query-cache';

// real timers: fake timers cannot advance AbortSignal.timeout()
const SHORT_TIMEOUT_MS = 20;

const hangingInner = {
  send: vi.fn(
    (_req: unknown, _path: unknown, options: { signal?: AbortSignal }) =>
      new Promise<never>((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(options.signal!.reason));
      }),
  ),
};

const request = { method: 'GET', url: '/x', headers: {}, body: undefined, signal: undefined };

describe('shared flights are bounded by their own timeout (not the abandoned caller signal)', () => {
  it('a dedupe GET rejects once the ceiling elapses, even though no caller signal was passed through', async () => {
    const link = asTransport(
      cacheInterceptor({
        cache: new ORPCQueryCache(),
        isBrowser: true,
        timeoutMs: SHORT_TIMEOUT_MS,
      }),
      hangingInner,
    );

    await expect(
      link.send(request as never, [], { context: { dedupe: true } } as never),
    ).rejects.toThrow();
  });

  it('a cache GET rejects once the ceiling elapses, even though no caller signal was passed through', async () => {
    const link = asTransport(
      cacheInterceptor({
        cache: new ORPCQueryCache(),
        isBrowser: true,
        timeoutMs: SHORT_TIMEOUT_MS,
      }),
      hangingInner,
    );

    await expect(
      link.send(request as never, [], { context: { cache: { tags: ['t'] } } } as never),
    ).rejects.toThrow();
  });
});
