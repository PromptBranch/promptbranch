# Updates

PromptBranch can check for a newer stable desktop release and select the
installer that matches your operating system and CPU architecture. Downloading
and installing the update remains under your control.

## Check for an update

Choose **Check for Updates…** from the PromptBranch application menu, or open
**Settings → Updates** and select **Check for Updates**.

PromptBranch compares the installed version with the latest stable release. The
Updates page then shows one of these results:

- **Up to date** — the installed version is the latest stable release.
- **Update available** — a newer version and a matching installer are available.
- **No compatible installer** — a newer release exists, but its installer for
  this device has not been published yet.
- **Couldn’t check for updates** — the check failed; select **Try Again** when
  your connection is available.

The page also shows the current version, latest known version, detected
platform and architecture, last checked time, and release notes when a newer
version is available.

## Automatic checks

**Automatically check for updates** is enabled by default. PromptBranch checks
quietly after launch and no more than once per day. It shows a notification only
when a matching update is available; routine successes and failures do not
interrupt your work.

Turn the setting off at any time in **Settings → Updates**. Manual checks remain
available while automatic checks are disabled.

## Download and install

When an update is available, select **Download Update**. PromptBranch opens the
exact matching installer in your system browser; it does not download, run, or
install anything in the background. Install the new version using your normal
platform steps. Your local library remains in the same application-data
directory.

| Platform | Matching downloads |
| --- | --- |
| macOS | DMG for arm64 or x64 |
| Windows | EXE for arm64 or x64 |
| Linux | AppImage and/or DEB for arm64 or x64 |

On Linux, PromptBranch recommends the AppImage when the running app was opened
from an AppImage. It never substitutes an installer for another operating
system or architecture.
