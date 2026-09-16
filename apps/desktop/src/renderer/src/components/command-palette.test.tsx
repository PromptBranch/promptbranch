// @vitest-environment jsdom
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { useAppState } from "../state/app-state";
import { installMockBridge, type MockBridge } from "../test/mock-bridge";
import { renderApp } from "../test/render";
import { CommandPalette } from "./CommandPalette";

function PaletteHarness() {
  const {
    view,
    setView,
    selectedPromptId,
    selectPrompt,
    viewingVersionId,
    setViewingVersionId,
    setPaletteOpen,
  } = useAppState();

  useEffect(() => {
    setView({ kind: "history" });
    selectPrompt("old-prompt");
    setViewingVersionId("old-version");
    setPaletteOpen(true);
  }, [selectPrompt, setPaletteOpen, setView, setViewingVersionId]);

  return (
    <>
      <CommandPalette />
      <output data-testid="navigation-state">
        {view.kind}:{selectedPromptId ?? "none"}:{viewingVersionId ?? "preferred"}
      </output>
    </>
  );
}

let bridge: MockBridge;

beforeEach(() => {
  bridge = installMockBridge();
});

describe("CommandPalette prompt loading", () => {
  it("shows each prompt once when full-text search returns multiple matching versions", async () => {
    bridge.search.mockResolvedValue([
      { promptId: "prompt-1", title: "Release notes", snippet: "Match in v3" },
      { promptId: "prompt-1", title: "Release notes", snippet: "Match in v1" },
    ]);
    const user = userEvent.setup();
    renderApp(<PaletteHarness />);

    await user.type(await screen.findByPlaceholderText("Search prompts, or pick a command…"), "release");

    await waitFor(() => expect(bridge.search).toHaveBeenCalledWith("release"));
    expect(await screen.findAllByText("Release notes")).toHaveLength(1);
  });

  it("opens a search result in Library on the prompt's preferred version", async () => {
    bridge.search.mockResolvedValue([
      { promptId: "prompt-1", title: "Release notes", snippet: "Match in an old version" },
    ]);
    const user = userEvent.setup();
    renderApp(<PaletteHarness />);

    await user.type(await screen.findByPlaceholderText("Search prompts, or pick a command…"), "release");
    await user.click(await screen.findByText("Release notes"));

    expect(screen.getByTestId("navigation-state")).toHaveTextContent(
      "library:prompt-1:preferred",
    );
  });
});
