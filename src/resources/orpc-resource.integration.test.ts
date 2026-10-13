// @vitest-environment jsdom
import '@angular/compiler';
import { Injector, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { BrowserTestingModule, platformBrowserTesting } from '@angular/platform-browser/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ORPCQueryCache } from '../kernel/orpc-query-cache';
import { orpcResource } from './orpc-resource';

// angular's real resource(), unlike the mocked unit tests
beforeAll(() => TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting()));

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  TestBed.tick();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  // stands in for the zoneless scheduler flushing effects
  TestBed.tick();
}

describe('orpcResource over Angular resource()', () => {
  let injector: Injector;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    injector = TestBed.inject(Injector);
  });

  // without it the next configureTestingModule throws on the instantiated module
  afterEach(() => TestBed.resetTestingModule());

  it('stays idle while the when gate is closed and loads when it flips', async () => {
    const call = vi.fn(async () => 'out');
    const open = signal(false);

    const res = orpcResource(call, { when: () => open(), injector });
    await settle();

    expect(res.status()).toBe('idle');
    expect(call).not.toHaveBeenCalled();

    open.set(true);
    await settle();

    expect(res.status()).toBe('resolved');
    expect(res.value()).toBe('out');
  });

  it('loads a procedure that takes no input, since null params are not idle', async () => {
    const call = vi.fn(async () => 'out');

    const res = orpcResource(call, { injector });
    await settle();

    expect(call).toHaveBeenCalledWith(undefined, expect.anything());
    expect(res.value()).toBe('out');
  });

  it('aborts the in-flight call when input changes', async () => {
    const signals: AbortSignal[] = [];
    const id = signal('a');
    const res = orpcResource(
      async (input: { id: string }, options) => {
        signals.push(options!.signal!);
        return input.id;
      },
      { input: () => ({ id: id() }), injector },
    );
    await settle();

    id.set('b');
    await settle();

    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    expect(res.value()).toBe('b');
  });
});

describe('orpcResource synchronous seed', () => {
  let injector: Injector;
  let cache: ORPCQueryCache;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: ORPCQueryCache, useValue: new ORPCQueryCache() },
      ],
    });
    injector = TestBed.inject(Injector);
    cache = TestBed.inject(ORPCQueryCache);
  });

  afterEach(() => TestBed.resetTestingModule());

  const planetCall = async ({ id }: { id: string }) => ({ id, name: `planet-${id}` });

  function planetResource(id: () => string) {
    return orpcResource(planetCall, {
      input: () => ({ id: id() }),
      context: () => ({ cache: { tags: ['planet'] } }),
      id: 'planet',
      injector,
    });
  }

  it('does not evaluate a context lambda while the when gate is closed', async () => {
    const call = vi.fn(async () => 'out');
    const editor = signal<{ id: string } | null>(null);
    // gated inputs often assert non-null, so a closed-gate evaluation would throw
    const context = vi.fn(() => ({ cache: { tags: [editor()!.id] } }));

    const res = orpcResource(call, { when: () => editor() !== null, context, injector });
    await settle();

    expect(res.status()).toBe('idle');
    expect(context).not.toHaveBeenCalled();

    editor.set({ id: 'q1' });
    await settle();

    expect(res.value()).toBe('out');
  });

  it('serves the previous resolved output on the first frame of a recreated resource', async () => {
    const first = planetResource(() => 'a');
    await settle();
    expect(first.value()).toEqual({ id: 'a', name: 'planet-a' });
    first.destroy();

    const second = planetResource(() => 'a');
    expect(second.isLoading()).toBe(false);
    expect(second.status()).toBe('resolved');
    expect(second.hasValue()).toBe(true);
    expect(second.value()).toEqual({ id: 'a', name: 'planet-a' });

    await settle();
    expect(second.status()).toBe('resolved');
    expect(second.value()).toEqual({ id: 'a', name: 'planet-a' });
  });

  it('peeks per input: a param change never holds the old input value', async () => {
    const id = signal('a');
    const res = planetResource(() => id());
    await settle();

    id.set('b');
    expect(res.isLoading()).toBe(true);
    expect(res.hasValue()).toBe(false);
    await settle();
    expect(res.value()).toEqual({ id: 'b', name: 'planet-b' });

    id.set('a');
    expect(res.hasValue()).toBe(true);
    expect(res.isLoading()).toBe(false);
    expect(res.value()).toEqual({ id: 'a', name: 'planet-a' });
  });

  it('tag invalidation drops the seed with the wire entry', async () => {
    const first = planetResource(() => 'a');
    await settle();
    first.destroy();

    cache.invalidate('planet');

    const second = planetResource(() => 'a');
    expect(second.hasValue()).toBe(false);
    expect(second.isLoading()).toBe(true);
  });

  it('a load straddling an invalidation resolves but never seeds', async () => {
    type Planet = { id: string; name: string };
    let release!: (value: Planet) => void;
    const first = orpcResource<Planet, { id: string }>(
      () => new Promise<Planet>((resolve) => (release = resolve)),
      {
        input: () => ({ id: 'a' }),
        context: () => ({ cache: { tags: ['planet'] } }),
        id: 'planet',
        injector,
      },
    );
    await settle();

    cache.invalidate('planet');
    release({ id: 'a', name: 'pre-mutation' });
    await settle();
    expect(first.value()).toEqual({ id: 'a', name: 'pre-mutation' });
    first.destroy();

    const second = planetResource(() => 'a');
    expect(second.hasValue()).toBe(false);
    await settle();
    second.destroy();
    const third = planetResource(() => 'a');
    expect(third.hasValue()).toBe(true);
  });

  it('without an id there is no seed', async () => {
    const make = () =>
      orpcResource(planetCall, {
        input: () => ({ id: 'a' }),
        context: () => ({ cache: { tags: ['planet'] } }),
        injector,
      });
    const first = make();
    await settle();
    first.destroy();

    const second = make();
    expect(second.hasValue()).toBe(false);
  });

  it('hands out clones, so mutating a seeded value cannot poison later seeds', async () => {
    const first = planetResource(() => 'a');
    await settle();
    first.destroy();

    const second = planetResource(() => 'a');
    (second.value() as { name: string }).name = 'mutated';
    second.destroy();

    const third = planetResource(() => 'a');
    expect(third.value()).toEqual({ id: 'a', name: 'planet-a' });
  });

  it('seed keys ignore input key order', async () => {
    const call = async (input: { a: number; b: number }) => `out-${input.a}-${input.b}`;
    const make = (input: () => { a: number; b: number }) =>
      orpcResource(call, {
        input,
        context: () => ({ cache: { tags: ['kv'] } }),
        id: 'kv',
        injector,
      });

    const first = make(() => ({ a: 1, b: 2 }));
    await settle();
    first.destroy();

    const second = make(() => ({ b: 2, a: 1 }));
    expect(second.hasValue()).toBe(true);
    expect(second.value()).toBe('out-1-2');
  });

  it('a recreated resource resolves from the seed without refetching; reload still fetches', async () => {
    let calls = 0;
    const make = () =>
      orpcResource(
        async ({ id }: { id: string }) => {
          calls++;
          return { id, name: `planet-${id}` };
        },
        {
          input: () => ({ id: 'a' }),
          context: () => ({ cache: { tags: ['planet'] } }),
          id: 'planet',
          injector,
        },
      );
    const first = make();
    await settle();
    expect(calls).toBe(1);
    first.destroy();

    const second = make();
    await settle();
    expect(calls).toBe(1);
    expect(second.status()).toBe('resolved');
    expect(second.value()).toEqual({ id: 'a', name: 'planet-a' });

    expect(second.reload()).toBe(true);
    await settle();
    expect(calls).toBe(2);
  });

  it('a param change on a live resource refetches even when the new key has a seed', async () => {
    let calls = 0;
    const id = signal('a');
    const res = orpcResource(
      async (input: { id: string }) => {
        calls++;
        return { id: input.id, name: `planet-${input.id}` };
      },
      {
        input: () => ({ id: id() }),
        context: () => ({ cache: { tags: ['planet'] } }),
        id: 'planet',
        injector,
      },
    );
    await settle();

    id.set('b');
    await settle();
    id.set('a');
    await settle();
    expect(calls).toBe(3);
    expect(res.value()).toEqual({ id: 'a', name: 'planet-a' });
  });

  it('forwards reload through the seeded facade', async () => {
    let calls = 0;
    const res = orpcResource(
      async ({ id }: { id: string }) => {
        calls++;
        return { id, name: `planet-${id}` };
      },
      {
        input: () => ({ id: 'a' }),
        context: () => ({ cache: { tags: ['planet'] } }),
        id: 'planet',
        injector,
      },
    );
    await settle();
    expect(calls).toBe(1);

    expect(res.reload()).toBe(true);
    await settle();
    expect(calls).toBe(2);
    expect(res.status()).toBe('resolved');
    expect(res.value()).toEqual({ id: 'a', name: 'planet-a' });
  });
});

describe('orpcResource self-reload on invalidate', () => {
  let injector: Injector;
  let cache: ORPCQueryCache;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: ORPCQueryCache, useValue: new ORPCQueryCache() },
      ],
    });
    injector = TestBed.inject(Injector);
    cache = TestBed.inject(ORPCQueryCache);
  });

  afterEach(() => TestBed.resetTestingModule());

  function tagged(tags: string[], call: () => Promise<string>) {
    return orpcResource(call, { context: { cache: { tags } }, injector });
  }

  it('refetches when a declared tag is invalidated, with no paired reload', async () => {
    let calls = 0;
    const res = tagged(['wallet'], async () => `out-${++calls}`);
    await settle();
    expect(res.value()).toBe('out-1');

    cache.invalidate('wallet');
    await settle();

    expect(calls).toBe(2);
    expect(res.status()).toBe('resolved');
    expect(res.value()).toBe('out-2');
  });

  it('ignores invalidation of a tag it does not declare', async () => {
    let calls = 0;
    tagged(['wallet'], async () => `out-${++calls}`);
    await settle();

    cache.invalidate('planet');
    await settle();

    expect(calls).toBe(1);
  });

  it('refetches once when two of its own tags are invalidated together', async () => {
    let calls = 0;
    tagged(['wallet', 'planet'], async () => `out-${++calls}`);
    await settle();

    cache.invalidate('wallet', 'planet');
    await settle();

    expect(calls).toBe(2);
  });

  it('stays idle rather than loading when a closed gate resource is invalidated', async () => {
    let calls = 0;
    const res = orpcResource(async () => `out-${++calls}`, {
      when: () => false,
      context: { cache: { tags: ['wallet'] } },
      injector,
    });
    await settle();

    cache.invalidate('wallet');
    await settle();

    expect(res.status()).toBe('idle');
    expect(calls).toBe(0);
  });

  it('fetches once when a call site still pairs invalidate with reload', async () => {
    let calls = 0;
    const res = tagged(['wallet'], async () => `out-${++calls}`);
    await settle();

    cache.invalidate('wallet');
    res.reload();
    await settle();

    expect(calls).toBe(2);
    expect(res.value()).toBe('out-2');
  });

  it('does not reload after clear, which is a session teardown rather than a refresh', async () => {
    let calls = 0;
    tagged(['wallet'], async () => `out-${++calls}`);
    await settle();

    cache.clear();
    await settle();

    expect(calls).toBe(1);
  });
});
