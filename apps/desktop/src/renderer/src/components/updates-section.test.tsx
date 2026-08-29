// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { installMockBridge } from "../test/mock-bridge";
import { renderApp } from "../test/render";
import { UpdateDialog } from "./UpdateDialog";
import { UpdatesSection } from "./UpdatesSection";
import type { UpdateCheckResultDto, UpdateStatusDto } from "../../../shared/ipc.js";

const STATUS: UpdateStatusDto = {
  supported: true,
  unsupportedReason: null,
  autoCheckEnabled: true,
  currentVersion: "1.0.0",
  lastCheckAt: null,
  skippedVersion: null,
};

function Section() {
  return (
    <>
      <UpdatesSection />
      <UpdateDialog />
    </>
  );
}

describe("UpdatesSection", () => {
  it("reflects and toggles the automatic-check setting", async () => {
    const bridge = installMockBridge();
    renderApp(<Section />);

    const toggle = await screen.findByRole("switch", { name: "Check for updates automatically" });
    expect(toggle).toHaveAttribute("aria-checked", "true");

    await userEvent.click(toggle);
    expect(bridge.updates.setAutoCheck).toHaveBeenCalledWith(false);
  });

  it("reports an up-to-date manual check inline", async () => {
    const bridge = installMockBridge();
    renderApp(<Section />);

    await userEvent.click(await screen.findByRole("button", { name: /Check for Updates/ }));
    expect(bridge.updates.check).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/You're up to date/)).toBeInTheDocument();
  });

  it("shows manual check failures inline without breaking the app", async () => {
    const bridge = installMockBridge();
    bridge.updates.check.mockResolvedValue({ status: "error", message: "GitHub unreachable" } satisfies UpdateCheckResultDto);
    renderApp(<Section />);

    await userEvent.click(await screen.findByRole("button", { name: /Check for Updates/ }));
    expect(await screen.findByText(/GitHub unreachable/)).toBeInTheDocument();
  });

  it("opens the update dialog when a manual check finds a release", async () => {
    const bridge = installMockBridge();
    bridge.updates.check.mockResolvedValue({
      status: "available",
      currentVersion: "1.0.0",
      version: "1.1.0",
      releaseNotes: "Bug fixes",
      releaseUrl: "https://github.com/PromptBranch/promptbranch/releases/tag/v1.1.0",
    } satisfies UpdateCheckResultDto);
    renderApp(<Section />);

    await userEvent.click(await screen.findByRole("button", { name: /Check for Updates/ }));
    expect(await screen.findByText("Update available — v1.1.0")).toBeInTheDocument();
  });

  it("can re-offer a previously skipped version", async () => {
    const bridge = installMockBridge();
    bridge.updates.getStatus.mockResolvedValue({ ...STATUS, skippedVersion: "1.1.0", currentVersion: "1.0.0" });
    renderApp(<Section />);

    await userEvent.click(await screen.findByRole("button", { name: "Offer again" }));
    expect(bridge.updates.skipVersion).toHaveBeenCalledWith(null);
  });

  it("explains why updates are unavailable instead of offering a check", async () => {
    const bridge = installMockBridge();
    bridge.updates.getStatus.mockResolvedValue({
      ...STATUS,
      supported: false,
      unsupportedReason: "linux-package",
    });
    renderApp(<Section />);

    expect(await screen.findByText("This install can't update itself")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Check for Updates/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Open releases page/ })).toBeInTheDocument();
  });
});
