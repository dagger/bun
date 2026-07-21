# Bun module for Dagger

A [Dagger](https://dagger.io) module for [Bun](https://bun.com) — the all-in-one
JavaScript & TypeScript runtime, package manager, bundler, and test runner.

It models a Bun project as a typed object graph and maps Bun's toolchain onto
Dagger's first-class verbs, rather than wrapping the `bun` CLI. Bun ships no
linter, formatter, or typechecker (it transpiles TypeScript by *stripping*
types), so this module implements the verbs Bun actually owns — **test, audit,
and frozen-lockfile install** — plus build and container primitives, and leaves
lint/format/typecheck to specialized modules (see [below](#what-bun-doesnt-do)).

Design rationale: [`design/bun-module.md`](design/bun-module.md).

## Why use this over the `bun` CLI

- **Pinned toolchain** — one `version` drives the base image and the `install`
  primitive, so local and CI run the exact same `bun`.
- **Checks, surfaced individually** — `bun test`, `bun audit`, and frozen-lockfile
  install become named checks that `dagger check` runs and reports separately.
- **Warm cache** — `~/.bun/install/cache` is a `cacheVolume`; installs stay fast
  across runs without leaking into the source tree.
- **Hermetic binaries** — `compile` cross-compiles standalone executables with no
  local Bun install.
- **Composable images** — `install(ctr)` layers the pinned `bun` into any base;
  `installed(ws)` hands back a container with `node_modules` materialized.

## Object graph

| Object | What it is |
|---|---|
| `Bun` | The pinned toolchain: `version`, `base`, `install`, and project discovery. |
| `BunProject` | A single project (a directory with a `package.json`), plus its install root. |

`Bun` reaches projects two ways: `projects` (cwd-aware discovery — the nearest
enclosing project plus every project at or below the current directory, per
[dagger/dagger#13688](https://github.com/dagger/dagger/issues/13688)) and
`project --path <p>` (resolve the project containing a path, snapping up to its
root by default). Running the workspace-wide verbs from a subdirectory acts on the
project you're in, not the whole workspace.

Discovery keys on `package.json` and its `workspaces` field, so a **monorepo's
members are enumerated individually** (a Bun workspace has one root `bun.lock`, so
keying on the lockfile would only find the root). Each member runs at its
workspace root, so hoisted deps and `workspace:*` cross-deps resolve; standalone
and independent projects work unchanged.

## Checks (`dagger check`)

Per project (`Bun.project` → `BunProject`):

- `test` — `bun test`
- `audit` — `bun audit` (`--level` sets the minimum severity)
- `install-check` — `bun install --frozen-lockfile` (a stale lockfile fails CI)

Workspace-wide, fanning out over every discovered project:

- `test-all`, `audit-all`, `install-check-all`

## Build (plain functions)

Build artifacts are outputs, not checks — they return files/dirs you export or
ship:

- `bundle` → `Directory!` — `bun build` into an output dir
- `compile` → `File!` — `bun build --compile`; `--target` cross-compiles
  (e.g. `bun-linux-x64`, `bun-linux-arm64-musl`, `bun-windows-x64`)

`bundle`/`compile` default their entrypoint to `package.json`'s `main`.

## Toolchain primitives

- `base` → `Container!` — `oven/bun:<version>-alpine` with the cache wired up.
- `install(ctr, musl)` → `Container!` — copy the pinned `bun` binary into any
  container. Copies the glibc build by default; pass `--musl` for an alpine/musl
  target. The target must carry a C++ runtime (`libstdc++`/`libgcc_s`).
- `BunProject.container` / `installed` → `Container!` — the source mounted, before
  and after `bun install`, for composing custom pipelines.

## Configuration

Constructor arguments on the root object:

- `--version` (default `1.3.14`) — pinned Bun version; matches an `oven/bun`
  image tag.
- `--base` — override the base container (must have `bun` on `PATH`, or run it
  through `install` first).

Operation flags live on the function that uses them (`audit --level`,
`compile --target/--entrypoint/--output-name`, `bundle --entrypoint/--outdir`).

## Usage

> This module targets Dagger engine `v1.0.0-beta.7`. Until that release is your
> default, prefix commands with `dagger --x-release=v1.0.0-beta.7`.

Run all checks:

```console
dagger check
```

Call individual functions:

```console
# Toolchain version
dagger call version

# Test / audit / lockfile-check a project (ws is the current workspace)
dagger call project --path ./app test
dagger call project --path ./app audit --level high
dagger call project --path ./app install-check

# Build artifacts
dagger call project --path ./app bundle export --path ./dist
dagger call project --path ./app compile --target bun-linux-x64 export --path ./app-bin

# Layer bun into your own image
dagger call install --ctr debian:stable-slim
```

### As a dependency

Add it to your module's `dagger-module.toml`:

```toml
[[dependencies]]
  name = "bun"
  source = "github.com/dagger/bun"
```

Then compose it — Bun owns test/audit/build; you add the checks Bun lacks and
build your image:

```dang
type MyApp {
  "Reuse Bun's native test check."
  pub test(ws: Workspace!): Void @check {
    bun().project(ws, ".").test(ws)
  }

  "Lint via a dedicated Biome module (Bun has no linter)."
  pub lint(ws: Workspace!): Void @check {
    biome().project(ws, ".").lint(ws)
  }

  "Ship a distroless image built from Bun's primitives."
  pub image(ws: Workspace!): Container! {
    bun().install(container.from("gcr.io/distroless/cc"))
      .withDirectory("/app", bun().project(ws, ".").installed(ws).directory("/src"))
  }
}
```

## What Bun doesn't do

Bun is a runtime, package manager, bundler, and test runner — **not** a linter,
formatter, or typechecker. Rather than fake those, compose specialized modules:

| Need | Use |
|---|---|
| Lint | [Biome](https://biomejs.dev), [oxlint](https://oxc.rs), or ESLint |
| Format | [Biome](https://biomejs.dev), [Prettier](https://prettier.io), or [dprint](https://dprint.dev) |
| Typecheck | `tsc --noEmit` (a TypeScript module) — Bun only strips types |

Dependency mutations (`bun add`/`remove`/`update`) and dev servers are also *not*
modeled: they are parameterized/non-idempotent or un-guessable, so they don't map
to `dagger generate`/`dagger up`. See the [design doc](design/bun-module.md) for
the reasoning.

## Development

End-to-end checks live in `.dagger/modules/e2e`: they install this module as a
dependency and drive it against the fixture under
`.dagger/modules/e2e/modules/hello` (plus in-memory workspaces for failure
paths). Run them with `dagger check`.
