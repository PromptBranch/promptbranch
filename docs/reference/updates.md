# Updates

PromptBranch v0.1 uses manual desktop updates. Its version check runs only
when you ask for it: the app checks the latest public GitHub release version
and, after your confirmation, can open the public GitHub Releases page. It
never downloads, installs, or applies an update, and it never checks for
updates in the background.

## How it works

- Run the app's version check, or open
  [GitHub Releases](https://github.com/PromptBranch/promptbranch/releases)
  directly.
- If a newer version is available, confirm that you want to open the release
  page.
- Choose the macOS installer for your CPU architecture.
- Quit PromptBranch, install the new version, and reopen it. Your library stays
  in the same application-data directory.

## Installing an update

Download the same package type you originally installed: DMG or ZIP. Choose
the arm64 build for Apple Silicon or the x64 build for an Intel Mac.

## Platform notes

| Platform | Desktop availability |
| --- | --- |
| macOS | DMG or ZIP for arm64 and x64, installed manually |
| Windows | Planned; no desktop build is available in 0.1.0 |
| Linux | Planned; no desktop build is available in 0.1.0 |
