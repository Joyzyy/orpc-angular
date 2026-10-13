import { afterEach, describe, expect, it, vi } from 'vitest';
import { consumeStream } from './consume-stream';

// like a real websocket iterator, next() parks and never reads the abort signal
function transportIterable<T>() {
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
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('consumeStream', () => {
  it('delivers each event to onEvent until the transport ends', async () => {
    const stream = transportIterable<string>();
    const onEvent = vi.fn();
    const onFatal = vi.fn();

    consumeStream({ open: async () => stream.iterable, onEvent, onFatal });
    await settle();
    stream.emit('a');
    await settle();
    stream.emit('b');
    stream.end();
    await settle();

    expect(onEvent.mock.calls).toEqual([['a'], ['b']]);
    expect(onFatal).not.toHaveBeenCalled();
  });

  it('never delivers an event that raced the abort', async () => {
    const stream = transportIterable<string>();
    const onEvent = vi.fn();

    const handle = consumeStream({ open: async () => stream.iterable, onEvent });
    await settle();
    stream.emit('a');
    await settle();

    handle.abort();
    stream.emit('late');
    await settle();

    expect(onEvent.mock.calls).toEqual([['a']]);
  });

  it('closes a parked iterator on abort instead of leaving it subscribed', async () => {
    const stream = transportIterable<string>();
    const handle = consumeStream({ open: async () => stream.iterable, onEvent: vi.fn() });
    await settle();

    handle.abort();
    await settle();

    expect(stream.returned).toBe(1);
  });

  it('closes the iterator when open resolves after the abort already fired', async () => {
    const stream = transportIterable<string>();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const onEvent = vi.fn();

    const handle = consumeStream({
      open: async () => {
        await gate;
        return stream.iterable;
      },
      onEvent,
    });
    handle.abort();
    release();
    await settle();

    expect(stream.returned).toBe(1);
    stream.emit('late');
    await settle();
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('keeps consuming after an onEvent throw, reporting it out-of-band', async () => {
    const stream = transportIterable<string>();
    const boom = new Error('handler bug');
    // node has no reportError; every supported browser does
    const reported = vi.fn();
    vi.stubGlobal('reportError', reported);
    const onEvent = vi.fn((event: string) => {
      if (event === 'a') throw boom;
    });
    const onFatal = vi.fn();

    consumeStream({ open: async () => stream.iterable, onEvent, onFatal });
    await settle();
    stream.emit('a');
    await settle();
    stream.emit('b');
    await settle();

    expect(reported).toHaveBeenCalledWith(boom);
    expect(onEvent.mock.calls).toEqual([['a'], ['b']]);
    expect(onFatal).not.toHaveBeenCalled();
  });

  it('routes a transport failure to onFatal', async () => {
    const stream = transportIterable<string>();
    const boom = new Error('connection lost');
    const onFatal = vi.fn();

    consumeStream({ open: async () => stream.iterable, onEvent: vi.fn(), onFatal });
    await settle();
    stream.fail(boom);
    await settle();

    expect(onFatal).toHaveBeenCalledWith(boom);
  });

  it('swallows a failure that lands after abort', async () => {
    const stream = transportIterable<string>();
    const onFatal = vi.fn();

    const handle = consumeStream({ open: async () => stream.iterable, onEvent: vi.fn(), onFatal });
    await settle();
    handle.abort();
    stream.fail(new Error('teardown noise'));
    await settle();

    expect(onFatal).not.toHaveBeenCalled();
  });
});
