import { Injector, PLATFORM_ID, runInInjectionContext } from '@angular/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ORPCQueryCache } from '../kernel/orpc-query-cache';
import { pollTags } from './poll-tags';

vi.mock('@angular/common', () => ({
  isPlatformServer: (platformId: unknown) => platformId === 'server',
}));

const fakeDocument = { hidden: false };

function setup(platform = 'browser') {
  const invalidate = vi.fn();
  const injector = Injector.create({
    providers: [
      { provide: PLATFORM_ID, useValue: platform },
      { provide: ORPCQueryCache, useValue: { invalidate } },
    ],
  });
  runInInjectionContext(injector, () => pollTags(['users:table'], 1000));
  return { invalidate, destroy: () => (injector as unknown as { destroy: () => void }).destroy() };
}

describe('pollTags', () => {
  vi.stubGlobal('document', fakeDocument);

  afterEach(() => {
    vi.useRealTimers();
    fakeDocument.hidden = false;
  });

  it('invalidates the tags on the interval and stops after destroy', () => {
    vi.useFakeTimers();
    const { invalidate, destroy } = setup();

    vi.advanceTimersByTime(3000);
    expect(invalidate).toHaveBeenCalledTimes(3);
    expect(invalidate).toHaveBeenCalledWith('users:table');

    destroy();
    vi.advanceTimersByTime(3000);
    expect(invalidate).toHaveBeenCalledTimes(3);
  });

  it('skips invalidation while the tab is hidden', () => {
    vi.useFakeTimers();
    const { invalidate } = setup();

    fakeDocument.hidden = true;
    vi.advanceTimersByTime(2000);
    expect(invalidate).not.toHaveBeenCalled();

    fakeDocument.hidden = false;
    vi.advanceTimersByTime(1000);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('does nothing on the server', () => {
    vi.useFakeTimers();
    const { invalidate } = setup('server');
    vi.advanceTimersByTime(3000);
    expect(invalidate).not.toHaveBeenCalled();
  });
});
