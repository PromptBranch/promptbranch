# AGENTS.md — PromptBranch

Guidance for AI coding agents working in this repository. Assumes no prior
knowledge of the project.

## Project overview

PromptBranch is a cross-platform (macOS-first), local-first desktop app for
managing, versioning and evolving AI prompts — part prompt library, part
version-control system. The product and all pnpm workspace packages use the
unified **`@promptbranch/*`** namespace (`@promptbranch/core`,
`@promptbranch/ai`, `@promptbranch/share`, `@promptbranch/mcp`,
`@promptbranch/cli`, `@promptbranch/desktop`).

Key features:

- Prompt CRUD with soft delete, branches, and append-only per-branch
  sequential versions (with change notes and a "current" pointer).
- Tags, collections, starred prompts, filters/sort, FTS5 search (⌘K), History
  and Notes tabs, JSON import/export, automatic local backups.
- Evaluation: 1–5 four-dimension ratings, a run log (Results tab), diff
  view for any two versions, "duplicate as variation" branching.
- Agent integration (see below): a CLI and an MCP server over the same core;
  agents propose, humans approve.
- AI integration: a models.dev-backed provider catalog (OpenAI, Anthropic,
  Google, OpenAI-compatible endpoints) with safeStorage-encrypted API keys,
  streaming multi-model runs (up to 6 models concurrently) with token/cost
  tracking, an LLM judge, side-by-side run compare and an evaluation summary.
- Link-based sharing: the desktop app and CLI publish immutable prompt
  snapshots to a self-hosted portal (hosted in the companion
  `promptbranch-portal` repository) behind unguessable URLs, with a
  pre-publish secret scan, `promptbranch://import` deep links, local delete
  tokens for revoking shares, and a Shares view in the desktop app (search,
  status filtering, revoke) for managing them.
- Multi-device sync: peer-to-peer over the local network (no server, no
  accounts). Devices pair via a short code verified against a self-signed
  certificate fingerprint, discover each other via mDNS, and exchange
  incremental record-level ops over mutually-pinned TLS with deterministic
  merges (HLC last-writer-wins; append-only rows union).

The root `README.md` and everything under `docs/` are **user-facing product
documentation** (installation, setup, configuration, usage, supported
features, troubleshooting). They must never reference internal development
material: this file, `docs-internal/`, the private `promptbranch-portal`
repository, portal self-hosting/deployment, or dev-only workflows (CI,
signing, packaging internals). The architecture description lives in this
file. User-facing docs live in `docs/` (see `docs/SUMMARY.md`); design specs
and implementation plans live in `docs-internal/` (`specs/`, `plans/`).

## Architecture & Repositories (2-Repo Architecture)

The system is split into two repositories:

1. **`promptbranch` (this repository)** — The client, agent, and core domain monorepo:
   - `apps/desktop` — Electron + React desktop application (`@promptbranch/desktop`)
   - `apps/cli` — `promptbranch` CLI (`@promptbranch/cli`, runnable via `npx @promptbranch/cli`)
   - `packages/core` — SQLite database, migrations, sync engine (`@promptbranch/core`)
   - `packages/ai` — Multi-model runner and LLM judge (`@promptbranch/ai`)
   - `packages/mcp` — MCP stdio server (`@promptbranch/mcp`, runnable via `npx -y @promptbranch/mcp`)
   - `packages/share` — Sharing contract, schemas, secret scanner (`@promptbranch/share`)
2. **`promptbranch-portal` (companion private repository)** — The self-hosted web sharing service:
   - `apps/portal` — Next.js SSR viewer and JSON API
   - `deploy/portal` — Production Docker Compose, Nginx Proxy Manager, and host-hardening policies
   - `packages/share` — Local workspace mirror of the sharing contract

Git remotes: `origin` has dual push URLs (internal Gitea
`http://git.exploit.co.il/...` and GitHub `git@github.com:PromptBranch/promptbranch.git`)
to keep both synchronized; `github` points at GitHub only.

Package responsibilities:

- `packages/core` owns **all** domain logic. SQLite via `better-sqlite3`
  (plain SQL, **no ORM**), with a versioned forward-only migration runner
  (`user_version` pragma, automatic pre-migration backup for on-disk
  databases). Also: prompts/versions/branches/notes/tags/collections/ratings/
  runs/shared-snapshot records, FTS5 search (porter tokenizer, bm25 ranking,
  prefix queries), lossless JSON export/import with id remapping on
  collisions, and `resolveDatabasePath()` for the shared DB path. Main entry
  points: `src/library.ts` (`PromptLibrary`), `src/db.ts`,
  `src/migrations.ts`, `src/schema.ts`, `src/resolve.ts`. The
  transport-agnostic sync engine lives in `src/sync/` (`engine.ts` =
  refine/apply/serve, `hlc.ts` = hybrid logical clock, `tables.ts` = the
  synced-table registry that also generates migration v6's dirty-capture
  triggers); zero Electron deps, zero runtime dependencies beyond
  `better-sqlite3`.
- `packages/ai` is a zero-Electron LLM layer over the Vercel AI SDK: provider
  registry (one entry per provider; a provider's `type` is its models.dev
  catalog id, its `driver` picks execution — openai/anthropic/google natively,
  everything else through `@ai-sdk/openai-compatible`), models.dev catalog
  fetching/parsing (the package deliberately does not cache — callers own
  persistence/staleness, so the app stores it in the settings table), prompt
  execution and cost estimation, AI prompt assist (`src/assist.ts`) and the
  LLM judge (`src/judge.ts`, `src/judge-average.ts`).
- `apps/desktop` is a thin Electron shell:
  - `src/main/` — main process (`index.ts`, `ai.ts`, `share.ts`,
    `deep-link.ts`); exposes `packages/core` and `packages/ai` over a
    **Zod-validated typed IPC** surface (`src/shared/ipc.ts` +
    `src/shared/channels.ts`); `{{variable}}` substitution happens here
    before each run; API keys are encrypted with Electron `safeStorage` and
    only decrypted inside the main process. `src/main/sync/` is the P2P
    transport: `identity.ts` (self-signed cert, fingerprint-derived pairing
    code), `frames.ts`/`messages.ts` (wire protocol), `session.ts`
    (hello-driven anti-entropy over any Duplex), `pairing.ts`,
    `peers-service.ts` (pinned-TLS listener, mDNS via `bonjour-service`,
    reconnect backoff) and `service.ts` (`DesktopSync` coordinator bridging
    to IPC/renderer events).
  - `src/preload/` — `contextBridge` wrapper implementing the typed
    `PromptBuilderApi` (the `window.promptBuilder` name is a deliberate
    pre-rename leftover; keep it).
  - `src/renderer/` — React 19 + Tailwind v4 + Radix UI + CodeMirror 6 +
    TanStack Query. Pure UI; renderer code must never touch Node/Electron APIs
    directly — go through the preload API (`window.promptBuilder` bridge,
    mocked in tests via `src/renderer/src/test/mock-bridge.ts`).
- `apps/cli` (`src/index.ts`, single file) — the MCP tool surface for shell
  pipelines, plus human-only `publish`/`import` sharing commands (MCP is
  deliberately unchanged). Bundled with esbuild to `dist/index.js`.
- `packages/mcp` (`src/index.ts`, single file) — stdio MCP server with tools
  `get_prompt`, `search_prompts`, `list_prompts`, `report_run`, `add_note`,
  `suggest_variation`. `packages/mcp/SKILL.md` is the agent-facing skill file
  teaching the fetch → report → suggest workflow.

## Build, test, and dev commands

Package manager is **pnpm 11.7.0** (pinned via `packageManager` in the root
`package.json`). Workspace is declared in `pnpm-workspace.yaml`
(`apps/*`, `packages/*`); native-module build scripts are gated there via
`allowBuilds` (`better-sqlite3`, `electron`, `esbuild` allowed).

```sh
pnpm install                                # install everything
pnpm test                                   # all vitest suites (core + ai + share + desktop + mcp + cli)
pnpm typecheck                              # strict TS in every package (pnpm -r typecheck)
pnpm build                                  # pnpm -r build
pnpm dev                                    # run the Electron app in dev mode
pnpm --filter @promptbranch/desktop dev    # same, explicit
pnpm --filter @promptbranch/desktop build  # production build of main/preload/renderer
pnpm --filter @promptbranch/desktop icons  # regenerate build/ icons (icns/ico/png) from scratch
pnpm --filter @promptbranch/desktop dist   # package installers into apps/desktop/dist/
pnpm --filter @promptbranch/cli build      # build the CLI to apps/cli/dist/
pnpm --filter @promptbranch/mcp build      # build the MCP server to packages/mcp/dist/
```

To run one suite: `pnpm --filter @promptbranch/core test` (or `ai`, `share`,
`desktop`, `cli`, `mcp`). Note that the CLI and MCP `test` scripts run
`pnpm build` first because their tests exercise the built `dist/index.js`.

Node: CI runs on Node 22; local development on Node 26 also works
(`better-sqlite3` loads under both without a rebuild). The CLI/MCP esbuild
bundles target Node 22.

Quality gates and CI (`.github/workflows/`):

- Branch promotion is always `feature/release branch -> dev -> main`, using a
  pull request for each step. Never open a pull request to `main` from any
  branch other than `dev`.
- `ci.yml`: promotion-policy enforcement plus license check, typecheck, test
  and build on pushes and pull requests to `dev` and `main` (macos-latest,
  Node 22, `pnpm install --frozen-lockfile`).
- `publish-npm.yml`: publishes `@promptbranch/*` packages to npm on `v*`
  tags; runs `scripts/sync-package-licenses.mjs` before publishing.
- `desktop-release.yml`: multi-platform matrix (mac/win/linux) building
  signed `.dmg`, `.zip`, `.exe`, `.AppImage`, `.deb` release assets from
  `v*` tags and publishing them to GitHub Releases.

## Commit message convention

History uses **gitmoji + Conventional Commits**, e.g.
`🐛 fix(core): survive ops arriving before their FK parents`,
`🐣 feat(desktop): wire P2P sync into the app`, `📝 docs: …`,
`⚡ perf(sync): …`, `💄 style(desktop): …`, `🔧 chore(license): …`.
Match that format: emoji, `type(scope): subject`.

## Code style guidelines

- **TypeScript, ESM everywhere** (`"type": "module"` in every package).
  Shared `tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`,
  `noImplicitOverride`, `noFallthroughCasesInSwitch`, `isolatedModules`,
  `verbatimModuleSyntax`, `moduleResolution: "bundler"`, `noEmit`. Respect
  these — e.g. `noUncheckedIndexedAccess` means indexed access yields
  `T | undefined`.
- Internal imports use **`.js` suffixes** on TypeScript paths
  (`import ... from "./library.js"`) — required by NodeNext-style resolution
  for the Node-side builds.
- There is no ESLint/Prettier config; formatting is by convention (2-space
  indent, double quotes, semicolons, ~100-column prose wrapping in comments
  and docs). Match the surrounding file.
- Keep the layering rule: **`packages/core`, `packages/ai` and
  `packages/share` must stay free of Electron (and DOM) dependencies**;
  `apps/desktop` main/preload adapt core to IPC; the renderer is pure UI.
- All cross-process data goes through the Zod schemas in
  `apps/desktop/src/shared/ipc.ts` — when adding an IPC surface, add a
  channel in `src/shared/channels.ts` (zod-free: the sandboxed preload cannot
  import zod) + schema + preload method + `ipcMain.handle` registration in
  `src/main/index.ts` (`registerIpcHandlers`); never send raw rows without a
  mapper (`apps/desktop/src/main/mappers.ts`).
- SQLite migrations are **forward-only and append-only**: add a new numbered
  migration in `packages/core/src/migrations.ts`; never edit an
  already-shipped migration. The runner backs up on-disk DBs before migrating
  automatically. (Currently at v7: `sync-shared-snapshots`.)
- Comments in the codebase explain *why*, not what; match that density and
  tone (see `packages/core/src/db.ts` / `paths.ts` for the house style).
- Theming: CSS custom properties (`--pb-*`) in
  `apps/desktop/src/renderer/src/index.css`; dark is the `:root` default,
  light overrides under `[data-theme="light"]`.

## Testing instructions

- Framework: **Vitest 4** in every package; config in each package's
  `vitest.config.ts`.
- `packages/core`, `packages/ai` and `packages/share`: node environment,
  tests in `tests/` (`*.test.ts`). Core tests use `openMemoryDatabase()`
  (in-memory SQLite with migrations applied) — no temp files needed. The
  sync engine's twin-library suite (`tests/sync-engine.test.ts`) drives two
  engines over a fake in-memory transport: concurrent edits, LWW, name
  collisions, tombstones, transitive gossip, idempotency, tiny budgets,
  order-independent convergence.
- `apps/desktop`: node by default; React component tests use
  `// @vitest-environment jsdom` at the top of the file plus Testing Library.
  Test files live next to the code they cover (e.g.
  `src/renderer/src/components/main-pane.test.tsx`,
  `src/renderer/src/lib/diff.test.ts`, `src/main/ai.test.ts`). The preload
  bridge is mocked via `src/renderer/src/test/mock-bridge.ts`
  (`installMockBridge()`); shared setup in
  `src/renderer/src/test/setup.ts` (wired through `vitest.config.ts`);
  `src/renderer/src/test/render.tsx` is the render harness (jest-dom
  matchers, provider wrapper, jsdom polyfills). Sync transport tests live in
  `src/main/sync/`: in-memory stream-pair sessions plus real-TLS loopback
  pairing tests (identity, frames, session, peers-service, DesktopSync
  coordinator).
- `apps/cli` and `packages/mcp`: smoke/integration tests
  (`apps/cli/tests/cli.test.ts`, `apps/cli/tests/share.test.ts`,
  `packages/mcp/tests/smoke.test.ts`) that spawn the **built** binaries
  against a scratch database via `PROMPTBRANCH_DB`; `testTimeout: 30_000`
  and the `test` script builds first.
- Do not weaken existing tests when refactoring; update call sites, not
  expectations, unless behavior genuinely changed.

## Database, concurrency, and environment

- The desktop app, CLI and MCP server all open the **same SQLite file**:
  `~/Library/Application Support/PromptBranch/library.db` (macOS),
  `$XDG_CONFIG_HOME/promptbranch/library.db` (Linux),
  `%APPDATA%\PromptBranch\library.db` (Windows). Resolved by
  `resolveDatabasePath()` in `packages/core/src/paths.ts`.
- **`PROMPTBRANCH_DB=/path/to.db` overrides the DB location** for any of the
  three entry points (tests, agents on a scratch library, debugging). The
  PromptHub-era `PROMPTHUB_DB` and the pre-rename `PROMPTBUILDER_DB` are
  still honored as deprecated fallbacks when `PROMPTBRANCH_DB` is unset or
  blank.
- Concurrency: WAL mode + `busy_timeout = 3000`. Writes from agents while the
  app is open are safe; the app refetches on window focus (no live push).
  Migration v6 adds the sync storage (`sync_dirty`, `sync_ops`,
  `sync_cursors`, `sync_heads`, `sync_id_remaps`, `sync_pending_pointers`,
  `sync_peers`, `sync_meta`) plus dirty-capture triggers on the synced
  tables — CLI/MCP writes are picked up by the desktop app's background sync
  drain.
- On first launch after the PromptBuilder → PromptHub → PromptBranch rename
  chain, the desktop app copies the old database (with WAL/SHM sidecars)
  into the new directory, leaving the old copy untouched.

## Agent integration rules ("agents propose, humans approve")

AI agents (via CLI or MCP) can read prompts, report runs and notes, and
**suggest** variations — but a suggested variation is created as a **pending**
version: invisible to search/listings, and it cannot become current until a
human approves it in the app's **Suggestions** view. Preserve this invariant:
pending suggestions must never leak into search results, listings, or the
current-version pointer.

Sharing is a human action: agents can read local prompts, but `publish` and
`import` exist only in the CLI and desktop app — there is intentionally no
MCP tool for pulling internet content into the library.

Prompts are referenced by title (exact → case-insensitive → unique substring;
ambiguous matches return the close candidates) or by id. Onboarding for users
is copy-paste from Settings → *Agent integration*.

## Multi-device sync rules

Sync is pure P2P over the LAN (spec:
`docs-internal/specs/2026-08-27-sync-design.md`). Invariants to preserve
when touching it:

- The dirty-capture triggers (generated in
  `packages/core/src/sync/tables.ts`, applied by migration v6) must stay
  **pure SQL** — no app-registered functions — because older CLI/MCP binaries
  keep writing to the same database file. Their writes are captured and
  refined when the desktop app runs.
- **Never sync device-local data**: the `settings` table (portal URL,
  remembered test models, catalog cache, `sync.*` keys) and
  `providers.api_key_enc` (redacted at refine, never overwritten on apply).
  `shared_snapshots` DOES sync since migration v7 — paired devices are
  trusted with delete tokens (they already hold the library); export files
  still strip them. The synced-table registry in `tables.ts` is the single
  source of truth for what travels.
- Apply must stay **commutative and idempotent** (same ops in any order
  converge); LWW ties break by device id. Pending agent suggestions sync as
  rows but keep their `pending` status — the agents-propose-humans-approve
  invariant holds across devices.
- The pairing code derives from the accepting device's TLS certificate
  fingerprint; the fingerprint a device pins always comes from the TLS layer,
  never from a message field.
- `sync_peers`/`sync_meta`/`sync_*` tables are engine-owned storage; the
  device certificate/key live in `userData/sync/` (never in the shared DB).

## Security considerations

- **API keys are encrypted with Electron `safeStorage`** before they touch
  the database; only the opaque blob is stored, and decryption happens inside
  the main process at execution time. Never log keys, pass them to the
  renderer, or store plaintext.
- `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY` in
  the environment enable a one-click "Use environment key" connect — handle
  env keys with the same care.
- All renderer↔main traffic is Zod-validated; keep it that way (defense
  against a compromised renderer).
- Sharing runs a pre-publish secret scan
  (`packages/share/src/scanner.ts`: regex rules plus a Shannon-entropy gate);
  the portal re-scans server-side and rejects high-severity findings.
  Never weaken the scanner or render unsanitized markdown. Delete tokens are
  256-bit random (`packages/share/src/ids.ts`), shown to the publisher once,
  stored locally for revocation, hashed server-side, and never travel in
  export files. Sharing is unlisted-only — keep it that way.
- Never commit `.env` files or notarization credentials. macOS signing uses
  the login Keychain's `Developer ID Application` cert (auto-discovered; do
  not pin the identity name); notarization credentials come from
  `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` env vars.
- The desktop `postinstall` script (`scripts/patch-electron-name.mjs`)
  patches the dev Electron bundle's Info.plist to say "PromptBranch",
  breaking the dev binary's code signature — expected, dev-only, never
  ships.
- The renderer has a CSP (see `apps/desktop/scripts/csp-theme-hash.mjs`);
  update the hash script output if you change the inline theme script in
  `index.html`.

## Packaging and release notes

- `pnpm --filter @promptbranch/desktop dist [--mac|--win|--linux]` runs
  electron-vite then electron-builder (config inline in
  `apps/desktop/package.json` → `build`), writing to `apps/desktop/dist/`.
  All targets build from macOS; default is the host platform.
- macOS: dmg + zip (arm64 + x64), **signed (hardened runtime) and notarized**
  when credentials are present; unsigned builds trigger Gatekeeper warnings.
  Windows: NSIS per-user installers, x64 + arm64 (unsigned, SmartScreen warns).
  Linux: AppImage (needs FUSE) + deb, x64 + arm64 (unsigned).
- Icons are **generated, not committed art**: run the `icons` script before
  `dist` if `build/icon*` files are missing (CI does). It also generates the
  monochrome template icons for the native app-menu items
  (`build/menu-icons/`, shipped via `extraResources`, loaded by
  `src/main/menu-icons.ts` — macOS renders them in the app-menu dropdown;
  Windows/Linux menu bars draw no item icons).
- `better-sqlite3` is a native module. It currently loads under both Node 26
  and Electron 43 without a rebuild, so packaging sets `npmRebuild: false`
  and ships the prebuilt binary (`asarUnpack: **/*.node`). If a future
  Electron bump breaks ABI compatibility, rebuild against Electron headers
  (e.g. `@electron/rebuild`) and drop that flag.
- `packages/core`, `packages/ai` and `packages/share` are consumed as
  **TypeScript source** (their `exports` point at `src/*.ts`; their `build`
  script is a no-emit `tsc` typecheck). The desktop app bundles them via
  electron-vite; the CLI/MCP esbuild bundles inline them
  (`better-sqlite3` kept external — Node cannot resolve core's
  `.js`-suffixed TS imports directly without compilation).
- In-app auto-update is wired up via **electron-updater against GitHub
  Releases** (spec: `docs-internal/specs/2026-08-28-auto-update-design.md`).
  `apps/desktop/src/main/updater.ts` (`DesktopUpdater`) owns policy —
  background checks 15s after launch and every 6h, skipped-version handling,
  the `updates.auto_check` / `updates.skipped_version` /
  `updates.last_check_at` device-local settings keys — while
  `src/main/updater-github.ts` adapts the electron-updater singleton. The
  `publish` block pinned in `apps/desktop/package.json` is what makes
  electron-builder embed `app-update.yml` and upload the `latest*.yml` feeds
  the updater consumes; keep it in sync with the real release repo.
  **Prerequisite:** GitHub releases must be publicly downloadable — a private
  repo cannot serve anonymous update checks. macOS updates require the signed
  CI builds; Linux updates work for the AppImage only (deb installs report
  unsupported). Never point the updater at an untrusted feed or disable
  signature verification.
- The app is offline-first *except* for model-catalog refreshes (models.dev),
  model runs, and update checks; a failed catalog refresh keeps serving the
  stale cache.
- The portal deployment infrastructure (Docker Compose standalone stack,
  hardened VPS deployment behind Nginx Proxy Manager, host-hardening
  scripts) lives in the companion `promptbranch-portal` repository.
- Licensing: the project is MIT (root `LICENSE`, mirrored into every package
  manifest). `THIRD_PARTY_NOTICES.md` is generated from the production
  dependency tree (`pnpm notices` / `scripts/generate-notices.mjs`) and must
  be regenerated after dependency changes; it ships via the desktop
  `extraResources` and, for npm packages, via
  `scripts/sync-package-licenses.mjs` (CI runs it before publish; the
  per-package copies are gitignored). `pnpm license-check`
  (`scripts/check-licenses.mjs`, also a CI step) fails the build on unknown
  or copyleft production licenses.
