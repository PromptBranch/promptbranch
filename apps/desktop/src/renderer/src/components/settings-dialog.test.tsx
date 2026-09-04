// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { describe, expect, it } from "vitest";
import { useAppState } from "../state/app-state";
import { installMockBridge } from "../test/mock-bridge";
import { renderApp } from "../test/render";
import { SettingsDialog } from "./SettingsDialog";

function OpenSettingsWithSection({ section }: { section: "agent" | "about" }) {
  const { openSettings } = useAppState();
  useEffect(() => {
    openSettings(section);
  }, [openSettings, section]);
  return <SettingsDialog />;
}

describe("SettingsDialog Agent integration section", () => {
  it("generates a portable MCP client config with the published package", async () => {
    const bridge = installMockBridge();
    bridge.app.info.mockResolvedValue({
      version: "0.0.0-test",
      dbPath: "/tmp/library.db",
      mcpServerPath: "/repo/packages/mcp/dist/index.js",
      electronVersion: "",
      chromeVersion: "",
      nodeVersion: "",
    });
    renderApp(<OpenSettingsWithSection section="agent" />);
    const config = await screen.findByText(/"mcpServers"/);
    expect(config.textContent).toContain('"promptbranch"');
    expect(config.textContent).toContain('"command": "npx"');
    expect(config.textContent).toContain('"@promptbranch/mcp@latest"');
    expect(config.textContent).not.toContain('"@promptbranch/mcp"');
    expect(config.textContent).not.toContain("/repo/packages/mcp/dist/index.js");
    expect(config.textContent).not.toContain("prompthub");
    expect(screen.getByText(/npx -y @promptbranch\/cli@latest get/)).toBeInTheDocument();
  });
});

describe("SettingsDialog About section", () => {
  it("renders the website link and opens promptbranch.app", async () => {
    const bridge = installMockBridge();
    renderApp(<OpenSettingsWithSection section="about" />);
    const websiteLinks = await screen.findAllByRole("button", { name: /promptbranch\.app/ });
    expect(websiteLinks.length).toBeGreaterThanOrEqual(1);

    await userEvent.click(websiteLinks[0]!);
    expect(bridge.app.openExternal).toHaveBeenCalledWith("https://promptbranch.app/");
  });

  it("opens the in-app open-source licenses dialog", async () => {
    installMockBridge();
    renderApp(<OpenSettingsWithSection section="about" />);

    await userEvent.click(await screen.findByRole("button", { name: "Open Source Licenses" }));
    expect(await screen.findByRole("heading", { name: "Open Source Licenses" })).toBeInTheDocument();
  });
});
