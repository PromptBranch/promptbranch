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

  it("opens GitHub Releases for manual updates", async () => {
    const bridge = installMockBridge();
    renderApp(<AboutDialog open onOpenChange={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: "View Releases" }));
    expect(bridge.app.openExternal).toHaveBeenCalledWith(
      "https://github.com/PromptBranch/promptbranch/releases",
    );
  });
});
