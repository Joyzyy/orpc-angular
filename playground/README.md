# playground

Angular 22 SSR app and an oRPC router on the same Express server, consuming the packed
`orpc-angular` tarball, so it exercises what npm would ship.

```sh
pnpm lib       # build + pack the library, reinstall it here
pnpm build
PORT=4000 pnpm serve
pnpm e2e       # playwright against http://localhost:4000 (BASE_URL to override)
```

`src/api/router.ts` is the oRPC router; `/debug/hits` counts server-side calls per procedure.
`e2e.mjs` checks SSR + hydration without refetch (resource `id` and the link's TransferState),
infinite pagination, typed errors, mutation invalidation, the tag cache and a live stream.
