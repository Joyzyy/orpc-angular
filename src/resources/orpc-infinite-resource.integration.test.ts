// @vitest-environment jsdom
import '@angular/compiler';
import {
  Injector,
  makeStateKey,
  provideZonelessChangeDetection,
  signal,
  TransferState,
  ɵCACHE_ACTIVE,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { BrowserTestingModule, platformBrowserTesting } from '@angular/platform-browser/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ORPCQueryCache } from '../kernel/orpc-query-cache';
import { orpcInfiniteResource, type PageRange } from './orpc-infinite-resource';

beforeAll(() => TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting()));

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  TestBed.tick();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  TestBed.tick();
}

function rows(list: string, { offset, limit }: PageRange, total: number): string[] {
  const end = Math.min(offset + limit, total);
  return Array.from({ length: Math.max(end - offset, 0) }, (_, i) => `${list}-${offset + i}`);
}

describe('orpcInfiniteResource', () => {
  let injector: Injector;
  let cache: ORPCQueryCache;

  beforeEach(() => {
    cache = new ORPCQueryCache();
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), { provide: ORPCQueryCache, useValue: cache }],
    });
    injector = TestBed.inject(Injector);
  });

  afterEach(() => TestBed.resetTestingModule());

  function setup(total = 5) {
    const listName = signal('a');
    const call = vi.fn(async (input: { list: string } & PageRange) =>
      rows(input.list, input, total),
    );
    const res = orpcInfiniteResource(call, {
      input: (range) => ({ list: listName(), ...range }),
      pageSize: 2,
      items: (page) => page,
      context: { cache: { tags: ['t'] } },
      injector,
    });
    return { res, call, listName };
  }

  it('appends pages and stops when a page comes back short', async () => {
    const { res } = setup();
    await settle();
    expect(res.items()).toEqual(['a-0', 'a-1']);

    res.loadMore();
    await settle();
    res.loadMore();
    await settle();

    expect(res.items()).toEqual(['a-0', 'a-1', 'a-2', 'a-3', 'a-4']);
    expect(res.hasMore()).toBe(false);
  });

  it('brings a recreated list back at full depth on its first frame, without a call', async () => {
    const call = vi.fn(async (input: PageRange) => rows('a', input, 10));
    const create = (child: Injector) =>
      orpcInfiniteResource(call, {
        input: (range) => range,
        pageSize: 2,
        items: (page) => page,
        context: { cache: { tags: ['t'] } },
        id: 'seeded',
        injector: child,
      });
    const first = Injector.create({ providers: [], parent: injector });
    const res = create(first);
    await settle();
    res.loadMore();
    await settle();
    (first as unknown as { destroy(): void }).destroy();
    call.mockClear();

    const again = create(Injector.create({ providers: [], parent: injector }));

    expect(again.items()).toEqual(['a-0', 'a-1', 'a-2', 'a-3']);
    await settle();
    expect(call).not.toHaveBeenCalled();
    again.loadMore();
    await settle();
    expect(call).toHaveBeenLastCalledWith({ offset: 4, limit: 2 }, expect.anything());
  });

  it('keeps loaded rows on screen while the next page loads', async () => {
    const { res } = setup();
    await settle();

    res.loadMore();
    TestBed.tick();

    expect(res.isLoadingMore()).toBe(true);
    expect(res.isInitialLoading()).toBe(false);
    expect(res.items()).toEqual(['a-0', 'a-1']);
  });

  it('refetches every loaded row in one request on a tag bump, without duplicates', async () => {
    const { res, call } = setup();
    await settle();
    res.loadMore();
    await settle();

    cache.invalidate('t');
    await settle();

    expect(call.mock.calls.at(-1)![0]).toEqual({ list: 'a', offset: 0, limit: 4 });
    expect(res.items()).toEqual(['a-0', 'a-1', 'a-2', 'a-3']);
  });

  it('ignores a tag bump while a load is in flight, like Angular reload()', async () => {
    const { res, call } = setup();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    call.mockImplementationOnce(async (input) => held.then(() => rows(input.list, input, 5)));
    TestBed.tick();

    cache.invalidate('t');
    await settle();
    release();
    await settle();

    expect(call).toHaveBeenCalledTimes(1);
    expect(res.items()).toEqual(['a-0', 'a-1']);
  });

  it('drops the rows of the previous list when input changes', async () => {
    const { res, listName } = setup();
    await settle();
    res.loadMore();
    await settle();

    listName.set('b');
    TestBed.tick();
    expect(res.items()).toEqual([]);
    expect(res.isInitialLoading()).toBe(true);

    await settle();
    expect(res.items()).toEqual(['b-0', 'b-1']);
  });

  it('keeps rows across an input change that leaves the key alone', async () => {
    const query = signal('x');
    const call = vi.fn(async (input: { query: string } & PageRange) => rows(input.query, input, 5));
    const res = orpcInfiniteResource(call, {
      input: (range) => ({ query: query(), ...range }),
      key: () => 'same',
      pageSize: 2,
      items: (page) => page,
      injector,
    });
    await settle();
    expect(res.items()).toEqual(['x-0', 'x-1']);

    query.set('y');
    TestBed.tick();
    expect(res.items()).toEqual(['x-0', 'x-1']);
    expect(res.isInitialLoading()).toBe(false);

    await settle();
    expect(res.items()).toEqual(['y-0', 'y-1']);
  });

  it('hydrates the server page on the first client frame when given an id', () => {
    TestBed.inject(TransferState).set(makeStateKey<unknown>('list'), {
      pages: [['a-0', 'a-1']],
      range: { offset: 0, limit: 2 },
    });
    const call = vi.fn(async () => ['fetched']);

    const res = orpcInfiniteResource(call, {
      input: (range) => range,
      pageSize: 2,
      items: (page: string[]) => page,
      id: 'list',
      injector: Injector.create({
        providers: [{ provide: ɵCACHE_ACTIVE, useValue: { isActive: true } }],
        parent: injector,
      }),
    });

    expect(res.isInitialLoading()).toBe(false);
    expect(res.items()).toEqual(['a-0', 'a-1']);
    expect(call).not.toHaveBeenCalled();
  });

  it('keeps rows and stops auto-loading after a failed page; reload recovers', async () => {
    const { res, call } = setup();
    await settle();
    call.mockRejectedValueOnce(new Error('boom'));

    res.loadMore();
    await settle();

    expect(res.items()).toEqual(['a-0', 'a-1']);
    expect(res.error()?.message).toBe('boom');
    expect(res.hasMore()).toBe(false);

    res.reload();
    await settle();
    expect(res.error()).toBeUndefined();
    expect(res.hasMore()).toBe(true);
  });
});
