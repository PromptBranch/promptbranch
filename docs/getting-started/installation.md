# Installation & Setup

PromptBranch can be used as a full desktop application with a visual UI, as a standalone command-line interface (CLI) for shell pipelines, or as an MCP server for AI coding agents.

---

## Desktop Application

PromptBranch desktop is available for macOS, Windows, and Linux. The CLI and
MCP server are also cross-platform.

### macOS

Download the installer that matches your Mac from
[GitHub Releases](https://github.com/PromptBranch/promptbranch/releases),
open it, and move PromptBranch to Applications.

> [!NOTE]
> **Local Network Permission Prompt**: On macOS, the first time you enable Multi-Device Sync, macOS may display a system dialog asking for **Local Network** access. Select **Allow** so local discovery and peer-to-peer sync can reach your other devices.

### Windows

Download the installer that matches your Windows device from
[GitHub Releases](https://github.com/PromptBranch/promptbranch/releases),
then run it.

### Linux

Download the AppImage or Debian package that matches your Linux device from
[GitHub Releases](https://github.com/PromptBranch/promptbranch/releases),
then install or run it using your distribution's normal method.

---

## Build from Source

To build PromptBranch from a checkout, install **Node.js 22** and enable
**pnpm 11.7.0** through Corepack. Then clone the repository and build every
workspace package:

```bash
git clone https://github.com/PromptBranch/promptbranch.git
cd promptbranch
corepack enable
pnpm install
pnpm build
```

`pnpm build` builds the desktop app as well as the CLI and MCP server. To run
the desktop app from the checkout, use:

```bash
pnpm dev
```

To build just one command-line adapter, run its package build command:

```bash
pnpm --filter @promptbranch/cli build
pnpm --filter @promptbranch/mcp build
```

The resulting Node entry points are `apps/cli/dist/index.js` and
`packages/mcp/dist/index.js`.

---

## Command-Line Interface (CLI)

The CLI needs **Node.js 22** or later.

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

The MCP server needs **Node.js 22** or later.

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

### Moving from earlier preview apps

If you previously used *PromptBuilder* or *PromptHub*, PromptBranch copies
that library to its new location on first launch. Your original library stays
unchanged.
