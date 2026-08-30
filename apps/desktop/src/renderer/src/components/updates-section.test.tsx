// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { describe, expect, it } from "vitest";
import type { UpdateStateDto } from "../../../shared/ipc.js";
import { useAppState } from "../state/app-state";
import { installMockBridge } from "../test/mock-bridge";
import { renderApp } from "../test/render";
import { SettingsDialog } from "./SettingsDialog";
import { UpdatesSection } from "./UpdatesSection";

const NOT_CHECKED: UpdateStateDto = {
  status: "not-checked",
  currentVersion: "0.1.0",
  latestVersion: null,
  platform: "macOS",
  architecture: "arm64",
  automaticChecksEnabled: true,
  lastCheckedAt: null,
  checkSource: null,
  releaseName: null,
  releaseNotes: null,
  publishedAt: null,
  assets: [],
  errorMessage: null,
};

const UP_TO_DATE: UpdateStateDto = {
  ...NOT_CHECKED,
  status: "up-to-date",
  latestVersion: "0.1.0",
  lastCheckedAt: new Date().toISOString(),
};

const AVAILABLE: UpdateStateDto = {
  ...NOT_CHECKED,
  status: "update-available",
  latestVersion: "0.2.0",
  lastCheckedAt: new Date().toISOString(),
  releaseName: "PromptBranch 0.2.0",
  releaseNotes: "Highlights\n\n- Faster prompt search\n- Improved sync status",
  publishedAt: "2026-08-31T10:00:00.000Z",
  assets: [
    {
      name: "promptbranch_0.2.0_macos_arm64.dmg",
      label: "macOS disk image",
      kind: "dmg",
      sizeBytes: 12_345,
      recommended: true,
    },
  ],
};

function renderState(state: UpdateStateDto) {
  const bridge = installMockBridge();
  bridge.updates.getState.mockResolvedValue(state);
  renderApp(<UpdatesSection />);
  return bridge;
}

function OpenUpdatesSettings() {
  const { openSettings, settingsOpen } = useAppState();
  useEffect(() => openSettings("updates"), [openSettings]);
  return (
    <>
      <SettingsDialog />
      <span data-testid="settings-state" data-open={String(settingsOpen)} />
    </>
  );
}

describe("UpdatesSection", () => {
  it("shows installed build details and checks on demand", async () => {
    const user = userEvent.setup();
    const bridge = renderState(NOT_CHECKED);
    bridge.updates.check.mockResolvedValue(UP_TO_DATE);

    expect(await screen.findByText("Ready to check")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Ready to check");
    expect(screen.getByText("0.1.0")).toBeInTheDocument();
    expect(screen.getByText("macOS · arm64")).toBeInTheDocument();
    expect(screen.getByText("Never")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Check for Updates" }));

    expect(bridge.updates.check).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("PromptBranch is up to date")).toBeInTheDocument();
  });

  it("disables duplicate checks while one is running", async () => {
    renderState({ ...NOT_CHECKED, status: "checking", checkSource: "manual" });

    expect(await screen.findByText("Checking for updates…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled();
  });

  it("shows release notes and opens the exact validated download", async () => {
    const user = userEvent.setup();
    const bridge = renderState(AVAILABLE);

    expect(await screen.findByText("PromptBranch 0.2.0 is available")).toBeInTheDocument();
    expect(screen.getByText(/Faster prompt search/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Check Again" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Download Update" }));
    expect(bridge.updates.openDownload).toHaveBeenCalledWith(
      "promptbranch_0.2.0_macos_arm64.dmg",
    );

    await user.click(screen.getByRole("button", { name: "Full release notes" }));
    expect(bridge.updates.openReleaseNotes).toHaveBeenCalledTimes(1);
  });

  it("offers both matching Linux package types", async () => {
    const user = userEvent.setup();
    const bridge = renderState({
      ...AVAILABLE,
      platform: "Linux",
      architecture: "x64",
      assets: [
        {
          name: "promptbranch_0.2.0_linux_x64.AppImage",
          label: "Linux AppImage",
          kind: "appimage",
          sizeBytes: 12_345,
          recommended: true,
        },
        {
          name: "promptbranch_0.2.0_linux_x64.deb",
          label: "Debian package",
          kind: "deb",
          sizeBytes: 11_234,
          recommended: false,
        },
      ],
    });

    await user.click(await screen.findByRole("button", { name: "Download AppImage" }));
    await user.click(screen.getByRole("button", { name: "Download .deb" }));

    expect(bridge.updates.openDownload).toHaveBeenNthCalledWith(
      1,
      "promptbranch_0.2.0_linux_x64.AppImage",
    );
    expect(bridge.updates.openDownload).toHaveBeenNthCalledWith(
      2,
      "promptbranch_0.2.0_linux_x64.deb",
    );
  });

  it("shows an actionable missing-installer state", async () => {
    const bridge = renderState({
      ...AVAILABLE,
      status: "no-compatible-download",
      assets: [],
      platform: "Windows",
      architecture: "arm64",
    });
    expect(await screen.findByText("No compatible installer")).toBeInTheDocument();
    expect(screen.getByText(/Windows arm64/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Download/ })).not.toBeInTheDocument();
    expect(bridge.updates.openDownload).not.toHaveBeenCalled();
  });

  it("retries after a failed check", async () => {
    const user = userEvent.setup();
    const bridge = renderState({
      ...NOT_CHECKED,
      status: "error",
      lastCheckedAt: new Date().toISOString(),
      checkSource: "manual",
      errorMessage: "Could not reach the update service (HTTP 500).",
    });
    bridge.updates.check.mockResolvedValue(UP_TO_DATE);

    expect(await screen.findByText("Couldn’t check for updates")).toBeInTheDocument();
    expect(screen.getByText(/HTTP 500/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try Again" }));
    expect(await screen.findByText("PromptBranch is up to date")).toBeInTheDocument();
  });

  it("persists the automatic-check toggle through the main process", async () => {
    const user = userEvent.setup();
    const bridge = renderState(NOT_CHECKED);
    bridge.updates.setAutomaticChecks.mockResolvedValue({
      ...NOT_CHECKED,
      automaticChecksEnabled: false,
    });

    const toggle = await screen.findByRole("switch", {
      name: "Automatically check for updates",
    });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    await user.click(toggle);

    expect(bridge.updates.setAutomaticChecks).toHaveBeenCalledWith(false);
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  it("closes Settings when an available update is postponed", async () => {
    const user = userEvent.setup();
    const bridge = installMockBridge();
    bridge.updates.getState.mockResolvedValue(AVAILABLE);
    renderApp(<OpenUpdatesSettings />);

    expect(await screen.findByText("PromptBranch 0.2.0 is available")).toBeInTheDocument();
    expect(screen.getByTestId("settings-state")).toHaveAttribute("data-open", "true");
    await user.click(screen.getByRole("button", { name: "Later" }));
    expect(screen.getByTestId("settings-state")).toHaveAttribute("data-open", "false");
  });
});
