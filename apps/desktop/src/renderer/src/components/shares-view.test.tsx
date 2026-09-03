// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import type { SharedSnapshotDto } from "../../../shared/ipc.js";
import { installMockBridge, type MockBridge } from "../test/mock-bridge";
import { renderApp } from "../test/render";
import { SharesView } from "./SharesView";

const activeShare: SharedSnapshotDto = {
  snapshotId: "V1StGXR8_Z5jdHi6B-myT",
  promptId: "prompt-1",
  promptTitle: "Greeting",
  portalBaseUrl: "https://promptbranch.app",
  url: "https://promptbranch.app/p/V1StGXR8_Z5jdHi6B-myT",
  fullHistory: false,
  publishedAt: "2026-08-25T12:00:00.000Z",
  deletedAt: null,
};

const revokedShare: SharedSnapshotDto = {
  ...activeShare,
  snapshotId: "AAAAAAAAAAAAAAAAAAAAA",
  promptId: null, // prompt hard-deleted after publishing (migration v5 SET NULL)
  promptTitle: "Old prompt",
  url: "https://promptbranch.app/p/AAAAAAAAAAAAAAAAAAAAA",
  publishedAt: "2026-08-20T12:00:00.000Z",
  deletedAt: "2026-08-26T09:00:00.000Z",
};

const fullHistoryShare: SharedSnapshotDto = {
  ...activeShare,
  snapshotId: "BBBBBBBBBBBBBBBBBBBBB",
  promptTitle: "Versioned prompt",
  url: "https://others-portal.local:8443/p/BBBBBBBBBBBBBBBBBBBBB",
  portalBaseUrl: "https://others-portal.local:8443",
  fullHistory: true,
  publishedAt: "2026-08-24T12:00:00.000Z",
};

function seed(...shares: SharedSnapshotDto[]) {
  bridge.share.list.mockResolvedValue(shares);
}

let bridge: MockBridge;

beforeEach(() => {
  bridge = installMockBridge();
  bridge.share.list.mockResolvedValue([]);
});

describe("SharesView", () => {
  it("lists shares with status badges, host and relative publish date", async () => {
    seed(activeShare, revokedShare, fullHistoryShare);
    renderApp(<SharesView />);

    const greeting = await screen.findByText("Greeting");
    const revokedRow = screen.getByText("Old prompt").closest("li")!;
    const versionedRow = screen.getByText("Versioned prompt").closest("li")!;

    expect(within(versionedRow).getByText("Full history")).toBeInTheDocument();
    expect(within(revokedRow).getByText("Revoked")).toBeInTheDocument();
    expect(within(revokedRow).getByText(/Source deleted/)).toBeInTheDocument();
    // Portal host comes from each share's own stored URL, not one global.
    expect(within(versionedRow).getAllByText(/others-portal\.local:8443/).length).toBeGreaterThan(0);
    expect(within(revokedRow).getByText(/revoked/)).toBeInTheDocument();
    // Title of a live share navigates to the prompt; a deleted source does not.
    expect(greeting.tagName).toBe("BUTTON");
    expect(screen.getByText("Old prompt").tagName).toBe("SPAN");
    expect(screen.getByText(/2 active · 1 revoked/)).toBeInTheDocument();
  });

  it("searches by title and by URL", async () => {
    seed(activeShare, revokedShare, fullHistoryShare);
    const user = userEvent.setup();
    renderApp(<SharesView />);

    const input = screen.getByLabelText("Search shares");
    await user.type(input, "greet");
    expect(screen.getByText("Greeting")).toBeInTheDocument();
    expect(screen.queryByText("Old prompt")).not.toBeInTheDocument();

    await user.clear(input);
    await user.type(input, "others-portal.local");
    expect(screen.getByText("Versioned prompt")).toBeInTheDocument();
    expect(screen.queryByText("Greeting")).not.toBeInTheDocument();
  });

  it("filters by status with the segmented control", async () => {
    seed(activeShare, revokedShare);
    const user = userEvent.setup();
    renderApp(<SharesView />);
    await screen.findByText("Greeting");

    await user.click(screen.getByRole("button", { name: "Active" }));
    expect(screen.getByText("Greeting")).toBeInTheDocument();
    expect(screen.queryByText("Old prompt")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Revoked" }));
    expect(screen.getByText("Old prompt")).toBeInTheDocument();
    expect(screen.queryByText("Greeting")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getByText("Greeting")).toBeInTheDocument();
    expect(screen.getByText("Old prompt")).toBeInTheDocument();
  });

  it("sorts by title when chosen", async () => {
    seed(fullHistoryShare, activeShare);
    const user = userEvent.setup();
    renderApp(<SharesView />);
    await screen.findByText("Greeting");
    expect(screen.getByText("Versioned prompt").closest("li")!).toHaveTextContent(/Versioned prompt/);

    await user.selectOptions(screen.getByLabelText("Sort shares"), "title");
    const titles = screen
      .getAllByRole("button")
      .filter((button) => ["Greeting", "Versioned prompt"].includes(button.textContent ?? ""))
      .map((button) => button.textContent);
    expect(titles.indexOf("Greeting")).toBeLessThan(titles.indexOf("Versioned prompt"));
  });

  it("opens the share link in the system browser via the main process", async () => {
    seed(activeShare, revokedShare);
    const user = userEvent.setup();
    renderApp(<SharesView />);
    await screen.findByText("Greeting");

    // Electron denies window.open: the action must go through app.openExternal.
    await user.click(screen.getByRole("button", { name: `Open ${activeShare.promptTitle} in browser` }));
    expect(bridge.app.openExternal).toHaveBeenCalledWith(activeShare.url);
  });

  it("revokes an active share after confirmation", async () => {
    seed(activeShare, revokedShare);
    const user = userEvent.setup();
    renderApp(<SharesView />);
    await screen.findByText("Greeting");

    await user.click(screen.getByRole("button", { name: `Revoke share of ${activeShare.promptTitle}` }));
    const confirm = await screen.findByRole("alertdialog");
    await user.click(within(confirm).getByRole("button", { name: "Revoke share" }));
    await waitFor(() => expect(bridge.share.delete).toHaveBeenCalledWith(activeShare.snapshotId));
  });

  it("permanently removes a revoked share after confirmation", async () => {
    seed(activeShare, revokedShare);
    const user = userEvent.setup();
    renderApp(<SharesView />);
    await screen.findByText("Old prompt");

    await user.click(
      screen.getByRole("button", { name: `Permanently remove share of ${revokedShare.promptTitle}` }),
    );
    const confirm = await screen.findByRole("alertdialog");
    await user.click(within(confirm).getByRole("button", { name: "Remove permanently" }));

    await waitFor(() =>
      expect(bridge.share.removeRevoked).toHaveBeenCalledWith(revokedShare.snapshotId),
    );
    expect(bridge.share.delete).not.toHaveBeenCalledWith(revokedShare.snapshotId);
  });

  it("shows the empty state when nothing is published", async () => {
    renderApp(<SharesView />);
    expect(await screen.findByText("Nothing published yet")).toBeInTheDocument();
  });

  it("shows a no-match state when filters exclude every share", async () => {
    seed(activeShare);
    const user = userEvent.setup();
    renderApp(<SharesView />);
    await screen.findByText("Greeting");

    await user.type(screen.getByLabelText("Search shares"), "zzz-no-match");
    expect(await screen.findByText("No matching shares")).toBeInTheDocument();
  });
});
