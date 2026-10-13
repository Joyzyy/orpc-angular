import { DestroyRef, inject, PLATFORM_ID } from '@angular/core';
import { ORPCQueryCache } from './../kernel/orpc-query-cache';
import { isPlatformServer } from '@angular/common';

export function pollTags(tags: readonly string[], intervalMs: number): void {
  if (isPlatformServer(inject(PLATFORM_ID))) return;
  const cache = inject(ORPCQueryCache);
  const destroyRef = inject(DestroyRef);
  const id = setInterval(() => {
    if (!document.hidden) cache.invalidate(...tags);
  }, intervalMs);
  destroyRef.onDestroy(() => clearInterval(id));
}
