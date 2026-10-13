import type { Client, ORPCError, SafeResult } from '@orpc/client';
import { expectTypeOf } from 'vitest';
import type { ORPCAngularContext } from './kernel/orpc-angular-context';
import { orpcMutation } from './mutations/orpc-mutation';
import { orpcInfiniteResource } from './resources/orpc-infinite-resource';
import { orpcResource } from './resources/orpc-resource';

type Planet = { id: number; name: string };
type NotFound = ORPCError<'NOT_FOUND', { id: number }>;

declare const find: Client<ORPCAngularContext, { id: number }, Planet, NotFound | Error>;
declare const list: Client<ORPCAngularContext, { offset: number; limit: number }, Planet[], Error>;
declare const me: Client<ORPCAngularContext, undefined, Planet, Error>;
declare const create: Client<ORPCAngularContext, { name: string }, Planet, NotFound | Error>;

export function resourceTypes(): void {
  const planet = orpcResource(find, { input: () => ({ id: 1 }) });
  expectTypeOf(planet.value()).toEqualTypeOf<Planet | undefined>();
  expectTypeOf(planet.error()).toEqualTypeOf<NotFound | Error | undefined>();

  if (planet.hasValue()) {
    expectTypeOf(planet.value()).toEqualTypeOf<Planet>();
    expectTypeOf(planet.error()).toEqualTypeOf<NotFound | Error | undefined>();
    expectTypeOf(planet.reload).toEqualTypeOf<() => boolean>();
  }

  const withDefault = orpcResource(me, { defaultValue: { id: 0, name: '' } });
  expectTypeOf(withDefault.value()).toEqualTypeOf<Planet>();

  // @ts-expect-error the input must match the procedure
  orpcResource(find, { input: () => ({ id: 'one' }) });

  orpcResource(find, { input: () => ({ id: 1 }), context: { cache: { tags: ['planets'] } } });
}

export function infiniteTypes(): void {
  const planets = orpcInfiniteResource(list, {
    input: (range) => range,
    pageSize: 20,
    items: (page) => page,
  });
  expectTypeOf(planets.items()).toEqualTypeOf<Planet[]>();
  expectTypeOf(planets.error()).toEqualTypeOf<Error | undefined>();
}

export function mutationTypes(): void {
  const mutation = orpcMutation(create, {
    onMutate: (input) => input.name.length,
    onSuccess: (data, _input, context) => {
      expectTypeOf(data).toEqualTypeOf<Planet>();
      expectTypeOf(context).toEqualTypeOf<number>();
    },
  });
  expectTypeOf(mutation.mutate).parameter(0).toEqualTypeOf<{ name: string }>();
  expectTypeOf(mutation.mutate).returns.resolves.toEqualTypeOf<
    SafeResult<Planet, NotFound | Error>
  >();
  expectTypeOf(mutation.error()).toEqualTypeOf<NotFound | Error | undefined>();
}
