export const ORPC_ANGULAR_CONTEXT_SYMBOL: unique symbol = Symbol.for(
  'ORPC_ANGULAR_OPERATION_CONTEXT',
) as never;

export interface ORPCAngularOperationContext {
  /** Arms the dev GET guard */
  resource?: true;
  /** A resource `id` owns hydration */
  transferCache?: false;
}

/** Client context read by `ORPCAngularLinkPlugin`; intersect it into your client's context */
// a type, not an interface: only the implicit index signature satisfies oRPC's ClientContext
export type ORPCAngularContext = {
  /** GET only, keyed by URL */
  cache?: {
    tags: string[];
  };
  /** Concurrent identical GETs join one request; nothing is kept after it settles */
  dedupe?: true;
  /** Set by the resources, never by callers */
  [ORPC_ANGULAR_CONTEXT_SYMBOL]?: ORPCAngularOperationContext;
};

export function operationContext(context: unknown): ORPCAngularOperationContext | undefined {
  return (context as ORPCAngularContext | undefined)?.[ORPC_ANGULAR_CONTEXT_SYMBOL];
}
