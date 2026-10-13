import {
  computed,
  linkedSignal,
  Resource,
  resourceFromSnapshots,
  ResourceSnapshot,
  Signal,
  type ResourceStatus,
} from '@angular/core';

/** `value()` is `undefined` on error instead of throwing */
export interface ResilientResource<T> {
  value: Signal<T | undefined>;
  isLoading: Signal<boolean>;
  status: Signal<ResourceStatus>;
  error: Signal<Error | undefined>;
  /** The source errored under `keepValueOnError` */
  hasError: Signal<boolean>;
}

/** A failed first load has no value to keep, so it still surfaces as `error()` */
export function resilientResource<T>(
  source: Resource<T>,
  options: {
    keepValueWhileLoading?: boolean;
    keepValueOnError?: boolean;
  } = {},
): ResilientResource<T> {
  const withValueWhileLoading = (
    current: ResourceSnapshot<T>,
    previous: ResourceSnapshot<T> | undefined,
  ): ResourceSnapshot<T> => {
    if (current.status === 'loading' && previous && previous.status !== 'error')
      return {
        status: 'loading',
        value: previous.value,
      };
    return current;
  };

  // not `previous`: a failed refetch goes resolved → loading → error
  const lastResolved = linkedSignal<ResourceSnapshot<T>, { value: T } | undefined>({
    source: source.snapshot,
    computation: (current, previous) =>
      current.status === 'resolved' || current.status === 'local'
        ? { value: current.value }
        : previous?.value,
  });

  const withValueOnError = (current: ResourceSnapshot<T>): ResourceSnapshot<T> => {
    // read unconditionally, or `lastResolved` stops tracking
    const held = lastResolved();
    if (current.status === 'error' && held) {
      return {
        status: 'resolved',
        value: held.value,
      };
    }
    return current;
  };

  const handlers: ((
    current: ResourceSnapshot<T>,
    previous: ResourceSnapshot<T> | undefined,
  ) => ResourceSnapshot<T>)[] = [
    ...(options.keepValueOnError ? [withValueOnError] : []),
    ...(options.keepValueWhileLoading ? [withValueWhileLoading] : []),
  ];

  const derivedSnapshot = linkedSignal<ResourceSnapshot<T>, ResourceSnapshot<T>>({
    source: source.snapshot,
    computation: (current, previous) =>
      handlers.reduce((acc, handler) => handler(acc, previous?.value), current),
  });

  const derived = resourceFromSnapshots(derivedSnapshot);

  return {
    value: computed(() => (derived.hasValue() ? derived.value() : undefined)),
    isLoading: computed(() => derived.isLoading()),
    status: computed(() => derived.status()),
    error: computed(() => derived.error()),
    hasError: computed(
      () => options.keepValueOnError === true && source.snapshot().status === 'error',
    ),
  };
}
