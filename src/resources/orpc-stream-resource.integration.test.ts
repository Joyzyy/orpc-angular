// @vitest-environment jsdom
import '@angular/compiler';
import { Injector, provideZonelessChangeDetection, type ResourceRef, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { BrowserTestingModule, platformBrowserTesting } from '@angular/platform-browser/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { orpcStreamResource } from './orpc-stream-resource';

// angular's real resource(), unlike the mocked unit tests
beforeAll(() => TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting()));

// return() wakes a parked next(), as a real async generator closed mid-iteration does
function controllable<T>() {
  const queue: T[] = [];
  let notify: (() => void) | undefined;
  let done = false;
  let failure: unknown;
  let returned = 0;

  const wake = () => {
    notify?.();
    notify = undefined;
  };

  const iterable: AsyncIterable<T> = {
    [Symbol.asyncIterator]: () => ({
      async next(): Promise<IteratorResult<T>> {
        while (true) {
          if (queue.length) return { value: queue.shift() as T, done: false };
          if (failure) {
            const error = failure;
            failure = undefined;
            throw error;
          }
          if (done) return { value: undefined as never, done: true };
          await new Promise<void>((resolve) => (notify = resolve));
        }
      },
      async return(): Promise<IteratorResult<T>> {
        returned++;
        done = true;
        wake();
        return { value: undefined as never, done: true };
      },
    }),
  };

  return {
    iterable,
    emit: (event: T) => {
      queue.push(event);
      wake();
    },
    fail: (error: unknown) => {
      failure = error;
      wake();
    },
    end: () => {
      done = true;
      wake();
    },
    get returned() {
      return returned;
    },
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  TestBed.tick();
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('orpcStreamResource over Angular resource()', () => {
  let injector: Injector;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    injector = TestBed.inject(Injector);
  });

  // without it the next configureTestingModule throws on the instantiated module
  afterEach(() => TestBed.resetTestingModule());

  it('stays idle while the when gate is closed and opens when it flips', async () => {
    const stream = controllable<string>();
    const call = vi.fn(async () => stream.iterable);
    const open = signal(false);

    const res = orpcStreamResource(call, { when: () => open(), injector });
    await settle();

    expect(res.status()).toBe('idle');
    expect(call).not.toHaveBeenCalled();

    open.set(true);
    await settle();

    expect(call).toHaveBeenCalledTimes(1);
    expect(res.status()).toBe('resolved');
  });

  it('loads a procedure that takes no input, since null params are not idle', async () => {
    const stream = controllable<string>();
    const call = vi.fn(async () => stream.iterable);

    const res = orpcStreamResource(call, { injector });
    await settle();

    expect(call).toHaveBeenCalledWith(undefined, expect.anything());
    expect(res.status()).toBe('resolved');
  });

  it('resolves on open with the seed value, then reports each event', async () => {
    const stream = controllable<string>();
    const res = orpcStreamResource(async () => stream.iterable, {
      defaultValue: 'seed',
      injector,
    });

    expect(res.status()).toBe('loading');
    await settle();
    expect(res.status()).toBe('resolved');
    expect(res.value()).toBe('seed');

    stream.emit('a');
    await settle();
    expect(res.value()).toBe('a');
  });

  it('moves to error when the stream terminates with a failure', async () => {
    const stream = controllable<string>();
    const boom = new Error('connection lost');
    const res = orpcStreamResource(async () => stream.iterable, { injector });
    await settle();

    stream.fail(boom);
    await settle();

    expect(res.status()).toBe('error');
    expect(res.error()).toBe(boom);
  });

  it('closes the previous iterator when params change', async () => {
    const streams = new Map<string, ReturnType<typeof controllable<string>>>();
    const chatId = signal('c1');
    const res = orpcStreamResource(
      async (input: { chatId: string }) => {
        const stream = controllable<string>();
        streams.set(input.chatId, stream);
        return stream.iterable;
      },
      { input: () => ({ chatId: chatId() }), injector },
    );
    await settle();

    const first = streams.get('c1')!;
    first.emit('from c1');
    await settle();
    expect(res.value()).toBe('from c1');

    chatId.set('c2');
    await settle();

    // abort alone leaves the iterator parked in next()
    expect(first.returned).toBe(1);
    expect(streams.has('c2')).toBe(true);

    first.emit('late from c1');
    await settle();
    expect(res.value()).toBeUndefined();
  });

  it('folds every event of a burst when accumulate is set', async () => {
    const stream = controllable<string>();
    const res = orpcStreamResource(async () => stream.iterable, {
      defaultValue: [] as string[],
      accumulate: (all, event) => [...all, event],
      injector,
    });
    await settle();

    // both events land before any read, so only a fold inside the writer loop keeps the first
    stream.emit('a');
    stream.emit('b');
    await settle();

    expect(res.value()).toEqual(['a', 'b']);
  });

  it('keeps only the latest event of the same burst without accumulate', async () => {
    const stream = controllable<string>();
    const res = orpcStreamResource(async () => stream.iterable, { injector });
    await settle();

    stream.emit('a');
    stream.emit('b');
    await settle();

    expect(res.value()).toBe('b');
  });

  it('rejects accumulate without the defaultValue that seeds it', () => {
    const call = async () => controllable<string>().iterable;

    // @ts-expect-error the fold has no seed without defaultValue
    orpcStreamResource(call, {
      accumulate: (all: string[], event: string) => [...all, event],
      injector,
    });

    expectTypeOf(orpcStreamResource(call, { injector })).toEqualTypeOf<
      ResourceRef<string | undefined>
    >();
    expectTypeOf(
      orpcStreamResource(call, {
        defaultValue: [] as string[],
        accumulate: (all, event) => [...all, event],
        injector,
      }),
    ).toEqualTypeOf<ResourceRef<string[]>>();
  });

  it('restarts the fold on a params change, since the state is per-subscription', async () => {
    const streams = new Map<string, ReturnType<typeof controllable<string>>>();
    const chatId = signal('c1');
    const res = orpcStreamResource(
      async (input: { chatId: string }) => {
        const stream = controllable<string>();
        streams.set(input.chatId, stream);
        return stream.iterable;
      },
      {
        input: () => ({ chatId: chatId() }),
        defaultValue: [] as string[],
        accumulate: (all, event: string) => [...all, event],
        injector,
      },
    );
    await settle();

    streams.get('c1')!.emit('a');
    await settle();
    expect(res.value()).toEqual(['a']);

    chatId.set('c2');
    await settle();
    streams.get('c2')!.emit('b');
    await settle();

    expect(res.value()).toEqual(['b']);
  });
});
