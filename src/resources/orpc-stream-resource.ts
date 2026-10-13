import {
  type BaseResourceOptions,
  resource,
  type ResourceParamsContext,
  ResourceParamsStatus,
  type ResourceRef,
  type ResourceStreamItem,
  signal,
  type ValueEqualityFn,
} from '@angular/core';
import type { ORPCAngularContext } from '../kernel/orpc-angular-context';
import { pumpEvents } from './pump-events';
import { procedureInput, resolveContext, resourceParams } from './resource-input';

declare const ngServerMode: boolean | undefined;

export type ORPCStreamCall<TInput, TEvent, TContext = ORPCAngularContext> = (
  input: TInput,
  options?: { signal?: AbortSignal; context?: TContext },
) => Promise<AsyncIterable<TEvent>>;

export interface ORPCStreamResourceOptions<
  TEvent = unknown,
  TInput = undefined,
  TContext = ORPCAngularContext,
  TValue = TEvent,
> extends Pick<BaseResourceOptions<TValue, unknown>, 'defaultValue' | 'injector'> {
  /** A change reopens the subscription; `undefined` idles */
  input?: (ctx: ResourceParamsContext) => TInput | undefined;
  when?: () => boolean;
  /** Read once per subscribe. Retry policy belongs on the link */
  context?: TContext | (() => TContext);
  /** Starts from `defaultValue`; restarts on `reload()` or a params change */
  accumulate?: (acc: TValue, event: TEvent) => TValue;
  equal?: ValueEqualityFn<TValue>;
  debugName?: string;
}

/**
 * `resolved` once the subscription opens, before the first event: use `hasValue()` to tell
 * "connected, nothing yet" apart. `set()`/`update()` stop the subscription until `reload()`
 * or an input change
 */
export function orpcStreamResource<
  TEvent,
  TInput = undefined,
  TContext = ORPCAngularContext,
  TValue = TEvent,
>(
  call: ORPCStreamCall<TInput, TEvent, TContext>,
  options: ORPCStreamResourceOptions<TEvent, TInput, TContext, TValue> & {
    accumulate: (acc: TValue, event: TEvent) => TValue;
    defaultValue: TValue;
  },
): ResourceRef<TValue>;
export function orpcStreamResource<TEvent, TInput = undefined, TContext = ORPCAngularContext>(
  call: ORPCStreamCall<TInput, TEvent, TContext>,
  options: ORPCStreamResourceOptions<TEvent, TInput, TContext> & {
    defaultValue: NoInfer<TEvent>;
    accumulate?: never;
  },
): ResourceRef<TEvent>;
export function orpcStreamResource<TEvent, TInput = undefined, TContext = ORPCAngularContext>(
  call: ORPCStreamCall<TInput, TEvent, TContext>,
  options?: ORPCStreamResourceOptions<TEvent, TInput, TContext> & { accumulate?: never },
): ResourceRef<TEvent | undefined>;
export function orpcStreamResource<
  TEvent,
  TInput = undefined,
  TContext = ORPCAngularContext,
  TValue = TEvent,
>(
  call: ORPCStreamCall<TInput, TEvent, TContext>,
  options?: ORPCStreamResourceOptions<TEvent, TInput, TContext, TValue>,
): ResourceRef<TValue | undefined> {
  return resource({
    defaultValue: options?.defaultValue,
    equal: options?.equal,
    injector: options?.injector,
    debugName: options?.debugName,
    params: (ctx) => {
      // would hold a pending task past the ssr response
      if (typeof ngServerMode !== 'undefined' && ngServerMode) throw ResourceParamsStatus.IDLE;
      return resourceParams(options, ctx);
    },
    stream: async ({ params, abortSignal }) => {
      const events = await call(procedureInput(options, params), {
        signal: abortSignal,
        context: resolveContext(options?.context),
      });

      // angular reads defaultValue only when there is no stream item at all
      let current = options?.defaultValue as TValue;
      const item = signal<ResourceStreamItem<TValue>>({ value: current });

      void pumpEvents(events, abortSignal, (event) => {
        // not a computed off value(): pull-based readers conflate bursts
        current = options?.accumulate
          ? options.accumulate(current, event)
          : (event as unknown as TValue);
        item.set({ value: current });
      }).catch((error: unknown) => {
        item.set({ error: error instanceof Error ? error : new Error(String(error)) });
      });

      return item;
    },
  });
}
