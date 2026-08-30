// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { installMockBridge } from "../test/mock-bridge";
import { renderApp } from "../test/render";
import { UpdatesSection } from "./UpdatesSection";

describe("UpdatesSection", () => {
  it("explains manual updates and opens GitHub Releases", async () => {
    const bridge = installMockBridge();
    renderApp(<UpdatesSection />);

    expect(screen.getByText("Updates are installed manually")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open GitHub Releases" }));
    expect(bridge.app.openExternal).toHaveBeenCalledWith(
      "https://github.com/PromptBranch/promptbranch/releases",
    );
  });
});
