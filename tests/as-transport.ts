import type { ClientContext, ClientOptions } from '@orpc/client';
import type {
  StandardLinkTransport,
  StandardLinkTransportInterceptor,
} from '@orpc/client/standard';
import type { StandardRequest } from '@standard-server/core';

export function asTransport<T extends ClientContext>(
  interceptor: StandardLinkTransportInterceptor<T>,
  inner: Pick<StandardLinkTransport<T>, 'send'>,
): StandardLinkTransport<T> {
  return {
    send: (request: StandardRequest, path: string[], options: ClientOptions<T>) =>
      interceptor({
        ...options,
        request,
        path,
        next: (next = { ...options, request, path }) => inner.send(next.request, next.path, next),
      }),
  };
}
