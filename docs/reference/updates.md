# Updates

PromptBranch production builds can keep themselves up to date from the
project's public release feed. The app downloads the right build for your
operating system and installs it in-app — no manual re-download. No public
release feed has been published yet, so update checks cannot find a release in
this pre-release version.

## How it works

- **Automatic checks.** Shortly after launch, and then about every six hours,
  the app quietly checks GitHub for a newer release. When one is found, an
  **Update available** dialog shows what's new and offers the update, and a
  small download icon appears next to the version in the app's sidebar until
  you install or skip that release. The check talks to GitHub only; nothing
  else about your library leaves your machine.
- **Manual check.** Click **Check for Updates…** in the app menu (next to
  Settings) or in **Settings → Updates**. If you're already current it says so; if the check fails (for
  example, you're offline), the error is shown inline and nothing else
  changes.
- **Turn it off.** The **Check for updates automatically** switch in
  **Settings → Updates** stops the background checks. Manual checks keep
  working.

## Installing an update

The update dialog shows your current version, the new version and the
release notes. Choose:

- **Download & Install** — downloads the update with a progress bar. When it
  finishes, **Restart now** applies it immediately; if you keep working, the
  update installs automatically the next time you quit.
- **Later** — closes the dialog; the next background check offers the update
  again.
- **Skip this version** — stops offering exactly this release until a newer
  one ships (or until you click **Offer again** in Settings → Updates).

## Platform notes

| Platform | Updates via |
| --- | --- |
| macOS | The update archive published with the macOS release |
| Windows | The NSIS installer |
| Linux | The AppImage build — `.deb` installs can't update themselves and link to the releases page instead |
