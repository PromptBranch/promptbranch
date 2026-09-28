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

## Embed a shared prompt on a website

On a published prompt page, choose **Auto**, **Light**, or **Dark** and select
**Copy embed code**. The desktop app offers the same theme choice after
publishing and for active shares in **Shares**. Add the copied HTML where the
prompt should appear. It creates a portal-styled prompt window directly in the
page using Shadow DOM; it does not use an iframe.

The code has this form. Use the exact snippet copied for your share:

```html
<div data-promptbranch-embed="https://promptbranch.app/p/V1StGXR8_Z5jdHi6B-myT"></div>
<script defer src="https://promptbranch.app/embed.js"></script>
```

Include the script once per portal origin, even when the page has multiple
embeds. The share URL and script URL must use the same portal origin as the
share. The prompt title appears in the embed window's title bar. The embed
supports **Rendered**, **Source**, and **Copy** controls, plus an **Open in
PromptBranch** button with an icon and a **View full prompt** link. The open
action asks the desktop app to preview the shared snapshot before import.

The portal's JavaScript runs on your page and can access its DOM. Add embed
code only from a portal you trust.

**Auto** follows the visitor's system appearance. **Light** and **Dark** set a
fixed appearance. The copied code adds
`data-promptbranch-theme="light"` or `data-promptbranch-theme="dark"` to the
embed `<div>` when either fixed theme is selected; Auto omits the attribute.
If your site sets a Content Security Policy, allow the portal origin in
`script-src`, `style-src`, and `connect-src`. Keep the rest of your existing
policy directives.

## Link to a public Markdown prompt

A website can link directly to a public Markdown file to offer an import into
PromptBranch. Copy and customize this HTML example with your file's public
HTTPS URL, percent-encoding the complete URL as the `url` parameter:

```html
<a
  href="promptbranch://import-markdown?url=https%3A%2F%2Fexample.com%2Fprompts%2Freview.md"
  style="display:inline-flex;align-items:center;gap:.5rem;padding:.7rem 1rem;border-radius:.6rem;background:#315ee8;color:#fff;font:600 14px/1.2 system-ui,-apple-system,sans-serif;text-decoration:none"
>
  <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M7 17 17 7M7 7h10v10" />
  </svg>
  <span>Open in PromptBranch</span>
</a>
```

The link opens a review dialog. PromptBranch does not fetch the file until the
user selects **Fetch Markdown**. The user can review the literal Markdown and
edit its title; **Import as new prompt** then creates a separate local prompt
and records the source URLs in a note. The file must be reachable over public
HTTPS without a sign-in or private-network access. Importing does not publish
the prompt or change the source website.
