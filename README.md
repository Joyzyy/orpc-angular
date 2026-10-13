# orpc-angular

Angular integration for [oRPC](https://orpc.dev), built on `resource()` and signals: queries,
mutations, infinite lists, streams, a tag cache and SSR TransferState.

```ts
readonly planet = orpcResource(this.orpc.planet.find, { input: () => ({ id: this.id() }) });
readonly create = orpcMutation(this.orpc.planet.create, { invalidate: () => ['planets'] });
```

For TanStack Query, use [`@orpc/tanstack-query`](https://orpc.dev/docs/integrations/tanstack-query)
instead.

## Installation

```sh
pnpm add orpc-angular @orpc/client
```

Angular >= 22, `@orpc/client` >= 2.0.0-beta.40.

## Setup

```ts
// app.config.ts
export const appConfig: ApplicationConfig = {
  providers: [provideORPC()],
};

// orpc.ts
export const ORPC = new InjectionToken<RouterClient<typeof router, ORPCAngularContext>>('ORPC', {
  factory: () =>
    createORPCClient(
      new RPCLink({
        origin: 'http://localhost:3000',
        url: '/rpc',
        method: (_options, path) => (/^(get|find|list)/.test(path.at(-1) ?? '') ? 'GET' : 'POST'),
        plugins: [new ORPCAngularLinkPlugin()],
      }),
    ),
});
```

Create the client inside DI, not at module scope: with SSR, a module-scoped client shares its
cache between requests.

Caching, dedupe and TransferState apply to GET requests only. `RPCHandler` rejects GET unless
you allow it:

```ts
new RPCHandler(router, {
  allowMethods: ['GET', 'POST'],
  plugins: [new GetMethodCsrfProtectionHandlerPlugin()],
});
```

`OpenAPILink` works the same way, with methods taken from your routes.

| Option                                            | Default  |
| ------------------------------------------------- | -------- |
| `provideORPC({ maxCacheEntries })`                | `100`    |
| `ORPCAngularLinkPlugin({ sharedRequestTimeout })` | `30_000` |

## Queries

```ts
readonly planet = orpcResource(this.orpc.planet.find, {
  input: () => ({ id: this.id() }),
  context: { cache: { tags: ['planets'] } },
});
```

```html
@if (planet.hasValue()) {
<h1>{{ planet.value().name }}</h1>
} @else if (planet.error(); as error) {
<p>{{ error.message }}</p>
}
```

| Option    |                                                                       |
| --------- | --------------------------------------------------------------------- |
| `input`   | `undefined` idles the resource                                        |
| `when`    | `false` idles the resource                                            |
| `context` | read once per load; `cache.tags` reloads it when a tag is invalidated |
| `id`      | unique key that hydrates the value from SSR                           |

`defaultValue`, `equal`, `injector` and `debugName` go to `resource()`.

`value()` throws in the error state. `resilientORPCResource` keeps the last value while
reloading, and on error with `keepValueOnError`. `mergeResources({ a, b })` combines several
resources into one.

## Infinite lists

```ts
readonly planets = orpcInfiniteResource(this.orpc.planet.list, {
  input: ({ offset, limit }) => ({ offset, limit, search: this.search() }),
  pageSize: 20,
  items: (page) => page.items,
  context: { cache: { tags: ['planets'] } },
});
```

Returns `items()`, `pages()`, `hasMore()`, `isInitialLoading()`, `isLoadingMore()`,
`error()`, `loadMore(count?)` and `reload()`. A tag invalidation refetches all loaded rows in
one request.

## Streams

```ts
readonly messages = orpcStreamResource(this.orpc.chat.messages, {
  input: () => ({ room: this.room() }),
  defaultValue: [] as Message[],
  accumulate: (all, message) => [...all, message],
});
```

Without `accumulate`, the value is the latest event. Streams don't run during SSR. Reconnects
are configured on the link with `RetryLinkPlugin`. For side effects only, use
`consumeStream({ open, onEvent, onFatal })`.

## Mutations

```ts
readonly create = orpcMutation(this.orpc.planet.create, {
  invalidate: () => ['planets'],
  onSuccess: (planet) => this.router.navigate(['/planets', planet.id]),
});

const { error, data } = await this.create.mutate({ name });
```

`mutate()` resolves to a `SafeResult` and doesn't throw. The ref exposes `status()`,
`isPending()`, `value()`, `error()` and `pending(key)`.

| Option                 |                                                    |
| ---------------------- | -------------------------------------------------- |
| `invalidate`           | tags to invalidate on success                      |
| `onMutate`             | runs before the call; returns the callback context |
| `onSuccess`, `onError` | `(result, input, context)`                         |
| `key`                  | per-input key for `pending(key)`                   |
| `input`                | reactive input that triggers a mutation            |

## Invalidation

```ts
const cache = inject(ORPCCache);

cache.invalidate('planets');
cache.invalidateAll();
cache.clear(); // no reload, e.g. on sign-out
```

`pollTags(['planets'], 30_000)` invalidates on an interval while the page is visible.

## Calling clients

The client is a regular oRPC client. Pass the context to cache an imperative call:

```ts
await this.orpc.planet.find({ id: 1 }, { context: { cache: { tags: ['planets'] } } });
```

`dedupe: true` joins concurrent identical GETs without caching them.

## SSR

On the server, successful GET responses are embedded in `TransferState`. The browser replays
them until the app is stable. Responses with `set-cookie` or
`cache-control: no-store | no-cache | private` are not embedded.

## Errors

`error()` is typed from the procedure:

```ts
const error = this.planet.error();
if (isDefinedError(error) && error.code === 'NOT_FOUND') {
  error.data;
}
```

## License

MIT
