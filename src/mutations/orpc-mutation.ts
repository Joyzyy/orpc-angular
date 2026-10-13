import { computed, effect, inject, Injector, type Signal, signal, untracked } from '@angular/core';
import { type Client, type PromiseWithError, safe, type SafeResult } from '@orpc/client';
import { ORPCCache } from '../kernel/orpc-cache';

type AnyProcedure = Client<any, any, any, any>;
type InferInput<T> = T extends Client<any, infer U, any, any> ? U : never;
type InferOutput<T> = T extends Client<any, any, infer U, any> ? U : never;
type InferError<T> = T extends Client<any, any, any, infer U> ? U : never;

export type ORPCMutationStatus = 'idle' | 'pending' | 'success' | 'error';

export interface ORPCMutationOptions<TInput, TOutput, TError, TContext = undefined> {
  invalidate?: (input: TInput) => readonly string[];
  key?: (input: TInput) => string;
  /** Runs synchronously before the call; its return value reaches `onSuccess`/`onError` */
  onMutate?: (input: TInput) => TContext;
  onSuccess?: (data: TOutput, input: TInput, context: TContext) => void;
  onError?: (error: TError, input: TInput, context: TContext) => void;
  input?: () => TInput | undefined;
  injector?: Injector;
}

export interface ORPCMutationRef<TInput, TOutput, TError> {
  mutate(input: TInput): Promise<SafeResult<TOutput, TError>>;
  status: Signal<ORPCMutationStatus>;
  isPending: Signal<boolean>;
  error: Signal<TError | undefined>;
  value: Signal<TOutput | undefined>;
  pending(key: string): boolean;
}

export function orpcMutation<TProcedure extends AnyProcedure, TContext = undefined>(
  procedure: TProcedure,
  options?: ORPCMutationOptions<
    InferInput<TProcedure>,
    InferOutput<TProcedure>,
    InferError<TProcedure>,
    TContext
  >,
): ORPCMutationRef<InferInput<TProcedure>, InferOutput<TProcedure>, InferError<TProcedure>> {
  type TInput = InferInput<TProcedure>;
  type TOutput = InferOutput<TProcedure>;
  type TError = InferError<TProcedure>;

  const cache = options?.invalidate
    ? (options.injector ?? inject(Injector)).get(ORPCCache)
    : undefined;

  const call = procedure as (input: TInput) => PromiseWithError<TOutput, TError>;

  const status = signal<ORPCMutationStatus>('idle');
  const error = signal<TError | undefined>(undefined);
  const value = signal<TOutput | undefined>(undefined);
  const inFlight = signal(0);
  const keys = signal<ReadonlyMap<string, number>>(new Map());
  let latest = 0;

  // only the latest call settles status/error/value; older ones still invalidate and fire callbacks
  async function mutate(input: TInput): Promise<SafeResult<TOutput, TError>> {
    const key = options?.key?.(input);
    const seq = ++latest;
    inFlight.update((n) => n + 1);
    if (key !== undefined) keys.update((map) => new Map(map).set(key, (map.get(key) ?? 0) + 1));
    status.set('pending');

    let context: TContext;
    let result: SafeResult<TOutput, TError>;
    try {
      context = options?.onMutate?.(input) as TContext;
      result = await safe(call(input));
    } finally {
      inFlight.update((n) => n - 1);
      if (key !== undefined) {
        keys.update((map) => {
          const next = new Map(map);
          const count = (next.get(key) ?? 1) - 1;
          if (count > 0) next.set(key, count);
          else next.delete(key);
          return next;
        });
      }
    }

    const current = seq === latest;
    if (result.isSuccess) {
      const tags = options?.invalidate?.(input);
      if (tags?.length) cache?.invalidate(...tags);
      if (current) {
        status.set('success');
        error.set(undefined);
        value.set(result.data);
      }
      options?.onSuccess?.(result.data, input, context);
    } else {
      if (current) {
        status.set('error');
        error.set(result.error);
      }
      options?.onError?.(result.error, input, context);
    }

    return result;
  }

  if (options?.input) {
    const read = options.input;
    effect(
      () => {
        const input = read();
        if (input === undefined) return;
        untracked(() => void mutate(input));
      },
      { injector: options.injector },
    );
  }

  const isPending = computed(() => inFlight() > 0);

  return {
    mutate,
    status,
    isPending,
    error,
    value,
    pending: (key: string) => keys().has(key),
  };
}
