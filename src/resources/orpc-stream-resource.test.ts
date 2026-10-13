import {
  type ResourceLoaderParams,
  ResourceParamsStatus,
  type ResourceStreamItem,
  type Signal,
} from '@angular/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { orpcStreamResource } from './orpc-stream-resource';

// resource() is mocked to return its options, so the tests drive params/stream directly
vi.mock('@angular/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@angular/core')>();
  return {
    ...actual,
    resource: vi.fn((options: unknown) => options),
  };
});

interface CapturedStreamOptions<T> {
  defaultValue?: unknown;
  equal?: unknown;
  debugName?: string;
  params: (ctx?: unknown) => unknown;
  stream: (params: ResourceLoaderParams<unknown>) => Promise<Signal<ResourceStreamItem<T>>>;
}

// the build defines ngServerMode; absent means browser
function setServerMode(value: boolean | undefined): void {
  if (value === undefined) delete (globalThis as Record<string, unknown>)['ngServerMode'];
  else (globalThis as Record<string, unknown>)['ngServerMode'] = value;
}

afterEach(() => setServerMode(undefined));

function controllable<T>() {
  const queue: T[] = [];
  let notify: (() => void) | undefined;
  let done = false;
  let failure: unknown;

  const iterable: AsyncIterable<T> = {
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (queue.length) yield queue.shift() as T;
        if (failure) throw failure;
        if (done) return;
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
    },
  };

  const wake = async () => {
    notify?.();
    notify = undefined;
    // one turn for the generator, one for its consumer
    await Promise.resolve();
    await Promise.resolve();
  };

  return {
    iterable,
    emit: (event: T) => {
      queue.push(event);
      return wake();
    },
    fail: (error: unknown) => {
      failure = error;
      return wake();
    },
    end: () => {
      done = true;
      return wake();
    },
  };
}

function loaderParams(params: unknown, abortSignal: AbortSignal) {
  return { params, abortSignal } as ResourceLoaderParams<unknown>;
}

describe('orpcStreamResource', () => {
  it('opens the subscription with the input, abort signal and resolved context', async () => {
    const stream = controllable<string>();
    const call = vi.fn(async () => stream.iterable);
    const { signal: abortSignal } = new AbortController();

    const captured = orpcStreamResource(call, {
      input: () => ({ chatId: 'c1' }),
      context: () => ({ retry: 3 }),
    }) as unknown as CapturedStreamOptions<string>;

    await captured.stream(loaderParams({ chatId: 'c1' }, abortSignal));

    expect(call).toHaveBeenCalledWith(
      { chatId: 'c1' },
      { signal: abortSignal, context: { retry: 3 } },
    );
  });

  it('passes undefined to a procedure that takes no input, and null through params', async () => {
    const stream = controllable<string>();
    const call = vi.fn(async () => stream.iterable);
    const { signal: abortSignal } = new AbortController();

    const captured = orpcStreamResource(call) as unknown as CapturedStreamOptions<string>;

    expect(captured.params()).toBeNull();
    await captured.stream(loaderParams(null, abortSignal));
    expect(call).toHaveBeenCalledWith(undefined, { signal: abortSignal, context: undefined });
  });

  it('reports each event as the resource value, latest wins', async () => {
    const stream = controllable<string>();
    const { signal: abortSignal } = new AbortController();

    const captured = orpcStreamResource(
      async () => stream.iterable,
    ) as unknown as CapturedStreamOptions<string>;

    const item = await captured.stream(loaderParams(null, abortSignal));
    expect(item()).toEqual({ value: undefined });

    await stream.emit('a');
    expect(item()).toEqual({ value: 'a' });

    await stream.emit('b');
    expect(item()).toEqual({ value: 'b' });
  });

  it('seeds the first item with defaultValue so it serves until the first event', async () => {
    const stream = controllable<string[]>();
    const { signal: abortSignal } = new AbortController();

    const captured = orpcStreamResource(async () => stream.iterable, {
      defaultValue: [],
    }) as unknown as CapturedStreamOptions<string[]>;

    const item = await captured.stream(loaderParams(null, abortSignal));
    expect(item()).toEqual({ value: [] });

    await stream.emit(['x']);
    expect(item()).toEqual({ value: ['x'] });
  });

  it('turns a stream failure into the resource error state', async () => {
    const stream = controllable<string>();
    const { signal: abortSignal } = new AbortController();
    const boom = new Error('connection lost');

    const captured = orpcStreamResource(
      async () => stream.iterable,
    ) as unknown as CapturedStreamOptions<string>;

    const item = await captured.stream(loaderParams(null, abortSignal));
    await stream.emit('a');
    await stream.fail(boom);

    expect(item()).toEqual({ error: boom });
  });

  it('wraps a non-Error rejection, since ResourceStreamItem requires an Error', async () => {
    const stream = controllable<string>();
    const { signal: abortSignal } = new AbortController();

    const captured = orpcStreamResource(
      async () => stream.iterable,
    ) as unknown as CapturedStreamOptions<string>;

    const item = await captured.stream(loaderParams(null, abortSignal));
    await stream.fail('socket closed');

    const settled = item() as { error: Error };
    expect(settled.error).toBeInstanceOf(Error);
    expect(settled.error.message).toBe('socket closed');
  });

  it('stops updating once aborted, so a replaced subscription cannot write', async () => {
    const stream = controllable<string>();
    const controller = new AbortController();

    const captured = orpcStreamResource(
      async () => stream.iterable,
    ) as unknown as CapturedStreamOptions<string>;

    const item = await captured.stream(loaderParams(null, controller.signal));
    await stream.emit('a');
    expect(item()).toEqual({ value: 'a' });

    controller.abort();
    await stream.emit('b');
    expect(item()).toEqual({ value: 'a' });

    await stream.fail(new Error('aborted teardown'));
    expect(item()).toEqual({ value: 'a' });
  });

  it('never consumes an iterator whose abort fired before iteration started', async () => {
    const stream = controllable<string>();
    const controller = new AbortController();
    controller.abort();

    const captured = orpcStreamResource(
      async () => stream.iterable,
    ) as unknown as CapturedStreamOptions<string>;

    const item = await captured.stream(loaderParams(null, controller.signal));
    await stream.emit('a');

    expect(item()).toEqual({ value: undefined });
  });

  it('folds each event into the value when accumulate is set', async () => {
    const stream = controllable<string>();
    const { signal: abortSignal } = new AbortController();

    const captured = orpcStreamResource(async () => stream.iterable, {
      defaultValue: [] as string[],
      accumulate: (all, event) => [...all, event],
    }) as unknown as CapturedStreamOptions<string[]>;

    const item = await captured.stream(loaderParams(null, abortSignal));
    expect(item()).toEqual({ value: [] });

    await stream.emit('a');
    await stream.emit('b');

    expect(item()).toEqual({ value: ['a', 'b'] });
  });

  it('keeps the last event when the stream closes cleanly', async () => {
    const stream = controllable<string>();
    const { signal: abortSignal } = new AbortController();

    const captured = orpcStreamResource(
      async () => stream.iterable,
    ) as unknown as CapturedStreamOptions<string>;

    const item = await captured.stream(loaderParams(null, abortSignal));
    await stream.emit('a');
    await stream.end();

    expect(item()).toEqual({ value: 'a' });
  });

  it('idles while the when gate is closed, and checks it before input', () => {
    let open = false;
    const input = vi.fn(() => ({ chatId: 'c1' }));
    const captured = orpcStreamResource(async () => controllable<string>().iterable, {
      input,
      when: () => open,
    }) as unknown as CapturedStreamOptions<string>;

    expect(() => captured.params()).toThrow(ResourceParamsStatus.IDLE);
    expect(input).not.toHaveBeenCalled();

    open = true;
    expect(captured.params()).toEqual({ chatId: 'c1' });
  });

  it('idles on the server so a server render never opens a subscription', () => {
    setServerMode(true);
    const call = vi.fn(async () => controllable<string>().iterable);
    const captured = orpcStreamResource(call, {
      input: () => ({ chatId: 'c1' }),
    }) as unknown as CapturedStreamOptions<string>;

    expect(() => captured.params()).toThrow(ResourceParamsStatus.IDLE);
    expect(call).not.toHaveBeenCalled();
  });

  it('forwards the native resource options and keeps ours out', () => {
    const equal = (a: string, b: string) => a === b;
    const captured = orpcStreamResource(async () => controllable<string>().iterable, {
      defaultValue: 'seed',
      equal,
      debugName: 'chat',
      when: () => true,
      input: () => undefined,
    }) as unknown as CapturedStreamOptions<string>;

    expect(captured.defaultValue).toBe('seed');
    expect(captured.equal).toBe(equal);
    expect(captured.debugName).toBe('chat');
    expect(captured).not.toHaveProperty('input');
    expect(captured).not.toHaveProperty('when');
    expect(captured).not.toHaveProperty('context');
    expect(captured).not.toHaveProperty('id');
  });
});
