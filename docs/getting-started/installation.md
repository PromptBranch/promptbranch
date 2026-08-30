# Installation & Setup

PromptBranch can be used as a full desktop application with a visual UI, as a standalone command-line interface (CLI) for shell pipelines, or as an MCP server for AI coding agents.

---

## Desktop Application

Download installers for macOS, Windows, and Linux from
[GitHub Releases](https://github.com/PromptBranch/promptbranch/releases).

### macOS

PromptBranch provides separate native builds for Apple Silicon (M1/M2/M3/M4) and Intel Macs:

- **Apple Silicon (ARM64)**: `PromptBranch-<version>-macos-arm64.dmg`
- **Intel (x64)**: `PromptBranch-<version>-macos-x64.dmg`
- **Portable Zip**: `PromptBranch-<version>-macos-arm64.zip` / `PromptBranch-<version>-macos-x64.zip`

The GitHub release notes state whether a macOS build is signed and notarized.
Unsigned preview builds may trigger Gatekeeper; use only releases published by
the official PromptBranch repository and verify the listed checksum.

> [!NOTE]
> **Local Network Permission Prompt**: On macOS, the first time you enable Multi-Device Sync, macOS may display a system dialog asking for **Local Network** access. Select **Allow** so local discovery and peer-to-peer sync can reach your other devices.

### Windows

- **Installer (Intel/AMD 64-bit)**: `PromptBranch-<version>-windows-x64.exe`
- **Installer (ARM64)**: `PromptBranch-<version>-windows-arm64.exe`

The Windows installer uses NSIS in **per-user mode** (`%LOCALAPPDATA%\Programs\PromptBranch`). It does not require administrator privileges to install or update.

> [!TIP]
> If Windows SmartScreen displays a warning on an unsigned build, click **More info** and select **Run anyway**.

### Linux

- **AppImage**: `PromptBranch-<version>-linux-x64.AppImage` / `PromptBranch-<version>-linux-arm64.AppImage`
- **Debian / Ubuntu**: `PromptBranch-<version>-linux-x64.deb` / `PromptBranch-<version>-linux-arm64.deb`

#### AppImage Prerequisites
AppImage binaries on modern Linux distributions (such as Ubuntu 24.04+, Debian 12+, Fedora 40+) require FUSE 2 or 3:
```bash
# Ubuntu / Debian
sudo apt install libfuse2

# Fedora / RHEL
sudo dnf install fuse-libs
```
To run the AppImage:
```bash
chmod +x PromptBranch-*.AppImage
./PromptBranch-*.AppImage
```

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
