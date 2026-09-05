# PromptBranch Share

[![npm version](https://img.shields.io/npm/v/%40promptbranch%2Fshare?logo=npm&logoColor=white)](https://www.npmjs.com/package/@promptbranch/share)

`@promptbranch/share` is the sharing contract used by PromptBranch clients and
portals. It provides validated immutable snapshot payloads, secret scanning,
snapshot id and URL helpers, and a typed HTTP client for publishing, fetching,
and deleting shared snapshots. It has no Electron dependency.

Requires Node.js 22 or later.

Source: [GitHub](https://github.com/PromptBranch/promptbranch/tree/main/packages/share) ·
[documentation](https://promptbranch.app/docs/sharing/link-sharing-and-portal) ·
[report an issue](https://github.com/PromptBranch/promptbranch/issues)

## Install

```sh
npm install @promptbranch/share@latest
```

## Build and scan a snapshot

```js
import { buildSnapshotPayload, scanForSecrets } from "@promptbranch/share";

const snapshot = buildSnapshotPayload({
  title: "Review this change",
  promptDescription: "A reusable code-review prompt",
  content: "Review {{target}} for correctness and security.",
  tags: ["code-review"],
});

const findings = scanForSecrets(snapshot.content);
const blockingFindings = findings.filter((finding) => finding.severity === "high");

if (blockingFindings.length > 0) {
  throw new Error("Snapshot contains a possible secret");
}
```

`buildSnapshotPayload()` validates the exact data that may cross the sharing
boundary. Notes, runs, ratings, and collections are not part of the snapshot
schema. `scanForSecrets()` reports high- and medium-severity findings; the
caller decides how to handle them.

## Use the portal client

```js
import {
  OFFICIAL_PORTAL_BASE_URL,
  publishSnapshot,
} from "@promptbranch/share";

const result = await publishSnapshot(OFFICIAL_PORTAL_BASE_URL, snapshot);

if (!result.ok) {
  console.error(result.error.kind);
} else {
  console.log(result.value.url);
  // Store result.value.deleteToken securely if the share may be revoked later.
}
```

The client returns `ShareResult<T>` instead of throwing for expected network,
validation, rate-limit, rejection, and HTTP failures. Switch on
`result.error.kind` for programmatic handling. Requests time out after 30
seconds by default, and publish payloads are limited to 256 KiB.

Related exports include `fetchSnapshot()`, `deleteSnapshot()`,
`parseSnapshotUrl()`, `resolvePortalBaseUrl()`, `snapshotSchema`, and the
snapshot response schemas and TypeScript types.

## Build from source

From the [PromptBranch repository](https://github.com/PromptBranch/promptbranch),
with pnpm 11.7.0 available:

```sh
pnpm install
pnpm --filter @promptbranch/share build
```

The published package contains compiled ESM in `dist/` and TypeScript
declarations.
