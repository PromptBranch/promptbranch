# Changelog

Notable user-facing changes to PromptBranch are documented here. GitHub
Releases contain platform downloads, checksums, and release-specific validation
notes.

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

[0.3.1]: https://github.com/PromptBranch/promptbranch/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/PromptBranch/promptbranch/releases/tag/v0.3.0
