import { ORPC_ANGULAR_CONTEXT_SYMBOL } from '../kernel/orpc-angular-context';
import type { StandardLazyResponse, StandardRequest } from '@standard-server/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ORPCAngularContext } from '../kernel/orpc-angular-context';
import { resourceGuardInterceptor } from './resource-guard-interceptor';

function response(status: number): StandardLazyResponse {
  return { status, headers: {}, resolveBody: () => Promise.resolve(null) };
}

function interceptorOptions(
  context: ORPCAngularContext,
  method: string,
  next: () => Promise<StandardLazyResponse>,
  path: string[] = ['admin', 'users', 'list'],
) {
  return {
    context,
    signal: undefined,
    path,
    request: { method } as StandardRequest,
    next,
  };
}

function setNgDevMode(value: unknown): void {
  (globalThis as Record<string, unknown>)['ngDevMode'] = value;
}

describe('resourceGuardInterceptor', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)['ngDevMode'];
  });

  it('throws in dev when a resource call resolves to a non-GET method', async () => {
    setNgDevMode(true);
    const interceptor = resourceGuardInterceptor<ORPCAngularContext>();
    const next = vi.fn(async () => response(200));

    await expect(async () =>
      interceptor(
        interceptorOptions({ [ORPC_ANGULAR_CONTEXT_SYMBOL]: { resource: true } }, 'POST', next),
      ),
    ).rejects.toThrow(
      'orpcResource only accepts GET procedures; "admin.users.list" resolves to POST',
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('passes a GET resource call through', async () => {
    setNgDevMode(true);
    const interceptor = resourceGuardInterceptor<ORPCAngularContext>();
    const next = vi.fn(async () => response(200));

    const result = await interceptor(
      interceptorOptions({ [ORPC_ANGULAR_CONTEXT_SYMBOL]: { resource: true } }, 'GET', next),
    );

    expect(next).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(200);
  });

  it('passes a non-GET call through when not made via orpcResource', async () => {
    setNgDevMode(true);
    const interceptor = resourceGuardInterceptor<ORPCAngularContext>();
    const next = vi.fn(async () => response(200));

    const result = await interceptor(interceptorOptions({}, 'POST', next));

    expect(next).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(200);
  });

  it('is a no-op outside dev mode', async () => {
    const interceptor = resourceGuardInterceptor<ORPCAngularContext>();
    const next = vi.fn(async () => response(200));

    const result = await interceptor(
      interceptorOptions({ [ORPC_ANGULAR_CONTEXT_SYMBOL]: { resource: true } }, 'POST', next),
    );

    expect(next).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(200);
  });
});
