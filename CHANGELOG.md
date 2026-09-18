# Changelog

Notable user-facing changes to PromptBranch are documented here. GitHub
Releases contain platform downloads, checksums, and release-specific validation
notes.

## [Unreleased]

### Fixed

- Keep the public MCP and CLI packages installable from npm by requiring pnpm's
  workspace-aware publication path.

### Packages

- `@promptbranch/cli` 0.2.7
- `@promptbranch/mcp` 0.2.9

## [0.7.0] - 2026-09-17

### Fixed

- Repair version-bound drafts for libraries whose earlier schema marker skipped
  the draft-base column migration, so automatic draft saves work reliably.
- Reject incompatible device-to-device sync payload schemas before pairing or
  applying remote changes. Protocol 4 requires sync schema 13, so every paired
  desktop or mobile device must be upgraded before sync can resume.
- Reject malformed or internally inconsistent library imports before they can
  change the library.
- Keep each live model result tied to the run that started it, even when runs
  overlap or finish out of order.
- Keep version saves reliable when another local process is writing at the same
  time.
- Enforce count, input-size, and rendered-size limits for prompt variables.
- Bound portal response bodies while importing, publishing, or revoking a
  shared prompt.

### Improved

- Speed up large sync-history merges, rating summaries, and search updates
  while preserving the same results and history.

### Release requirements

- A mobile release must implement protocol 4 and sync schema 13 and pass a
  physical desktop-to-mobile interoperability test before mobile sync
  compatibility is considered release-ready.

### Packages

- `@promptbranch/desktop` 0.7.0
- `@promptbranch/core` 0.2.5
- `@promptbranch/share` 0.2.2
- `@promptbranch/cli` 0.2.6
- `@promptbranch/mcp` 0.2.8

## [0.6.0] - 2026-09-16

### Added

- Add an interactive History graph view with List/Graph switching,
  lineage-aware branch and variation edges, keyboard selection, pan/zoom/fit
  controls, and the same comparison and version actions available in the list
  view.

### Changed

- Allow <kbd>⌘S</kbd> on macOS or <kbd>Ctrl+S</kbd> on Windows and Linux to
  save edits into the displayed version while preserving its identity and
  place in history.
- Keep **Save as new version** available when you want to preserve the
  displayed content as a separate history entry and create a descendant with a
  change note.
- Make variation and duplicate actions copy the version currently displayed or
  explicitly selected, rather than an unrelated branch head.
- Make search and the global prompt palette open the prompt's preferred/current
  version by default.

### Fixed

- Prevent renderer logging failures on closed output pipes from surfacing as
  uncaught application exceptions.

### Packages

- `@promptbranch/desktop` 0.6.0. The CLI, MCP, core, AI, and share package
  versions are unchanged in this release.

## [0.3.1] - 2026-09-04

### Fixed

- Persist a new prompt's initial content as version 1 immediately, so the
  desktop app, CLI, and MCP server all read the same committed prompt without
  requiring an unnecessary version 2.
- Derive the CLI and MCP runtime version strings from their package manifests,
  keeping `promptbranch --version` and MCP handshakes aligned with the packages
  users install.

### Added

- Add MCP Registry metadata for `io.github.PromptBranch/promptbranch`.
- Improve CLI and MCP npm metadata and package documentation for discovery and
  installation.

### Packages

- `@promptbranch/core` 0.2.1
- `@promptbranch/cli` 0.2.3
- `@promptbranch/mcp` 0.2.5
- `@promptbranch/share` remains at 0.2.0.

## [0.3.0] - 2026-09-03

### Added

- Create prompts directly inside collections.
- Add permanent deletion for revoked shares.
- Add prompt context-menu actions for duplication, deletion, and collection
  management.
- Add cancellation for running model evaluations.

### Fixed

- Improve draft durability, sync-key encoding, backup scheduling, run-input
  persistence, and hard-delete convergence.
- Harden share-size validation, secret scanning, and import boundaries.

[0.7.0]: https://github.com/PromptBranch/promptbranch/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/PromptBranch/promptbranch/compare/v0.5.0...v0.6.0
[0.3.1]: https://github.com/PromptBranch/promptbranch/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/PromptBranch/promptbranch/releases/tag/v0.3.0
