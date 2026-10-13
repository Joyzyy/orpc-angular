import type { ClientContext } from '@orpc/client';
import type { StandardLinkTransportInterceptor } from '@orpc/client/standard';
import { operationContext } from '../kernel/orpc-angular-context';

// runtime, not compile-time: client types erase the http method
export function resourceGuardInterceptor<
  T extends ClientContext,
>(): StandardLinkTransportInterceptor<T> {
  return (options) => {
    if (
      typeof ngDevMode !== 'undefined' &&
      ngDevMode &&
      operationContext(options.context)?.resource &&
      options.request.method !== 'GET'
    ) {
      throw new Error(
        `orpcResource only accepts GET procedures; "${options.path.join('.')}" resolves to ${options.request.method}. Call the mutation imperatively instead.`,
      );
    }
    return options.next();
  };
}
