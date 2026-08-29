// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { installMockBridge } from "../test/mock-bridge";
import { renderApp } from "../test/render";
import { AboutDialog } from "./AboutDialog";

describe("AboutDialog", () => {
  it("renders the PromptBranch brand and opens website", async () => {
    const bridge = installMockBridge();
    renderApp(<AboutDialog open onOpenChange={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "PromptBranch" })).toBeInTheDocument();

    const websiteBtn = screen.getByRole("button", { name: /https:\/\/promptbranch\.app\// });
    expect(websiteBtn).toBeInTheDocument();

    await userEvent.click(websiteBtn);
    expect(bridge.app.openExternal).toHaveBeenCalledWith("https://promptbranch.app/");
  });

  it("opens the in-app open-source licenses dialog", async () => {
    const bridge = installMockBridge();
    renderApp(<AboutDialog open onOpenChange={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: "Open Source Licenses" }));
    expect(await screen.findByRole("heading", { name: "Open Source Licenses" })).toBeInTheDocument();
    expect(bridge.app.licensesText).toHaveBeenCalled();
  });

  it("runs a manual update check from the About dialog", async () => {
    const bridge = installMockBridge();
    renderApp(<AboutDialog open onOpenChange={vi.fn()} />);

    await userEvent.click(await screen.findByRole("button", { name: "Check for Updates…" }));
    expect(bridge.updates.check).toHaveBeenCalledTimes(1);
  });

  it("hides the check button when this build can't self-update", async () => {
    const bridge = installMockBridge();
    bridge.updates.getStatus.mockResolvedValue({
      supported: false,
      unsupportedReason: "dev-build",
      autoCheckEnabled: true,
      currentVersion: "0.0.0-test",
      lastCheckAt: null,
      skippedVersion: null,
    });
    renderApp(<AboutDialog open onOpenChange={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "PromptBranch" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Check for Updates…" })).not.toBeInTheDocument();
  });
});

