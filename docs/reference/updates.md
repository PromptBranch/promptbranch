# Updates

PromptBranch v0.1 uses manual desktop updates. Release pages contain only
user-installable files, so updater metadata and differential-update block maps
are intentionally not published. Download newer versions from the project's
public GitHub Releases page.

## How it works

- Open [GitHub Releases](https://github.com/PromptBranch/promptbranch/releases).
- Choose the installer whose filename names your operating system and CPU
  architecture.
- Quit PromptBranch, install the new version, and reopen it. Your library stays
  in the same platform-specific application-data directory.

## Installing an update

Download the same package type you originally installed. AppImage users should
replace the old AppImage and restore its executable bit if needed. Debian users
can install the new `.deb` over the existing package.

## Platform notes

| Platform | Updates via |
| --- | --- |
| macOS | DMG or ZIP, installed manually; check the release notes for signing status |
| Windows | NSIS installer, installed manually |
| Linux | AppImage or `.deb`, installed manually |
