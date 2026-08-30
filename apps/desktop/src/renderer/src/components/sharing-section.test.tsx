// @vitest-environment jsdom
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { installMockBridge, type MockBridge } from "../test/mock-bridge";
import { renderApp } from "../test/render";
import { useAppState } from "../state/app-state";
import { SharingSection } from "./SharingSection";

let bridge: MockBridge;

beforeEach(() => {
  bridge = installMockBridge();
  bridge.share.list.mockResolvedValue([]);
  bridge.share.getPortalBaseUrl.mockResolvedValue("https://promptbranch.app");
});

// The "Manage shares" hand-off is driven through app state (close settings,
// switch view); this probe makes that transition observable in the test.
function StateProbe() {
  const { view, settingsOpen } = useAppState();
  return <span data-testid="state-probe" data-view={view.kind} data-settings-open={String(settingsOpen)} />;
}

describe("SharingSection", () => {
  it("shows the portal base URL and saves edits", async () => {
    bridge.share.setPortalBaseUrl.mockResolvedValue("http://192.168.1.20:3000");
    const user = userEvent.setup();
    renderApp(<SharingSection />);
    const input = await screen.findByLabelText("Portal base URL");
    await waitFor(() => expect(input).toHaveValue("https://promptbranch.app"));

    await user.clear(input);
    await user.type(input, "http://192.168.1.20:3000");
    await user.click(screen.getByRole("button", { name: "Save portal URL" }));
    expect(bridge.share.setPortalBaseUrl).toHaveBeenCalledWith("http://192.168.1.20:3000");
  });

  it("summarizes share counts and hands off to the Shares view", async () => {
    bridge.share.list.mockResolvedValue([
      {
        snapshotId: "V1StGXR8_Z5jdHi6B-myT",
        promptId: "prompt-1",
        promptTitle: "Greeting",
        portalBaseUrl: "https://promptbranch.app",
        url: "https://promptbranch.app/p/V1StGXR8_Z5jdHi6B-myT",
        fullHistory: false,
        publishedAt: "2026-08-25T12:00:00.000Z",
        deletedAt: null,
      },
      {
        snapshotId: "AAAAAAAAAAAAAAAAAAAAA",
        promptId: "prompt-2",
        promptTitle: "Old prompt",
        portalBaseUrl: "https://promptbranch.app",
        url: "https://promptbranch.app/p/AAAAAAAAAAAAAAAAAAAAA",
        fullHistory: false,
        publishedAt: "2026-08-20T12:00:00.000Z",
        deletedAt: "2026-08-26T09:00:00.000Z",
      },
    ]);
    const user = userEvent.setup();
    renderApp(
      <>
        <StateProbe />
        <SharingSection />
      </>,
    );
    expect(await screen.findByText("1 active share, 1 revoked")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Manage shares/ }));
    const probe = screen.getByTestId("state-probe");
    expect(probe).toHaveAttribute("data-view", "shares");
    expect(probe).toHaveAttribute("data-settings-open", "false");
  });

  it("offers the manage hand-off even when nothing is published", async () => {
    renderApp(<SharingSection />);
    expect(await screen.findByText(/Nothing published yet/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Manage shares/ })).toBeInTheDocument();
  });
});
