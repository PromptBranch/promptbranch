# Updates

PromptBranch v0.1 uses manual desktop updates. The app does not check GitHub
for a newer version or compare versions for you. It never checks for updates
in the background, and it never downloads, installs, or applies an update.

## Check for an update manually

- Open **About PromptBranch** and note the installed `Version` shown there.
- Open **Settings → Updates** and select **Open GitHub Releases**. You can also
  select **View Releases** in About, choose **GitHub Releases…** from the app
  menu, or open
  [GitHub Releases](https://github.com/PromptBranch/promptbranch/releases)
  directly.
- Manually compare the installed version with the latest public release.
- If the public release is newer, choose the macOS installer for your CPU
  architecture.
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
