import {
  effect,
  type Injector,
  type ResourceParamsContext,
  ResourceParamsStatus,
  untracked,
} from '@angular/core';
import {
  ORPC_ANGULAR_CONTEXT_SYMBOL,
  type ORPCAngularContext,
} from '../kernel/orpc-angular-context';
import type { ORPCQueryCache } from '../kernel/orpc-query-cache';

export interface ResourceInputOptions<TInput> {
  input?: (ctx: ResourceParamsContext) => TInput | undefined;
  when?: () => boolean;
}

// null stands in for "no input": undefined would idle a no-input procedure
export function resourceParams<TInput>(
  options: ResourceInputOptions<TInput> | undefined,
  ctx: ResourceParamsContext,
): TInput | null | undefined {
  if (options?.when && !options.when()) throw ResourceParamsStatus.IDLE;
  return options?.input ? options.input(ctx) : null;
}

export function procedureInput<TInput>(
  options: ResourceInputOptions<TInput> | undefined,
  params: unknown,
): TInput {
  return options?.input ? (params as TInput) : (undefined as TInput);
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val: unknown) =>
    val !== null && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => (a < b ? -1 : 1)))
      : val,
  );
}

export function resourceCallContext(
  options: { id?: string; context?: ORPCAngularContext | (() => ORPCAngularContext) } | undefined,
): ORPCAngularContext {
  return {
    ...resolveContext(options?.context),
    [ORPC_ANGULAR_CONTEXT_SYMBOL]: {
      resource: true,
      ...(options?.id ? { transferCache: false as const } : {}),
    },
  };
}

export function resolveContext<TContext>(
  context: TContext | (() => TContext) | undefined,
): TContext | undefined {
  return typeof context === 'function' ? (context as () => TContext)() : context;
}

export function onTagBump(
  cache: ORPCQueryCache,
  options:
    | {
        when?: () => boolean;
        context?: ORPCAngularContext | (() => ORPCAngularContext);
        injector?: Injector;
      }
    | undefined,
  bump: () => void,
): void {
  let seen: number | undefined;
  effect(
    () => {
      if (options?.when && !options.when()) return;
      const tags = resolveContext(options?.context)?.cache?.tags;
      if (!tags?.length) return;
      let version = 0;
      for (const tag of tags) version += cache.tagVersion(tag)();
      const previous = seen;
      seen = version;
      if (previous !== undefined && previous !== version) untracked(bump);
    },
    { injector: options?.injector },
  );
}
