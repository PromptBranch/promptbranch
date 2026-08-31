# Configuration and environment

Most people can use PromptBranch without changing any configuration. This page
covers the few settings useful for the CLI, MCP server, or provider setup.

## Use a different library

The desktop app, CLI, and MCP server use the same local library by default. Set
`PROMPTBRANCH_DB` when you want an entry point to use a different database:

    export PROMPTBRANCH_DB="/path/to/my-library.db"
    promptbranch list

The default location is:

| System | Library path |
| --- | --- |
| macOS | `~/Library/Application Support/PromptBranch/library.db` |
| Linux | `$XDG_CONFIG_HOME/promptbranch/library.db` (or `~/.config/promptbranch/library.db`) |
| Windows | `%APPDATA%\PromptBranch\library.db` |

Older `PROMPTHUB_DB` and `PROMPTBUILDER_DB` variables still work as fallback
names if `PROMPTBRANCH_DB` is not set.

## Use an environment API key

Set one of these before starting PromptBranch, then use **Use environment key**
in **Settings → AI Providers**:

| Variable | Provider |
| --- | --- |
| `OPENAI_API_KEY` | OpenAI |
| `ANTHROPIC_API_KEY` | Anthropic |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Google |

## Sync connectivity

For device sync, allow PromptBranch to communicate with your other devices on
your local network or VPN. On macOS, allow the system Local Network permission
when prompted. If nearby discovery does not work, use **Pair by address** in
**Settings → Sync**.
