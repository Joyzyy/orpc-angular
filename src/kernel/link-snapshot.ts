import type { StandardHeaders, StandardLazyResponse, StandardRequest } from '@standard-server/core';

export interface CachedSnapshot {
  status: number;
  headers: StandardHeaders;
  body: unknown;
}

// on the server, transfer state owns hydration
export function isBrowserGet(request: StandardRequest, isBrowser: boolean): boolean {
  return isBrowser && request.method === 'GET';
}

// a lazy body resolves once, so a shared response is drained up front
export async function toSnapshot(response: StandardLazyResponse): Promise<CachedSnapshot> {
  return {
    status: response.status,
    headers: response.headers,
    body: await response.resolveBody(),
  };
}

export function toLazyResponse(snapshot: CachedSnapshot): StandardLazyResponse {
  return {
    status: snapshot.status,
    headers: snapshot.headers,
    resolveBody: () => Promise.resolve(structuredClone(snapshot.body)),
  };
}
