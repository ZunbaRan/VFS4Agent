# JSONPlaceholder Provider

A working `VfsProvider` backed by https://jsonplaceholder.typicode.com — use
this as a template for your own Providers.

## What it exposes

```
/<mountPrefix>/
  users.md              # index of all users
  users/
    <id>.md             # single user profile
    <id>/
      posts.md          # posts by that user
  posts/<id>.md
  todos/<id>.md
```

## Register it

In `vfs.config.yaml`:

```yaml
providers:
  - name: jsonplaceholder
    mountPrefix: /api
    driver: ./examples/providers/jsonplaceholder/provider.ts
    config:
      baseUrl: https://jsonplaceholder.typicode.com
```

Then:

```
VFS_CONFIG=./vfs.config.yaml pnpm server
```

Inside the mount, your Agent sees:

```
ls /vfs/api/         # users.md  users/  posts/  todos/
cat /vfs/api/users/1.md
grep -r oauth /vfs/api/posts/   # calls provider.search()
```

## Authoring a Provider

Minimum contract — 5 methods (last two optional):

```ts
import { defineProvider, VfsError } from "vfs4agent/provider";

export default defineProvider({
  name: "my-provider",
  mountPrefix: "/my",

  async readdir(subpath, ctx) { /* DirEntry[] */ },
  async read(subpath, ctx)    { /* { content, mime? } */ },
  async stat(subpath, ctx)    { /* { type, size, mtime } */ },

  // Optional — return `null` to fall back to router scan
  async search(req, ctx)      { /* SearchHit[] | null */ },
  async close()               { /* graceful shutdown */ },
});
```

Throw `new VfsError("ENOENT", path)` for missing paths. The router will
translate to the right FUSE errno for you.

## Local dev without FUSE

Providers are pure TypeScript — you can exercise them directly in unit tests
(see `provider.test.ts`). `MountRouter` is equally easy to instantiate without
FUSE, which means you can iterate on a Provider without ever booting the
kernel mount.
