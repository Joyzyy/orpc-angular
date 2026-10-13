import {
  Injector,
  Resource,
  ResourceSnapshot,
  runInInjectionContext,
  signal,
  WritableSignal,
} from '@angular/core';
import { describe, expect, it } from 'vitest';
import { resilientResource } from './resilient-resource';

type Snap<T> = ResourceSnapshot<T>;

const resolved = <T>(value: T): Snap<T> => ({ status: 'resolved', value });
const loading = <T>(): Snap<T> => ({ status: 'loading', value: undefined as T });
const failed = <T>(error: Error): Snap<T> => ({ status: 'error', error });

// the helper only reads source.snapshot, so a writable snapshot signal fakes the source
function fakeSource<T>(initial: Snap<T>): {
  source: Resource<T>;
  snapshot: WritableSignal<Snap<T>>;
} {
  const snapshot = signal<Snap<T>>(initial);
  return { source: { snapshot } as unknown as Resource<T>, snapshot };
}

function make<T>(
  initial: Snap<T>,
  options?: { keepValueWhileLoading?: boolean; keepValueOnError?: boolean },
) {
  const { source, snapshot } = fakeSource(initial);
  const injector = Injector.create({ providers: [] });
  const resource = runInInjectionContext(injector, () => resilientResource(source, options));
  return { resource, snapshot };
}

describe('resilientResource', () => {
  describe('default options (passthrough)', () => {
    it('mirrors the source across resolve, loading, and error', () => {
      const { resource, snapshot } = make<string>(resolved('A'));
      expect(resource.value()).toBe('A');
      expect(resource.isLoading()).toBe(false);
      expect(resource.error()).toBeUndefined();
      expect(resource.hasError()).toBe(false);

      snapshot.set(loading());
      expect(resource.value()).toBeUndefined();
      expect(resource.isLoading()).toBe(true);

      snapshot.set(resolved('B'));
      expect(resource.value()).toBe('B');

      const boom = new Error('boom');
      snapshot.set(failed(boom));
      expect(resource.value()).toBeUndefined();
      expect(resource.error()).toBe(boom);
      expect(resource.hasError()).toBe(false);
      expect(resource.isLoading()).toBe(false);
    });
  });

  describe('keepValueWhileLoading', () => {
    it('retains the previous value while loading, then swaps to the new value', () => {
      const { resource, snapshot } = make<string>(resolved('A'), {
        keepValueWhileLoading: true,
      });
      expect(resource.value()).toBe('A');

      snapshot.set(loading());
      expect(resource.value()).toBe('A');
      expect(resource.isLoading()).toBe(true);

      snapshot.set(resolved('B'));
      expect(resource.value()).toBe('B');
      expect(resource.isLoading()).toBe(false);
    });

    it('does NOT serve stale data on error; exposes the error instead', () => {
      const { resource, snapshot } = make<string>(resolved('A'), {
        keepValueWhileLoading: true,
      });
      const boom = new Error('nope');
      snapshot.set(failed(boom));

      expect(resource.value()).toBeUndefined();
      expect(resource.error()).toBe(boom);
      expect(resource.hasError()).toBe(false);
    });
  });

  describe('keepValueOnError', () => {
    it('serves the previous value on error with hasError() true', () => {
      const { resource, snapshot } = make<string>(resolved('A'), {
        keepValueOnError: true,
      });
      // read value() to establish the retained snapshot (templates read every CD)
      expect(resource.value()).toBe('A');
      expect(resource.hasError()).toBe(false);

      snapshot.set(failed(new Error('boom')));
      expect(resource.value()).toBe('A');
      expect(resource.hasError()).toBe(true);
      expect(resource.isLoading()).toBe(false);
    });

    it('serves the previous value through the loading snapshot a real failure passes through', () => {
      // a real source always loads before it errors, so `previous` is that loading snapshot
      const { resource, snapshot } = make<string>(resolved('A'), {
        keepValueOnError: true,
      });
      expect(resource.value()).toBe('A');

      snapshot.set(loading());
      expect(resource.isLoading()).toBe(true);

      snapshot.set(failed(new Error('boom')));
      expect(resource.value()).toBe('A');
      expect(resource.hasError()).toBe(true);
    });

    it('serves the previous value on failure under the resilientORPCResource defaults', () => {
      const { resource, snapshot } = make<string>(resolved('A'), {
        keepValueOnError: true,
        keepValueWhileLoading: true,
      });
      expect(resource.value()).toBe('A');

      snapshot.set(loading());
      expect(resource.value()).toBe('A');

      snapshot.set(failed(new Error('boom')));
      expect(resource.value()).toBe('A');
      expect(resource.hasError()).toBe(true);
    });

    it('exposes a first-load error even when a defaultValue fills the loading snapshot', () => {
      // with defaultValue a loading snapshot carries the default, not undefined
      const { resource, snapshot } = make<string[]>(
        { status: 'loading', value: [] },
        { keepValueOnError: true },
      );
      expect(resource.value()).toEqual([]);

      const boom = new Error('first load failed');
      snapshot.set(failed(boom));
      expect(resource.value()).toBeUndefined();
      expect(resource.error()).toBe(boom);
    });

    it('exposes a FIRST-load error instead of masking it with the loading snapshot', () => {
      const { resource, snapshot } = make<string>(loading(), {
        keepValueOnError: true,
      });
      // template reads during the initial load, making `loading` the previous snapshot
      expect(resource.value()).toBeUndefined();
      expect(resource.isLoading()).toBe(true);

      const boom = new Error('first load failed');
      snapshot.set(failed(boom));
      expect(resource.value()).toBeUndefined();
      expect(resource.error()).toBe(boom);
      expect(resource.isLoading()).toBe(false);
    });

    it('resets hasError() once a subsequent load starts and resolves', () => {
      const { resource, snapshot } = make<string>(resolved('A'), {
        keepValueOnError: true,
      });
      expect(resource.value()).toBe('A');
      snapshot.set(failed(new Error('boom')));
      expect(resource.hasError()).toBe(true);

      snapshot.set(loading());
      expect(resource.hasError()).toBe(false);

      snapshot.set(resolved('B'));
      expect(resource.hasError()).toBe(false);
      expect(resource.value()).toBe('B');
    });
  });
});
