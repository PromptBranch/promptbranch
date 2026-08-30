# Manual release checklist

PromptBranch releases are intentionally manual. Tags do not trigger GitHub
Actions, and the only repository workflow is CI.

## 1. Promote the release commit

1. Confirm the release version is consistent in the root and package
   manifests.
2. Run the complete gate on `dev`:

   ```sh
   pnpm install --frozen-lockfile
   pnpm license-check
   pnpm typecheck
   pnpm test
   pnpm build
   ```

3. Merge `dev` into `main` through a pull request and wait for `CI` to pass.
4. Check out the resulting `main` commit. Build and publish only that commit.

## 2. Build desktop installers

Build each OS/architecture pair on the corresponding operating system. Use a
clean checkout of the exact `main` commit and Node 22.

```sh
pnpm install --frozen-lockfile
node apps/desktop/scripts/verify-desktop-icons.mjs

pnpm --filter @promptbranch/desktop dist --mac --arm64 --publish never
pnpm --filter @promptbranch/desktop dist --mac --x64 --publish never
pnpm --filter @promptbranch/desktop dist --win --arm64 --publish never
pnpm --filter @promptbranch/desktop dist --win --x64 --publish never
pnpm --filter @promptbranch/desktop dist --linux --arm64 --publish never
pnpm --filter @promptbranch/desktop dist --linux --x64 --publish never
```

Run only the commands for the current operating system. Clear
`apps/desktop/dist/` between target builds so stale files cannot be mistaken
for current output.

For every target, verify the packaged executable and native SQLite module:

```sh
node apps/desktop/scripts/verify-release-architecture.mjs \
  --platform <mac|win|linux> --arch <arm64|x64> \
  --dist apps/desktop/dist
```

Then copy only the expected installers into a target-specific staging folder:

```sh
node apps/desktop/scripts/collect-release-installers.mjs \
  --platform <mac|win|linux> --arch <arm64|x64> --version <x.y.z> \
  --dist apps/desktop/dist --out <staging-directory>
```

The final release set contains exactly ten user-installable files:

- macOS: DMG and ZIP for `arm64` and `x64` (4 files)
- Windows: EXE for `arm64` and `x64` (2 files)
- Linux: AppImage and DEB for `arm64` and `x64` (4 files)

Every filename must include the version, operating system, and architecture.
Never upload `latest*.yml`, `.blockmap`, unpacked application directories, or
generic files whose target is unclear.

## 3. Test the actual installers

Before publication, download or copy the staged files to representative target
machines and verify installation, first launch, prompt creation, persistence
after restart, CLI access, and MCP startup against an isolated
`PROMPTBRANCH_DB` database.

macOS signing and notarization are currently optional. If a build is unsigned,
say so prominently in the release notes and test the documented Gatekeeper
recovery path. If signing credentials are used, run:

```sh
node apps/desktop/scripts/verify-macos-distribution.mjs \
  --dist apps/desktop/dist
```

## 4. Create the GitHub release

1. Create an annotated `vX.Y.Z` tag on the verified `main` commit and push it.
2. Create a draft GitHub Release for that tag.
3. Upload only the ten staged installers.
4. Add a download table mapping OS and architecture to each filename, state
   the signing status, and include SHA-256 checksums.
5. Download each uploaded asset once and compare its checksum with the staged
   source before publishing the release.

Release tags are immutable. If an asset is wrong, leave the tag unchanged,
withdraw the release, fix the problem through `dev` → `main`, and publish a new
patch version.

## 5. Publish CLI and MCP packages to npm

npm publication is a separate deliberate step. Authenticate locally, then:

```sh
pnpm notices
node scripts/sync-package-licenses.mjs
pnpm --filter @promptbranch/share publish --access public --no-git-checks
pnpm --filter @promptbranch/core publish --access public --no-git-checks
pnpm --filter @promptbranch/ai publish --access public --no-git-checks
pnpm --filter @promptbranch/mcp publish --access public --no-git-checks
pnpm --filter @promptbranch/cli publish --access public --no-git-checks
```

Verify the public CLI and MCP entry points with a temporary database before
announcing the release.
