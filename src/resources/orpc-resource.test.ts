import { ORPC_ANGULAR_CONTEXT_SYMBOL } from '../kernel/orpc-angular-context';
import { Injector, type ResourceLoaderParams, ResourceParamsStatus } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { orpcResource } from './orpc-resource';

// resource() is mocked to return its options, so the tests drive params/loader directly
vi.mock('@angular/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@angular/core')>();
  return {
    ...actual,
    resource: vi.fn((options: unknown) => options),
  };
});

interface CapturedResourceOptions {
  id?: string;
  defaultValue?: unknown;
  equal?: unknown;
  injector?: unknown;
  debugName?: string;
  params: (ctx?: unknown) => unknown;
  loader: (params: ResourceLoaderParams<unknown>) => Promise<unknown>;
}

function capture(...args: Parameters<typeof orpcResource>): CapturedResourceOptions {
  return orpcResource(...args) as unknown as CapturedResourceOptions;
}

function loaderParams(params: unknown, abortSignal: AbortSignal) {
  return { params, abortSignal } as ResourceLoaderParams<unknown>;
}

describe('orpcResource', () => {
  it('stamps the resource flag on the loader call context', async () => {
    const call = vi.fn(async () => 'out');
    const { signal } = new AbortController();

    const captured = capture(call, { input: () => ({ q: 1 }) });
    await captured.loader(loaderParams({ q: 1 }, signal));

    expect(call).toHaveBeenCalledWith(
      { q: 1 },
      { signal, context: { [ORPC_ANGULAR_CONTEXT_SYMBOL]: { resource: true } } },
    );
  });

  it('stamps transferCache: false only when an id delegates hydration to the resource transfer', async () => {
    const call = vi.fn(async () => 'out');
    const { signal } = new AbortController();

    // `id` looks up the cache, which needs a real injector
    const withId = capture(call, { id: 'thing', injector: Injector.create({ providers: [] }) });
    await withId.loader(loaderParams(null, signal));

    expect(withId.id).toBe('thing');
    expect(call).toHaveBeenCalledWith(undefined, {
      signal,
      context: { [ORPC_ANGULAR_CONTEXT_SYMBOL]: { resource: true, transferCache: false } },
    });
  });

  it('merges the resolved context, keeping the stamps', async () => {
    const call = vi.fn(async () => 'out');
    const { signal } = new AbortController();

    const captured = capture(call, {
      context: () => ({ cache: { tags: ['t'] } }),
      injector: Injector.create({ providers: [] }),
    });
    await captured.loader(loaderParams(null, signal));

    expect(call).toHaveBeenCalledWith(undefined, {
      signal,
      context: { cache: { tags: ['t'] }, [ORPC_ANGULAR_CONTEXT_SYMBOL]: { resource: true } },
    });
  });

  it('forwards the native resource options through untouched, and keeps ours out', () => {
    // `capture` erases inference, so `equal` is typed against unknown here
    const equal = (a: unknown, b: unknown) => a === b;
    const injector = Injector.create({ providers: [] });

    const captured = capture(
      vi.fn(async () => 1),
      {
        defaultValue: 0,
        equal,
        injector,
        debugName: 'wallet',
        when: () => true,
        context: { cache: { tags: ['t'] } },
      },
    );

    expect(captured.defaultValue).toBe(0);
    expect(captured.equal).toBe(equal);
    expect(captured.injector).toBe(injector);
    expect(captured.debugName).toBe('wallet');
    expect(captured).not.toHaveProperty('input');
    expect(captured).not.toHaveProperty('when');
    expect(captured).not.toHaveProperty('context');
  });

  it('passes the params context to input so it can chain off another resource', () => {
    const ctx = { chain: vi.fn(() => 'chained') } as never;

    const captured = capture(
      vi.fn(async () => 'out'),
      {
        input: (c) => ({ q: (c as { chain: (r: unknown) => string }).chain(null) }),
      },
    );

    expect(captured.params(ctx)).toEqual({ q: 'chained' });
  });

  it('returns the input unboxed, and null for a procedure that takes none', () => {
    expect(capture(vi.fn(async () => 'out')).params()).toBeNull();
    expect(
      capture(
        vi.fn(async () => 'out'),
        { input: () => ({ q: 1 }) },
      ).params(),
    ).toEqual({
      q: 1,
    });
  });

  it('passes a nullish input straight through instead of reading it as no-input', async () => {
    const call = vi.fn(async () => 'out');
    const { signal } = new AbortController();

    const captured = capture(call, { input: () => null });
    expect(captured.params()).toBeNull();

    await captured.loader(loaderParams(null, signal));
    expect(call).toHaveBeenCalledWith(null, {
      signal,
      context: { [ORPC_ANGULAR_CONTEXT_SYMBOL]: { resource: true } },
    });
  });

  it('idles when a declared input returns undefined, per Angular params contract', () => {
    let id: string | null = null;
    const captured = capture(
      vi.fn(async () => 'out'),
      { input: () => (id ? { id } : undefined) },
    );

    expect(captured.params()).toBeUndefined();
    id = 'd1';
    expect(captured.params()).toEqual({ id: 'd1' });
  });

  it('idles the resource while the when gate is closed, via Angular own IDLE signal', () => {
    let open = false;
    const captured = capture(
      vi.fn(async () => 'out'),
      {
        input: () => ({ q: 1 }),
        when: () => open,
      },
    );

    expect(() => captured.params()).toThrow(ResourceParamsStatus.IDLE);
    open = true;
    expect(captured.params()).toEqual({ q: 1 });
  });

  it('checks the gate before input, so a closed gate never evaluates input', () => {
    const input = vi.fn(() => ({ q: 1 }));
    const captured = capture(
      vi.fn(async () => 'out'),
      { input, when: () => false },
    );

    expect(() => captured.params()).toThrow();
    expect(input).not.toHaveBeenCalled();
  });

  it('reuses the previous load for unchanged data, so a no-op refetch notifies nobody', async () => {
    let text = 'a';
    const call = vi.fn(async () => ({ rows: [{ id: 1 }], text }));
    const { signal } = new AbortController();
    const captured = capture(call);

    const first = (await captured.loader(loaderParams(null, signal))) as { rows: unknown[] };
    expect(await captured.loader(loaderParams(null, signal))).toBe(first);

    text = 'b';
    const changed = (await captured.loader(loaderParams(null, signal))) as { rows: unknown[] };
    expect(changed).not.toBe(first);
    expect(changed.rows).toBe(first.rows);
  });
});
