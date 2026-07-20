# Design: `dagger/bun` — a Dagger module for Bun projects

Status: **design only** — nothing implemented yet. Modeled on
[`dagger/deno`](https://github.com/dagger/deno) and the
[Dang module manual](https://github.com/dagger/go/blob/main/DANG_MODULE_DEVELOPER_MANUAL.md).
Written for a reader already familiar with Dagger and the
[toolchain-module playbook](https://gist.github.com/TomChv/82e7cae5374ef37d42643e13fce9e485).

---

## 1. Goals & non-goals

**Goal.** Make Bun's toolchain usable *as Dagger verbs* — pinned, reproducible,
and composable — not a shell over the `bun` CLI. A user gets the same test /
audit / lockfile checks locally and in CI, a warm install cache, hermetic
cross-compiled binaries, and an `install(ctr)` primitive to build app images.

**Non-goal.** Wrapping every subcommand. Bun is a runtime + package manager +
bundler + test runner. It is **not** a linter, formatter, or typechecker
(see §3). This module models the fixed verbs Bun actually owns and *delegates*
the rest to specialized modules rather than faking them.

The honest consequence: this module ships **checks + build primitives + install
primitives, zero `@generate`, and zero `@up`**. That is a legitimate shape — the
playbook's "offer a real entry point, don't force a bad fit" applies to all
three verbs, not just `@up`.

---

## 2. Why use this over the `bun` CLI

- **Pinned toolchain.** One `version` drives the base image and the `install`
  primitive, so local and CI run the exact same `bun`.
- **Checks, surfaced individually.** `bun test`, `bun audit`, and frozen-lockfile
  install become named `@check`s that `dagger check` runs and reports separately.
- **Warm cache.** `~/.bun/install/cache` is a `cacheVolume`; installs stay fast
  across runs without leaking into the source tree.
- **Hermetic binaries.** `compile` cross-compiles standalone executables
  (`bun build --compile --target …`) with no local Bun install.
- **Composable image building.** `install(ctr)` layers the pinned `bun` into any
  base (alpine, distroless, an app image); `installed(ws)` hands back a container
  with `node_modules` materialized.
- **Fills its own gaps.** Lint/format/typecheck are delegated to real modules
  (§3), so you get a coherent CI without pretending Bun does things it doesn't.

---

## 3. Bun → Dagger mapping

| Bun action | Native to Bun? | Dagger treatment | Field |
|---|---|---|---|
| `bun test` | yes | `dagger check` | `test` `@check` |
| `bun audit` | yes | `dagger check` | `audit` `@check` |
| `bun install --frozen-lockfile` | yes | `dagger check` | `installCheck` `@check` |
| `bun build` (bundle) | yes | build artifact → plain fn | `bundle: Directory!` |
| `bun build --compile` | yes | build artifact → plain fn | `compile: File!` |
| install the `bun` binary | — | composable primitive | `install(ctr, musl): Container!` |
| **lint** | **no** | **delegate** | Biome / oxlint / ESLint module |
| **format** | **no** | **delegate** | Biome / Prettier / dprint module |
| **typecheck** | **no** | **delegate** | `tsc` / TypeScript module (`tsc --noEmit`) |
| `bun add` / `remove` / `update` | yes | not a verb (see §8) | omitted |
| `bun run <script>` / dev server | yes | not a verb (see §8) | omitted |

### What Bun does *not* provide — and where to get it

Bun transpiles TypeScript by **stripping types**; it never type-checks, and it
ships no linter or formatter. Per the prompt's rule, we don't invent a `lint` /
`format` / `typeCheck` here. Instead these are separate Dagger modules a
downstream project composes alongside `bun` (§7):

- **Lint** — [Biome](https://biomejs.dev), [oxlint](https://oxc.rs), or ESLint.
- **Format** — [Biome](https://biomejs.dev), [Prettier](https://prettier.io),
  or [dprint](https://dprint.dev).
- **Typecheck** — `tsc --noEmit` from the TypeScript package (a `dagger/tsc`-style
  module). In practice teams run `bunx tsc --noEmit`; that's a `tsc` concern, not
  a Bun verb.

Biome is the natural pairing: one binary covers lint **and** format, mirroring
Bun's own all-in-one philosophy.

### Why no `@generate`

`dagger generate` runs **every** `@generate` with its defaults. Bun has no no-arg
idempotent normalization to offer:

- No formatter and no schema codegen → nothing to normalize.
- Lockfile sync (`bun install` writing `bun.lock`) resolves against the live
  registry and edits dependencies — a deliberate mutation, not a formatter. The
  playbook explicitly excludes dependency edits from `@generate`. We guard the
  committed lockfile with `installCheck` instead, and leave the *write* to the
  developer's local `bun install`.

### Why no `@up`

`dagger up` starts **every** `@up` with its defaults. An arbitrary Bun project's
server entrypoint, port, and permissions can't be guessed (`bun run dev` is a
user-defined script; the 1.3 zero-config dev server needs a chosen HTML
entrypoint). A made-up server would boot on every `dagger up`. So the base module
exposes `installed(ws)` / `container(ws)` and lets a **downstream module that
knows its entrypoint** add a one-line `@up` on top (§7).

---

## 4. Domain object graph

Two objects; discovery and lookup are the only entry points into the child.

```
Bun ──projects(ws)──▶ [BunProject]      # discover: one per package.json (members expanded)
    ──project(ws,path)▶ BunProject       # lookup: snap a path to its project
```

`BunProject` cascades inputs into derived, lazily-computed containers — every
node answers a question a user might ask:

```
source(ws) ──▶ container(ws) ──▶ installed(ws) ──▶ test / audit / bundle / compile
                             └──▶ installCheck        (frozen install, own exec)
```

- `source` — the project's own pruned tree (no `.git`, no `node_modules`).
- `container` — base image with the **install root** mounted + warm install cache.
- `installed` — `container` after `bun install` at the install root; `node_modules`
  present (hoisted to the workspace root for a member). Bun (unlike Deno) uses
  `node_modules`, so checks and builds run on `installed`, in the member's workdir.
- checks/builds read from there; each takes `ws` explicitly so cache
  invalidation stays visible at the call site.

**Project identity.** A project is a directory with a `package.json`.
`project(ws, path, findUp: true)` walks up from `path` to the nearest one. Each
`BunProject` carries an `installRoot`: for a **workspace member** it is the
enclosing workspace root (where the single `bun.lock` lives and `bun install`
runs, so hoisted deps and `workspace:*` links resolve); for a standalone project
it is the project itself. The lockfile marks the *install root*, not a project —
a workspace has one lockfile but many projects, so discovery keys on `package.json`.

**Discovery is cwd-aware** ([dagger/dagger#13688](https://github.com/dagger/dagger/issues/13688)),
via [`dagger/polyfill`](https://github.com/dagger/polyfill)'s
`findConfigDirs(["package.json"], exclude: ["**/node_modules/**"])` — the reusable
implementation of the issue: the nearest enclosing dir (find-up, 0–1) unioned with
every one at or below the cwd (walk-down, 0–N), as cwd-relative paths.

Two Bun-specific steps sit on top, both keyed on the `package.json` `workspaces`
field (authoritative, and independent of whether a lockfile is committed).
*Classification:* a directory whose `package.json` declares a `workspaces` array is
a **workspace root** — an install boundary, not a project — so it is dropped, while
its members (their own package.json dirs, surfaced by the same walk-down) stay.
*Install root:* a project installs at its nearest enclosing workspace root (a member
→ that root, so hoisted deps and `workspace:*` resolve; a standalone/independent
project → itself). We key this on `workspaces`, **not `bun.lock`**, on purpose: a
lockfile can be gitignored or simply not committed yet, in which case anchoring on it
would make a member install in place and `workspace:*` break — whereas `bun install`
at the workspace root generates the lock and resolves cross-deps regardless. This
also avoids the over-expansion trap: from a monorepo subdirectory you get only the
members beneath it, because find-up returns the enclosing workspace root (which is
dropped) rather than its whole member list. A nearer project shadows a farther-up
one, and siblings are never scanned. (We don't inherit Deno's ancestor *exclusion* —
that keeps a `format` changeset from spanning above the caller, and Bun has no
changeset verb.)

**Scope.** Single projects, multiple *independent* projects, and **Bun workspaces**
(root `package.json` `workspaces`, one root `bun.lock`, `workspace:*` cross-deps)
are all handled. Only the array form of `workspaces` is read (not npm's
`{ "packages": [...] }` object form).

---

## 5. Configuration & flexibility

The root type's public fields *are* the generated `bun(...)` constructor args, so
only real inputs live there:

- `version: String!` — pinned Bun version (default `1.3.14`, the current
  stable); drives the base image tag and the `install` binary source.
  Non-null-with-default → optional to callers, no null-checks in the body.
- `base: Container!` — overridable base image, default derived from `version`
  (`oven/bun:<version>-alpine`). One unambiguous BYO-image point; no second
  `baseImageAddress` arg.

Operation flags are scoped to the function that uses them, not the constructor —
e.g. `install(musl:)`, `audit(level:)`, `compile(target:, entrypoint:,
outputName:)`, `bundle(entrypoint:, outdir:)`.

Caching and the binary-copy details stay private (inside `container` / `install`),
not exposed as public knobs. No `include`/`exclude` selection patterns until a
real monorepo scoping need appears — Bun's project tree is plain.

---

## 6. Public API — GraphQL

```graphql
"""
Bun toolchain: a pinned `bun` binary, install/base container primitives,
and discovery of the Bun projects in a workspace.
"""
type Bun {
  "Pinned Bun version; matches an `oven/bun:<version>` image tag."
  version: String! = "1.3.14"

  "Ready-to-use base container: `oven/bun:<version>-alpine` with the cache wired up."
  base: Container!

  """
  Install the pinned `bun` binary into any container and return it.
  Set `musl: true` for a musl target (alpine); the default copies the glibc build.
  """
  install(ctr: Container!, musl: Boolean! = false): Container!

  "Discover the Bun projects from the current location: nearest enclosing (find-up) + those at or below (walk-down)."
  projects(ws: Workspace!): [BunProject!]!

  "Resolve the Bun project that contains `path` (snaps to the lockfile root)."
  project(ws: Workspace!, path: String!, findUp: Boolean! = true): BunProject!

  "Run every project's test suite."
  testAll(ws: Workspace!): Void @check

  "Audit every project's dependencies for known vulnerabilities."
  auditAll(ws: Workspace!): Void @check

  "Verify every project installs cleanly against its frozen lockfile."
  installCheckAll(ws: Workspace!): Void @check
}
```

```graphql
"""
A single Bun project, identified by the directory holding its lockfile and
`package.json`. Every operation reads files through the workspace so cache
invalidation stays visible at the call site.
"""
type BunProject {
  "Project root, relative to the workspace."
  path: String!

  "The project manifest (`package.json`)."
  config(ws: Workspace!): File!

  "Pruned project source (excludes `.git` and `node_modules`)."
  source(ws: Workspace!): Directory!

  "Base container with the source mounted and the install cache warm."
  container(ws: Workspace!): Container!

  "`container` after `bun install` — `node_modules` materialized. The base for checks/builds."
  installed(ws: Workspace!): Container!

  "Run the test suite (`bun test`)."
  test(ws: Workspace!): Void @check

  "Audit dependencies for known vulnerabilities (`bun audit`). `level` = min severity."
  audit(ws: Workspace!, level: String = null): Void @check

  "Verify the lockfile is in sync and installable (`bun install --frozen-lockfile`)."
  installCheck(ws: Workspace!): Void @check

  "Bundle the project (`bun build`). `entrypoint` defaults to `package.json` `main`."
  bundle(
    ws: Workspace!,
    entrypoint: String = null,
    outdir: String! = "dist",
  ): Directory!

  "Compile a standalone executable (`bun build --compile`); `target` cross-compiles."
  compile(
    ws: Workspace!,
    entrypoint: String = null,
    outputName: String! = "app",
    target: String = null,
  ): File!
}
```

Notes on the SDL:
- `@check` fields return `Void` (body ends in `null`; Dagger uses the exit code).
  Many small checks over one mega-check, so they surface individually.
- No `@generate` / `@up` fields, by the reasoning in §3.
- `install` / `base` are the composable primitives; `container` / `installed` /
  `config` / `source` are causal-introspection surfaces for downstream and agents.

---

## 7. Implementation notes

Each field maps to one hermetic exec; there is no clever native helper — Bun's
project layout is a plain source tree, so Dang handles all of it (the manual's
"native API reality check").

| Field | Runs |
|---|---|
| `Bun.base` | `container.from("oven/bun:" + version + "-alpine")`, `BUN_INSTALL_CACHE_DIR=/bun-cache` |
| `Bun.install(ctr, musl)` | copy the binary from the libc-matching image — `oven/bun:<version>` (glibc, default) or `oven/bun:<version>-alpine` (musl) — with `ctr.withFile("/usr/local/bin/bun", …file("/usr/local/bin/bun"))`. Hermetic, not a re-run of the install script. |
| `container(ws)` | `base` + `withMountedCache("/bun-cache", cacheVolume("bun-cache"))` + `withWorkdir("/src")` + `withDirectory("/src", source(ws))` |
| `installed(ws)` | `container(ws).withExec(["bun", "install"])` |
| `test` | `installed(ws).withExec(["bun", "test"]).sync; null` |
| `audit` | `installed(ws).withExec(["bun", "audit"] + levelFlag).sync; null` |
| `installCheck` | `container(ws).withExec(["bun", "install", "--frozen-lockfile"]).sync; null` |
| `bundle` | `installed(ws).withExec(["bun","build",entry,"--outdir",outdir]).directory(outdir)` |
| `compile` | `installed(ws).withExec(["bun","build","--compile"] + targetFlag + ["--outfile", out, entry]).file(out)` |

- **Binary path / libc** (verified against `oven/bun:1.3.14-alpine`): `bun` is a
  real ~87 MB file at `/usr/local/bin/bun`. The alpine build is **musl**-linked
  and dynamically needs `libstdc++`/`libgcc_s`, so it is *not* portable to a
  glibc base — hence `install(musl:)` picks the matching image, and the target
  must carry a C++ runtime (verify against `cc`/distroless bases).
- **Entrypoint default:** when `entrypoint` is null, decode `package.json` with
  `JSON.decode` and use its `main` field, falling back to `index.ts` — no native
  helper needed (`package.json` is strict JSON).
- `compile` targets are Bun's own (`bun-linux-x64`, `bun-linux-arm64`,
  `bun-darwin-arm64`, `bun-windows-x64`, `…-musl` variants) — no Docker needed
  for cross-compilation.

---

## 8. Not modeled (by design)

These are deliberately *not* verbs and not in the object graph:

- **`bun add` / `remove` / `update`** — parameterized, non-idempotent dependency
  mutations. No sensible auto-run default; you don't want a dep edit firing on
  every `dagger generate`. If ever needed, a separate management module — not
  here.
- **`bun run <script>` / dev server** — arbitrary user tasks have no stable shape,
  and a project that has one already has its tooling locally. Downstream composes
  directly on `installed(ws)` instead of a `run` wrapper. Servers get a
  downstream `@up` (see below).
- **`bun outdated`** — informational and network/time-dependent; not a check
  (no committed state to guard). Could be a plain fn returning JSON later if a
  real need appears.

---

## 9. Extendability

Install as a dependency and compose. Bun owns test/audit/build; specialized
modules own lint/format/typecheck; a project stitches them together. Example
downstream surface (SDL) for a Bun app that adds the missing checks and ships an
image:

```graphql
type MyApp {
  "Lint via a dedicated Biome module (Bun has no linter)."
  lint(ws: Workspace!): Void @check      # biome().project(ws, ".").lint(ws)

  "Typecheck via a dedicated tsc module (Bun only strips types)."
  typeCheck(ws: Workspace!): Void @check # tsc().project(ws, ".").check(ws)

  "Reuse Bun's native check as-is."
  test(ws: Workspace!): Void @check      # bun().project(ws, ".").test(ws)

  "Build a distroless app image from Bun's primitives."
  image(ws: Workspace!): Container!      # bun().install(from distroless) + installed(ws) output

  "Downstream knows its entrypoint, so it can add the @up the base module can't."
  serve(ws: Workspace!, port: Int! = 3000): Service! @up
}
```

Good-base properties this design provides:
- **Rich child objects** — `BunProject` carries its own verbs.
- **Composable primitives** — `install(ctr)`, `base`, plus `installed(ws)` /
  `container(ws)` for image building.
- **Causal introspection** — `config`, `source`, and the exact container a check
  will run in, so consumers and agents can debug selection and commands.

---

## 10. Decisions

Resolved:

- **Default `version` → `1.3.14`** (current stable), tracked forward on release.
- **Binary path → `/usr/local/bin/bun`** (verified). `install` copies the
  libc-matching build via `install(musl:)`; the alpine binary is musl-linked and
  needs `libstdc++`/`libgcc_s`, so glibc is the default and the target must carry
  a C++ runtime.
- **`audit` stays a `@check`.** It queries the registry, so results drift as new
  CVEs land — the one check that depends on external, time-varying state, which is
  inherent to auditing and fine. `level` narrows severity; a `--prod` flag can be
  added later if asked for.
- **Workspaces are supported.** Discovery keys on `package.json` + its
  `workspaces` array (not the lockfile), so a monorepo's members are enumerated
  and each runs at its workspace root (`workspace:*` resolves). Only the array
  form of `workspaces` is read, not npm's `{ "packages": [...] }` object form.
- **`test` uses `--pass-with-no-tests`** so a member/project with no test files
  passes instead of erroring (`bun test` exits non-zero on "no tests found").
- **`bundle`/`compile` entrypoint** defaults from `package.json` `module`/`main`
  (decoded via `JSON.decode`; falls back to `index.ts`), not a hardcoded guess.
- **`test` runs on `installed(ws)`** (post-`bun install`) so test-time imports
  resolve; `--frozen-lockfile` stays out of `test` — that is `installCheck`'s job.

To verify at implementation time:

- Exact `oven/bun` tag variants available for the pinned version (`-alpine`,
  glibc default, and any `-distroless`/`-slim` used as `install` targets) and
  that `install(musl:)` binaries run on those bases.
```
