import { asyncIteratorObject, os } from '@orpc/server';
import * as z from 'zod';

const Planet = z.object({ id: z.number(), name: z.string() });
export type Planet = z.infer<typeof Planet>;

const planets: Planet[] = [
  { id: 1, name: 'Mercury' },
  { id: 2, name: 'Venus' },
  { id: 3, name: 'Earth' },
  { id: 4, name: 'Mars' },
  { id: 5, name: 'Jupiter' },
];

export const hits: Record<string, number> = {};

const base = os.use(({ next, path }) => {
  const key = path.join('.');
  hits[key] = (hits[key] ?? 0) + 1;
  return next();
});

export const router = {
  planet: {
    list: base
      .input(z.object({ offset: z.number(), limit: z.number() }))
      .output(z.object({ items: z.array(Planet), total: z.number() }))
      .handler(({ input }) => ({
        items: planets.slice(input.offset, input.offset + input.limit),
        total: planets.length,
      })),

    find: base
      .errors({ NOT_FOUND: { data: z.object({ id: z.number() }) } })
      .input(z.object({ id: z.number() }))
      .output(Planet)
      .handler(({ input, errors }) => {
        const planet = planets.find((p) => p.id === input.id);
        if (!planet) throw errors.NOT_FOUND({ data: { id: input.id } });
        return planet;
      }),

    create: base
      .input(z.object({ name: z.string().min(1) }))
      .output(Planet)
      .handler(({ input }) => {
        const planet = { id: planets.length + 1, name: input.name };
        planets.push(planet);
        return planet;
      }),
  },

  clock: {
    ticks: base.output(asyncIteratorObject(z.object({ n: z.number() }))).handler(async function* ({
      signal,
    }) {
      for (let n = 1; !signal?.aborted; n++) {
        yield { n };
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }),
  },
};
