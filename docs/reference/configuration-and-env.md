# Configuration & Environment Variables

This reference lists all configuration options, environment variables, filesystem paths, and network settings for PromptBranch.

---

## Environment Variables

### Client & Database Variables

| Variable | Scope | Default Value | Description |
| :--- | :--- | :--- | :--- |
| **`PROMPTBRANCH_DB`** | Desktop / CLI / MCP | OS default path | Overrides the SQLite database file path. |
| **`PROMPTHUB_DB`** | Desktop / CLI / MCP | Unset | Deprecated fallback path override. |
| **`PROMPTBUILDER_DB`** | Desktop / CLI / MCP | Unset | Deprecated fallback path override. |

---

### AI Provider Keys (Auto-Detected)

If set in your shell environment, PromptBranch displays a **"Use environment key"** quick-connect button in Settings → AI Providers:

| Variable | Provider | Description |
| :--- | :--- | :--- |
| **`OPENAI_API_KEY`** | OpenAI | API key for OpenAI GPT models. |
| **`ANTHROPIC_API_KEY`** | Anthropic | API key for Anthropic Claude models. |
| **`GOOGLE_GENERATIVE_AI_API_KEY`** | Google | API key for Google Gemini models. |

---

## Default Filesystem Paths by OS

These database and local-sync identity paths apply to the desktop app, CLI,
and MCP server on every listed operating system.

| Operating System | Default Database Path | Local Sync Identity & Keys |
| :--- | :--- | :--- |
| **macOS** | `~/Library/Application Support/PromptBranch/library.db` | `~/Library/Application Support/PromptBranch/sync/` |
| **Linux** | `$XDG_CONFIG_HOME/promptbranch/library.db` (defaults to `~/.config/promptbranch/library.db`) | `$XDG_CONFIG_HOME/PromptBranch/sync/` (defaults to `~/.config/PromptBranch/sync/`) |
| **Windows** | `%APPDATA%\PromptBranch\library.db` | `%APPDATA%\PromptBranch\sync\` |

---

## Network & Discovery Ports

- **mDNS Service**: `_promptbranch._tcp` advertised over UDP port `5353` (multicast DNS).
- **Peer-to-Peer Sync**: Each device listens on a local TLS port for paired peers; firewalls must allow inbound connections to it on your LAN.
