# Share a prompt

PromptBranch can publish an immutable snapshot of a prompt to the sharing
portal. A share has an unguessable link and can be revoked later. Sharing is
intentional: your normal library stays local until you choose **Publish**.

## Publish from the desktop app

1. Open the prompt and select **Share** in the toolbar.
2. Choose whether to share the current version only or the full default-
   variation history.
3. Review the payload preview and secret-scan result.
4. Select **Publish**, then copy the link.

PromptBranch checks the exact content before sending it. Suspected API keys,
tokens, private keys, and similar high-risk secrets block publishing. Warnings
such as an email address or private-network URL require you to make an
intentional choice. Remove anything you would not want the recipient to see.

## Publish from the CLI

```sh
promptbranch publish "security-audit" --preview
promptbranch publish "security-audit" --full-history
promptbranch publish "security-audit" --full-history --yes --json
```

Start with `--preview`: it prints the exact payload and secret-scan findings
without publishing, making a request, or saving a share or delete token. A
plain terminal publish shows the review and asks `Publish this snapshot?
[y/N]`; only `y` or `yes` publishes, and any other response cancels.

For a non-interactive command, use `--yes` only after the caller's own review.
It records deliberate non-interactive caller intent, but does not make an
unrestricted shell agent safe. `--json` only changes output formatting; it
does not authorize a publish. High-severity findings always block. Medium-
severity findings are shown and require the terminal confirmation or a
deliberate `--yes` decision.

The desktop Share dialog remains the fully visual human workflow. MCP
intentionally has no publish tool, making it the safer surface for agents that
must not publish. After publishing, the CLI prints the shared URL and delete
token and saves the token locally so you can revoke the share later. See the
[CLI guide](../integrations/cli.md) for all options.

## Manage or revoke a share

Open **Shares** in the desktop app's left rail. You can search your shares,
filter active and revoked links, copy a link, and revoke an active share. A
revoked link no longer serves the snapshot.

After revoking a share, choose **Remove permanently** to delete its entry from
your local Shares list. This removes only the local management record; the
public link is already disabled. The removal also syncs to paired devices.

Shares and their revocation tokens sync between paired devices, so any of your
paired devices can manage a share.

## Import a shared prompt

On a shared prompt page, choose **Import to PromptBranch**. The desktop app
opens a preview and writes nothing until you confirm **Import**. You can also
run:

```sh
promptbranch import https://promptbranch.app/p/<id>
```

An import creates a new local prompt with the shared content, description,
tags, and a note identifying its source. A shared history remains viewable in
the browser; it is not recreated as a local version history.
