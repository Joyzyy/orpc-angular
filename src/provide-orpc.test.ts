// @vitest-environment jsdom
import '@angular/compiler';
import {
  APP_BOOTSTRAP_LISTENER,
  type ComponentRef,
  PLATFORM_ID,
  provideZonelessChangeDetection,
  TransferState,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { BrowserTestingModule, platformBrowserTesting } from '@angular/platform-browser/testing';
import { type Client, createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ORPCAngularContext } from './kernel/orpc-angular-context';
import { ORPCCache } from './kernel/orpc-cache';
import { ORPCAngularLinkPlugin } from './link/orpc-angular-link-plugin';
import { provideORPC, TRANSFER_CACHE_WINDOW } from './provide-orpc';

beforeAll(() => TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting()));

afterEach(() => TestBed.resetTestingModule());

type Planet = { id: number; name: string };

function setup(platform: 'browser' | 'server' = 'browser') {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideORPC(),
      { provide: PLATFORM_ID, useValue: platform },
    ],
  });
  const fetch = vi.fn(
    async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ json: { id: 1, name: 'earth' } }), {
        headers: { 'content-type': 'application/json' },
      }),
  );
  const client = TestBed.runInInjectionContext(() =>
    createORPCClient<{ planet: Client<ORPCAngularContext, { id: number }, Planet, Error> }>(
      new RPCLink<ORPCAngularContext>({
        origin: 'http://api.test',
        url: '/rpc',
        method: 'GET',
        fetch,
        plugins: [new ORPCAngularLinkPlugin()],
      }),
    ),
  );
  return { client, fetch };
}

describe('provideORPC + ORPCAngularLinkPlugin on RPCLink', () => {
  it('joins concurrent dedupe GETs into one request', async () => {
    const { client, fetch } = setup();
    TestBed.inject(TRANSFER_CACHE_WINDOW).active = false;

    const [a, b] = await Promise.all([
      client.planet({ id: 1 }, { context: { dedupe: true } }),
      client.planet({ id: 1 }, { context: { dedupe: true } }),
    ]);

    expect(a).toEqual({ id: 1, name: 'earth' });
    expect(b).toEqual(a);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('serves tagged GETs from the cache until a tag is invalidated', async () => {
    const { client, fetch } = setup();
    TestBed.inject(TRANSFER_CACHE_WINDOW).active = false;
    const context = { cache: { tags: ['planets'] } };

    await client.planet({ id: 1 }, { context });
    await client.planet({ id: 1 }, { context });
    expect(fetch).toHaveBeenCalledTimes(1);

    TestBed.inject(ORPCCache).invalidate('planets');
    await client.planet({ id: 1 }, { context });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('embeds server GETs in TransferState', async () => {
    const { client } = setup('server');
    const transferState = TestBed.inject(TransferState);
    expect(transferState.isEmpty).toBe(true);

    await client.planet({ id: 1 });

    expect(transferState.isEmpty).toBe(false);
  });

  it('closes the transfer window at first app stability', async () => {
    setup();
    const window = TestBed.inject(TRANSFER_CACHE_WINDOW);
    expect(window.active).toBe(true);

    for (const listener of TestBed.inject(APP_BOOTSTRAP_LISTENER)) {
      listener(undefined as unknown as ComponentRef<unknown>);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(window.active).toBe(false);
  });

  it('closes the transfer window on tag invalidation, not on clear()', () => {
    setup();
    const window = TestBed.inject(TRANSFER_CACHE_WINDOW);
    const cache = TestBed.inject(ORPCCache);

    cache.clear();
    expect(window.active).toBe(true);

    cache.invalidate('planets');
    expect(window.active).toBe(false);
  });

  it('needs an injection context', () => {
    TestBed.configureTestingModule({ providers: [provideORPC()] });
    expect(() => new ORPCAngularLinkPlugin()).toThrow(/NG0203/);
  });
});
