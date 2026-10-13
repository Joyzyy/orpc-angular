// @vitest-environment jsdom
import '@angular/compiler';
import { Injector, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { BrowserTestingModule, platformBrowserTesting } from '@angular/platform-browser/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ORPCCache } from '../kernel/orpc-cache';
import { orpcMutation } from './orpc-mutation';

beforeAll(() => TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting()));

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  TestBed.tick();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  TestBed.tick();
}

describe('orpcMutation', () => {
  let injector: Injector;
  const invalidate = vi.fn();

  beforeEach(() => {
    invalidate.mockClear();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: ORPCCache, useValue: { invalidate, clear: vi.fn() } },
      ],
    });
    injector = TestBed.inject(Injector);
  });

  afterEach(() => TestBed.resetTestingModule());

  it('flips pending around the call and exposes the value', async () => {
    let release!: (value: string) => void;
    const call = vi.fn(() => new Promise<string>((resolve) => (release = resolve)));

    const mutation = orpcMutation(call, { injector });
    const done = mutation.mutate(undefined);

    expect(mutation.isPending()).toBe(true);
    expect(mutation.status()).toBe('pending');

    release('ok');
    await done;

    expect(mutation.isPending()).toBe(false);
    expect(mutation.status()).toBe('success');
    expect(mutation.value()).toBe('ok');
  });

  it('clears pending when the procedure throws synchronously', async () => {
    const mutation = orpcMutation(
      vi.fn(() => {
        throw new TypeError('not a procedure');
      }),
      { injector, key: () => 'k' },
    );

    await expect(mutation.mutate(undefined)).rejects.toThrow('not a procedure');

    expect(mutation.isPending()).toBe(false);
    expect(mutation.pending('k')).toBe(false);
  });

  it('returns the safe result instead of throwing', async () => {
    const boom = new Error('boom');
    const mutation = orpcMutation(
      vi.fn(() => Promise.reject(boom)),
      { injector },
    );

    const { error, data } = await mutation.mutate(undefined);

    expect(error).toBe(boom);
    expect(data).toBeUndefined();
    expect(mutation.status()).toBe('error');
    expect(mutation.error()).toBe(boom);
  });

  it('hands the onMutate context to onError', async () => {
    const onError = vi.fn();
    const mutation = orpcMutation(
      vi.fn(() => Promise.reject(new Error('boom'))),
      { injector, onMutate: () => ({ previous: 1 }), onError },
    );

    await mutation.mutate(undefined);

    expect(onError).toHaveBeenCalledWith(expect.any(Error), undefined, { previous: 1 });
  });

  it('invalidates the tags before onSuccess runs', async () => {
    const order: string[] = [];
    invalidate.mockImplementation((...tags: string[]) => order.push(`invalidate:${tags.join()}`));

    const mutation = orpcMutation(
      vi.fn(async (input: { id: string }) => input.id),
      {
        injector,
        invalidate: (input) => ['users', `user:${input.id}`],
        onSuccess: () => order.push('onSuccess'),
      },
    );
    await mutation.mutate({ id: '7' });

    expect(order).toEqual(['invalidate:users,user:7', 'onSuccess']);
  });

  it('tracks the in-flight key and clears it when the call settles', async () => {
    let release!: (value: string) => void;
    const mutation = orpcMutation(
      vi.fn((_input: { name: string }) => new Promise<string>((resolve) => (release = resolve))),
      { injector, key: (input) => input.name },
    );

    const done = mutation.mutate({ name: 'FLAG' });
    expect(mutation.pending('FLAG')).toBe(true);
    expect(mutation.pending('OTHER')).toBe(false);

    release('ok');
    await done;

    expect(mutation.pending('FLAG')).toBe(false);
  });

  it('keeps the key pending while a second call with the same key is in flight', async () => {
    const releases: Array<(value: string) => void> = [];
    const mutation = orpcMutation(
      vi.fn((_input: { name: string }) => new Promise<string>((r) => releases.push(r))),
      { injector, key: (input) => input.name },
    );

    const first = mutation.mutate({ name: 'FLAG' });
    const second = mutation.mutate({ name: 'FLAG' });

    releases[0]('ok');
    await first;
    expect(mutation.pending('FLAG')).toBe(true);

    releases[1]('ok');
    await second;
    expect(mutation.pending('FLAG')).toBe(false);
  });

  it('lets the latest call own status and value when an earlier one settles last', async () => {
    let resolveFirst!: (value: string) => void;
    const first = new Promise<string>((resolve) => (resolveFirst = resolve));
    const mutation = orpcMutation(
      vi.fn((input: string) => (input === 'first' ? first : Promise.resolve(input))),
      { injector },
    );

    const firstCall = mutation.mutate('first');
    await mutation.mutate('second');
    resolveFirst('first');
    await firstCall;

    expect(mutation.value()).toBe('second');
    expect(mutation.status()).toBe('success');
    expect(mutation.isPending()).toBe(false);
  });

  it('clears pending state even when onSuccess throws', async () => {
    const mutation = orpcMutation(
      vi.fn(async () => 'ok'),
      {
        injector,
        onSuccess: () => {
          throw new Error('cb');
        },
      },
    );

    await mutation.mutate(undefined).catch(() => undefined);

    expect(mutation.isPending()).toBe(false);
  });

  it('fires once per defined reactive input and skips undefined', async () => {
    const input = signal<{ id: string } | undefined>(undefined);
    const call = vi.fn(async (value: { id: string }) => value.id);

    orpcMutation(call, { injector, input: () => input() });
    await settle();
    expect(call).not.toHaveBeenCalled();

    input.set({ id: 'a' });
    await settle();
    input.set({ id: 'b' });
    await settle();
    input.set(undefined);
    await settle();

    expect(call.mock.calls).toEqual([[{ id: 'a' }], [{ id: 'b' }]]);
  });
});
