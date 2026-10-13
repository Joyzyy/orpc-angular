import { isPlatformBrowser } from '@angular/common';
import { inject, InjectionToken, PLATFORM_ID, REQUEST } from '@angular/core';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { RouterClient } from '@orpc/server';
import { type ORPCAngularContext, ORPCAngularLinkPlugin } from 'orpc-angular';
import type { router } from '../api/router';

export const ORPC = new InjectionToken<RouterClient<typeof router, ORPCAngularContext>>('ORPC', {
  factory: () => {
    const request = inject(REQUEST, { optional: true });
    const origin = isPlatformBrowser(inject(PLATFORM_ID))
      ? location.origin
      : new URL(request?.url ?? 'http://localhost:4000').origin;

    return createORPCClient(
      new RPCLink<ORPCAngularContext>({
        origin,
        url: '/rpc',
        method: (_options, path) =>
          /^(list|find|ticks)$/.test(path.at(-1) ?? '') ? 'GET' : 'POST',
        plugins: [new ORPCAngularLinkPlugin()],
      }),
    );
  },
});
