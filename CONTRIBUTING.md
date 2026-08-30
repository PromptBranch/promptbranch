# Contributing to PromptBranch

PromptBranch uses a deliberately small branch model:

```text
feature branch → dev → main
```

- `dev` is the integration branch. Completed feature branches merge here, and
  maintainers may commit small, low-risk changes here directly.
- `main` is production. It contains only code promoted from `dev` after the
  complete quality gate passes.
- Releases are prepared manually from `main`; creating a tag does not run a
  publishing workflow.

## Making a change

1. Start a focused branch from the latest `dev` for feature or substantial
   work. Small maintainer changes may be committed directly to `dev`.
2. Add or update tests for behavioral changes.
3. Run the relevant package tests while working, then run the complete gate:

   ```sh
   pnpm install --frozen-lockfile
   pnpm license-check
   pnpm typecheck
   pnpm test
   pnpm build
   ```

4. Merge the feature branch into `dev` after CI passes.
5. When `dev` is stable and release-ready, open a `dev` → `main` pull request.
   Pull requests into `main` from any other branch are rejected by CI.
6. After the promotion merges, fast-forward `dev` to the new `main` commit so
   the next development cycle starts from identical history.

Use squash merges for focused feature branches when a compact history is
useful. Use a normal merge for `dev` → `main` so production promotions remain
easy to identify.

## Pull requests

- Target `dev` for feature work; target `main` only from `dev`.
- Explain the user-visible behavior and the verification performed.
- Keep security reports private by following `.github/SECURITY.md`.
- Never commit API keys, signing material, user prompt libraries, or other
  private data.

## CI and releases

The single `.github/workflows/ci.yml` workflow validates pushes to `dev` and
pull requests targeting `dev` or `main`. It does not publish packages, create
branches, create releases, or upload installers.

The expected GitHub rules are intentionally small:

- `dev`: block deletion and force pushes; direct maintainer commits are
  allowed.
- `main`: block deletion and force pushes; require a pull request from `dev`
  and the `CI` status check. An approval is not required while the project has
  one maintainer.
- `v*` tags: block updates and deletion so published release identities stay
  immutable.

Desktop installers, npm packages, tags, and GitHub Releases are created only
when a maintainer deliberately follows [docs-internal/RELEASING.md](docs-internal/RELEASING.md).
