// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { describe, expect, it } from "vitest";
import { useAppState } from "../state/app-state";
import { installMockBridge } from "../test/mock-bridge";
import { renderApp } from "../test/render";
import { LeftRail } from "./LeftRail";
import { UpdateDialog } from "./UpdateDialog";

const RELEASE = {
  currentVersion: "1.0.0",
  version: "1.1.0",
  releaseNotes: null,
  releaseUrl: "https://github.com/PromptBranch/promptbranch/releases/tag/v1.1.0",
} as const;

/** The rail once a release is known but the dialog hasn't been opened. */
function RailWithPendingUpdate() {
  const { setUpdateAvailable } = useAppState();
  useEffect(() => {
    setUpdateAvailable(RELEASE);
  }, [setUpdateAvailable]);
  return <LeftRail collapsed={false} onToggleCollapse={() => {}} />;
}

/** The rail as the app shows it once a check finds a release. */
function RailWithUpdate() {
  const { openUpdateDialog } = useAppState();
  useEffect(() => {
    openUpdateDialog(RELEASE);
  }, [openUpdateDialog]);
  return (
    <>
      <LeftRail collapsed={false} onToggleCollapse={() => {}} />
      <UpdateDialog />
    </>
  );
}

describe("LeftRail update badge", () => {
  it("shows an update badge next to the settings gear", async () => {
    installMockBridge();
    renderApp(<RailWithPendingUpdate />);

    expect(await screen.findByRole("button", { name: "Update available — v1.1.0" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
  });

  it("keeps the badge after postponing the dialog and reopens it on click", async () => {
    installMockBridge();
    renderApp(<RailWithUpdate />);

    // Postpone: dialog closes, badge stays.
    await userEvent.click(await screen.findByRole("button", { name: "Later" }));
    expect(screen.queryByText("Update available — v1.1.0")).not.toBeInTheDocument();
    const badge = screen.getByRole("button", { name: "Update available — v1.1.0" });
    expect(badge).toBeInTheDocument();

    await userEvent.click(badge);
    expect(await screen.findByRole("heading", { name: "Update available — v1.1.0" })).toBeInTheDocument();
  });
});
