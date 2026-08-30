# Installation & Setup

PromptBranch can be used as a full desktop application with a visual UI, as a standalone command-line interface (CLI) for shell pipelines, or as an MCP server for AI coding agents.

---

## Desktop Application

PromptBranch desktop 0.1.0 is currently available only for macOS. The CLI and
MCP server remain cross-platform.

### macOS

Download the native build for your Mac from
[GitHub Releases](https://github.com/PromptBranch/promptbranch/releases):

- **Apple Silicon (arm64), DMG**: `promptbranch_0.1.0_macos_arm64.dmg`
- **Apple Silicon (arm64), ZIP**: `promptbranch_0.1.0_macos_arm64.zip`
- **Intel (x64), DMG**: `promptbranch_0.1.0_macos_x64.dmg`
- **Intel (x64), ZIP**: `promptbranch_0.1.0_macos_x64.zip`

Use only files published by the official PromptBranch repository and verify
the checksum listed in the release notes.

> [!NOTE]
> **Local Network Permission Prompt**: On macOS, the first time you enable Multi-Device Sync, macOS may display a system dialog asking for **Local Network** access. Select **Allow** so local discovery and peer-to-peer sync can reach your other devices.

### Windows

Windows desktop builds are planned, but no Windows desktop installer is
available in 0.1.0. You can still use the cross-platform CLI and MCP server on
Windows.

### Linux

Linux desktop builds are planned, but no Linux desktop installer is available
in 0.1.0. You can still use the cross-platform CLI and MCP server on Linux.

---

## Command-Line Interface (CLI)

Run `@promptbranch/cli` directly from npm without a global installation:

```bash
npx -y @promptbranch/cli db-path
```

For a persistent `promptbranch` command, install it globally:

```bash
npm install --global @promptbranch/cli
```

Once set up, verify the installation by printing the resolved database path:
```bash
promptbranch db-path
```

---

## Model Context Protocol (MCP) Server

PromptBranch provides a stdio MCP server that enables AI assistants (such as Claude Desktop, Cursor, Windsurf, or Cline) to read prompts, log run metrics, and suggest variations.

Run the MCP server from npm with `npx -y @promptbranch/mcp`.

### Claude Desktop Configuration

Add the following configuration to your `claude_desktop_config.json`:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "promptbranch": {
      "command": "npx",
      "args": ["-y", "@promptbranch/mcp"]
    }
  }
}
```

### Cursor / Windsurf Configuration

In Cursor or Windsurf MCP settings, add a stdio MCP server:
- **Name**: `promptbranch`
- **Command**: `npx`
- **Args**: `["-y", "@promptbranch/mcp"]`

> [!TIP]
> The desktop app prints this configuration ready-to-paste in **Settings → Agent integration**.

---

## Database Location & Environment Variables

All three entry points (Desktop App, CLI, and MCP server) open the exact same SQLite database file by default.

### Default Database Paths by OS

| Operating System | Default Path |
| :--- | :--- |
| **macOS** | `~/Library/Application Support/PromptBranch/library.db` |
| **Linux** | `$XDG_CONFIG_HOME/promptbranch/library.db` (or `~/.config/promptbranch/library.db`) |
| **Windows** | `%APPDATA%\PromptBranch\library.db` |

### Overriding the Database Path (`PROMPTBRANCH_DB`)

You can point PromptBranch to an alternate database file (for example, a separate personal or test library) by setting the `PROMPTBRANCH_DB` environment variable:

```bash
export PROMPTBRANCH_DB="/path/to/my-custom-library.db"
promptbranch list
```

> [!NOTE]
> For backwards compatibility, PromptBranch also recognizes the legacy environment variables `PROMPTHUB_DB` and `PROMPTBUILDER_DB` as fallbacks if `PROMPTBRANCH_DB` is not set.

### Automatic Migration from Legacy Apps
If you previously used pre-release versions (named *PromptBuilder* or *PromptHub*), PromptBranch automatically migrates your existing database on first launch:
1. It locates the legacy `library.db` along with its WAL/SHM sidecar files.
2. It safely copies them into the new `PromptBranch` directory.
3. The original legacy database files are left completely untouched as a backup.
