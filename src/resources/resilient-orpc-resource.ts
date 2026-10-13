import { type ORPCCall, orpcResource, type ORPCResourceOptions } from './orpc-resource';
import { resilientResource, type ResilientResource } from './resilient-resource';

export interface ResilientORPCResourceOptions<
  TOutput = unknown,
  TInput = undefined,
> extends ORPCResourceOptions<TOutput, TInput> {
  /** @default true */
  keepValueWhileLoading?: boolean;
  /** @default false */
  keepValueOnError?: boolean;
}

// no defaultValue overload: value() is undefined on error, which a narrowed TOutput would deny
export function resilientORPCResource<TOutput, TInput = undefined, TError extends Error = Error>(
  call: ORPCCall<TInput, TOutput, TError>,
  options?: ResilientORPCResourceOptions<TOutput, TInput>,
): ResilientResource<TOutput | undefined> & { reload: () => boolean } {
  const ref = orpcResource(call, options);
  const resilient = resilientResource(ref, {
    keepValueWhileLoading: options?.keepValueWhileLoading ?? true,
    keepValueOnError: options?.keepValueOnError,
  });

  return {
    ...resilient,
    reload: () => ref.reload(),
  };
}
