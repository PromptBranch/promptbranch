// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { describe, expect, it } from "vitest";
import { useAppState } from "../state/app-state";
import { installMockBridge } from "../test/mock-bridge";
import { renderApp } from "../test/render";
import { UpdateDialog } from "./UpdateDialog";

const RELEASE = {
  currentVersion: "1.0.0",
  version: "1.1.0",
  releaseNotes: "## What's new\n\n- Faster prompt search",
  releaseUrl: "https://github.com/PromptBranch/promptbranch/releases/tag/v1.1.0",
} as const;

/** Opens the update dialog the way App.tsx does (background-check hit). */
function OpenUpdateDialog() {
  const { openUpdateDialog } = useAppState();
  useEffect(() => {
    openUpdateDialog(RELEASE);
  }, [openUpdateDialog]);
  return <UpdateDialog />;
}

describe("UpdateDialog", () => {
  it("shows both versions, the release notes and the download actions", async () => {
    installMockBridge();
    renderApp(<OpenUpdateDialog />);

    expect(await screen.findByText("Update available — v1.1.0")).toBeInTheDocument();
    expect(screen.getByText("v1.0.0")).toBeInTheDocument();
    expect(screen.getByText("v1.1.0")).toBeInTheDocument();
    expect(screen.getByText(/Faster prompt search/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download & Install" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Skip this version" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Later" })).toBeInTheDocument();
  });

  it("starts the download and tracks its progress via state events", async () => {
    const bridge = installMockBridge();
    renderApp(<OpenUpdateDialog />);

    await userEvent.click(await screen.findByRole("button", { name: "Download & Install" }));
    expect(bridge.updates.download).toHaveBeenCalledTimes(1);

    bridge.emitUpdateState({
      phase: "downloading",
      progress: { percent: 42, transferred: 10, total: 24, bytesPerSecond: 5120 },
    });
    expect(await screen.findByText(/42%/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue in background" })).toBeInTheDocument();
  });

  it("offers an immediate restart once the download finished", async () => {
    const bridge = installMockBridge();
    renderApp(<OpenUpdateDialog />);

    bridge.emitUpdateState({ phase: "downloaded", version: "1.1.0" });
    const restart = await screen.findByRole("button", { name: "Restart now" });
    await userEvent.click(restart);
    expect(bridge.updates.install).toHaveBeenCalledTimes(1);
  });

  it("persistently skips the version and closes", async () => {
    const bridge = installMockBridge();
    renderApp(<OpenUpdateDialog />);

    await userEvent.click(await screen.findByRole("button", { name: "Skip this version" }));
    expect(bridge.updates.skipVersion).toHaveBeenCalledWith("1.1.0");
    expect(screen.queryByText("Update available — v1.1.0")).not.toBeInTheDocument();
  });
});
