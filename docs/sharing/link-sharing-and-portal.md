# Link Sharing & Secret Scanning

PromptBranch allows you to publish immutable prompt snapshots to an unlisted web portal behind unguessable URLs, protected by an automated **pre-publish secret scanner** and revocable with local **delete tokens**.

---

## How Sharing Works

1. You click **Publish** in the desktop app or CLI.
2. PromptBranch scans the exact payload for secrets **before anything leaves your machine** — high-severity findings (API keys, private keys, tokens) block publishing until removed.
3. The portal re-scans every submission server-side and rejects anything that trips the same rules.
4. The snapshot goes live behind an unguessable URL (`https://promptbranch.app/p/<id>`) and your **delete token** is stored locally so the share can be revoked later from any paired device. The desktop app shows the share link; the CLI additionally prints the delete token exactly once at publish time.

---

## The Pre-Publish Secret Scanner

To prevent accidental leakage of sensitive credentials, PromptBranch runs a dual-layer security scan:
1. **Client-Side Scan**: Scans before the payload is serialized and sent over the network.
2. **Server-Side Enforcement**: The portal re-scans every submission; high-severity findings are rejected.

### Scanner Rules & Severities

| Rule Name | Severity | Targeted Match Pattern |
| :--- | :---: | :--- |
| **`anthropic-api-key`** | `High` | `sk-ant-[A-Za-z0-9_-]{20,}` |
| **`openai-api-key`** | `High` | `sk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{20,}` |
| **`google-api-key`** | `High` | `AIza[0-9A-Za-z_-]{35}` |
| **`aws-access-key`** | `High` | `\b(?:AKIA\|ASIA)[0-9A-Z]{16}\b` |
| **`gcp-service-account`** | `High` | `"type"\s*:\s*"service_account"` |
| **`github-token`** | `High` | `ghp_`, `gho_`, `github_pat_` tokens |
| **`slack-token`** | `High` | `xoxb-`, `xoxp-`, `xoxa-`, `xoxr-` |
| **`pem-private-key`** | `High` | `-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----` |
| **`high-entropy-assignment`**| `High` | `api_key`/`secret`/`token`/`password` assignment with Shannon entropy $\ge 4.0$ |
| **`auth-header`** | `High` | `Authorization` or `x-api-key` bearer/basic headers |
| **`internal-url`** | `Medium` | Private IP ranges (`10.x`, `192.168.x`, `172.16.x`, `localhost`) |
| **`email-address`** | `Medium` | Email address patterns |

- **High Severity**: Blocks publication immediately until removed.
- **Medium Severity**: Warns the user about internal infrastructure or email addresses, but allows publication if intended.

---

## Publishing a Snapshot

1. Open the prompt you wish to share.
2. Click the **Share** button on the prompt toolbar.
3. Select your publishing scope:
   - **Current version only**: Shares only the active production version.
   - **Include full history**: Includes the full sequence of versions and change notes on the default branch.
4. Review the **Secret Scan Results** and payload preview.
5. Click **Publish**.
6. PromptBranch returns your unlisted snapshot URL (`https://promptbranch.app/p/<21-char-id>`) and stores the **Delete Token** locally so you can revoke the share from any paired device.

---

## Revoking a Share

You retain complete ownership over your published prompts:
1. In the desktop app left rail, click **Shares**.
2. Browse your published links, search by title, and filter by status (All / Active / Revoked).
3. Click the trash icon next to a share (**Delete share of \<title\>**) and confirm.
4. PromptBranch sends your cryptographic delete token to the portal, which removes the snapshot so the link stops serving content. Revoked shares are marked as such in the Shares view.

---

## Importing Shared Prompts

Anyone viewing a snapshot can import it into their local PromptBranch library:

### 1. One-Click Deep Links (`promptbranch://`)
Clicking **Import to PromptBranch** on a web snapshot triggers the custom OS protocol handler `promptbranch://import?url=...`. The desktop app opens a validated preview; nothing is written until you click **Import**. The imported prompt preserves the published scope and tags and includes a provenance note.

### 2. CLI Import
```bash
promptbranch import https://promptbranch.app/p/V1StGXR8_Z5jdHi6B-myT
```
