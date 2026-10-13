import { Component, inject, signal } from '@angular/core';
import { isDefinedError } from '@orpc/client';
import { orpcInfiniteResource, orpcMutation, orpcResource, orpcStreamResource } from 'orpc-angular';
import { ORPC } from './orpc';

const planets = { cache: { tags: ['planets'] } };

@Component({
  selector: 'app-root',
  templateUrl: './app.html',
})
export class App {
  private readonly orpc = inject(ORPC);

  protected readonly selectedId = signal(3);
  protected readonly name = signal('');

  protected readonly list = orpcInfiniteResource(this.orpc.planet.list, {
    id: 'planet-list',
    input: (range) => range,
    pageSize: 2,
    items: (page) => page.items,
    hasMore: (page, range) => range.offset + range.limit < page.total,
    context: planets,
  });

  protected readonly planet = orpcResource(this.orpc.planet.find, {
    id: 'planet-find',
    input: () => ({ id: this.selectedId() }),
    context: planets,
  });

  protected readonly first = orpcResource(this.orpc.planet.find, { input: () => ({ id: 1 }) });

  protected readonly create = orpcMutation(this.orpc.planet.create, {
    invalidate: () => ['planets'],
    onSuccess: () => this.name.set(''),
  });

  protected readonly ticks = orpcStreamResource(this.orpc.clock.ticks, {
    defaultValue: 0,
    accumulate: (_count, tick) => tick.n,
  });

  protected notFound(): string | undefined {
    const error = this.planet.error();
    return isDefinedError(error) && error.code === 'NOT_FOUND'
      ? `NOT_FOUND ${error.data.id}`
      : undefined;
  }

  protected save(): void {
    void this.create.mutate({ name: this.name() });
  }
}
