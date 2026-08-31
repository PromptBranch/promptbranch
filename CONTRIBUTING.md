# Contributing to PromptBranch

Thanks for helping improve PromptBranch. Keep contributions focused on a
clear user or agent need, and include tests when behaviour changes.

## Get started

Install Node.js 22 and pnpm 11.7.0, then build the project:

```sh
corepack enable
pnpm install
pnpm build
```

Run the desktop app during development with `pnpm dev`. Before opening a pull
request, run:

```sh
pnpm typecheck
pnpm test
pnpm build
```

## Pull requests

- Explain the problem and the user-visible result.
- Keep each change focused and update user documentation when it changes how
  PromptBranch is installed or used.
- Do not commit API keys, prompt libraries, or other private data.
- Report security issues privately.
