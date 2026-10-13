import {
  Injector,
  Resource,
  ResourceSnapshot,
  runInInjectionContext,
  signal,
  WritableSignal,
} from '@angular/core';
import { describe, expect, it } from 'vitest';
import { mergeResources } from './merge-resources';

type Snap<T> = ResourceSnapshot<T>;

const resolved = <T>(value: T): Snap<T> => ({ status: 'resolved', value });
const loading = <T>(value?: T): Snap<T> => ({ status: 'loading', value: value as T });
const reloading = <T>(value: T): Snap<T> => ({ status: 'reloading', value });
const failed = <T>(error: Error): Snap<T> => ({ status: 'error', error });

function fakeSource<T>(initial: Snap<T>): {
  source: Resource<T>;
  snapshot: WritableSignal<Snap<T>>;
} {
  const snapshot = signal<Snap<T>>(initial);
  return { source: { snapshot } as unknown as Resource<T>, snapshot };
}

function make(a: Snap<string>, b: Snap<number | null>) {
  const left = fakeSource(a);
  const right = fakeSource(b);
  const injector = Injector.create({ providers: [] });
  const merged = runInInjectionContext(injector, () =>
    mergeResources({ left: left.source, right: right.source }),
  );
  return { merged, left: left.snapshot, right: right.snapshot };
}

describe('mergeResources', () => {
  it('resolves to the keyed record once every source resolves', () => {
    const { merged } = make(resolved('A'), resolved(1));
    expect(merged.hasValue()).toBe(true);
    expect(merged.value()).toEqual({ left: 'A', right: 1 });
    expect(merged.isLoading()).toBe(false);
  });

  it('is loading with no value while any source still loads', () => {
    const { merged, right } = make(resolved('A'), loading());
    expect(merged.isLoading()).toBe(true);
    expect(merged.hasValue()).toBe(false);

    right.set(resolved(1));
    expect(merged.value()).toEqual({ left: 'A', right: 1 });
  });

  it('keeps the merged value through a reload of one source', () => {
    const { merged, left } = make(resolved('A'), resolved(1));
    left.set(reloading('A'));
    expect(merged.isLoading()).toBe(true);
    expect(merged.value()).toEqual({ left: 'A', right: 1 });
  });

  it('propagates the first source error', () => {
    const boom = new Error('boom');
    const { merged } = make(resolved('A'), failed(boom));
    expect(merged.error()).toBe(boom);
    expect(merged.hasValue()).toBe(false);
  });

  it('treats null as a resolved value', () => {
    const { merged } = make(resolved('A'), resolved(null));
    expect(merged.value()).toEqual({ left: 'A', right: null });
  });
});
