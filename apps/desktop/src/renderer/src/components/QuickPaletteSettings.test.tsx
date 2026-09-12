// @vitest-environment jsdom
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import type { QuickPaletteState } from "../../../shared/ipc.js";
import { installMockBridge, type MockBridge } from "../test/mock-bridge";
import { renderApp } from "../test/render";
import { QuickPaletteSettings } from "./QuickPaletteSettings";

const DISABLED: QuickPaletteState = {
  settings: { enabled: false, accelerator: "CommandOrControl+Shift+Space" },
  registration: "disabled",
  registrationError: null,
  sessionId: null,
};

let bridge: MockBridge;

beforeEach(() => {
  bridge = installMockBridge();
  bridge.quickPalette.getState.mockResolvedValue(DISABLED);
});

describe("QuickPaletteSettings", () => {
  it("loads default-off settings and explains the explicit-copy behavior", async () => {
    renderApp(<QuickPaletteSettings />);

    expect(await screen.findByRole("switch", { name: "Enable global shortcut" })).not.toBeChecked();
    expect(screen.getByLabelText("Global shortcut")).toHaveValue("CommandOrControl+Shift+Space");
    expect(screen.getByText("Disabled")).toBeInTheDocument();
    expect(screen.getByText(/copies only when you explicitly choose Copy/)).toBeInTheDocument();
  });

  it("enables and saves a registered shortcut", async () => {
    const user = userEvent.setup();
    bridge.quickPalette.updateSettings.mockResolvedValue({
      ...DISABLED,
      settings: { enabled: true, accelerator: "CommandOrControl+Alt+P" },
      registration: "registered",
    });
    renderApp(<QuickPaletteSettings />);
    const toggle = await screen.findByRole("switch", { name: "Enable global shortcut" });
    await user.click(toggle);
    const field = screen.getByLabelText("Global shortcut");
    await user.clear(field);
    await user.type(field, "CommandOrControl+Alt+P");
    await user.click(screen.getByRole("button", { name: "Save quick access" }));

    expect(bridge.quickPalette.updateSettings).toHaveBeenCalledWith({
      enabled: true,
      accelerator: "CommandOrControl+Alt+P",
    });
    expect(await screen.findByText("Registered")).toBeInTheDocument();
  });

  it("shows a conflict and restores the still-working previous binding", async () => {
    const user = userEvent.setup();
    bridge.quickPalette.getState.mockResolvedValue({
      ...DISABLED,
      settings: { enabled: true, accelerator: "CommandOrControl+Alt+P" },
      registration: "registered",
    });
    bridge.quickPalette.updateSettings.mockResolvedValue({
      ...DISABLED,
      settings: { enabled: true, accelerator: "CommandOrControl+Alt+P" },
      registration: "registered",
      registrationError: "The shortcut CommandOrControl+Shift+Space is unavailable.",
    });
    renderApp(<QuickPaletteSettings />);
    const field = await screen.findByLabelText("Global shortcut");
    await user.clear(field);
    await user.type(field, "CommandOrControl+Shift+Space");
    await user.click(screen.getByRole("button", { name: "Save quick access" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("unavailable");
    expect(field).toHaveValue("CommandOrControl+Alt+P");
    expect(screen.getByText("Registered")).toBeInTheDocument();
  });

  it("recovers from a transient settings-load failure", async () => {
    const user = userEvent.setup();
    bridge.quickPalette.getState
      .mockRejectedValueOnce(new Error("IPC unavailable"))
      .mockResolvedValueOnce(DISABLED);
    renderApp(<QuickPaletteSettings />);

    await user.click(await screen.findByRole("button", { name: "Try loading again" }));

    expect(await screen.findByRole("switch", { name: "Enable global shortcut" })).toBeInTheDocument();
    expect(bridge.quickPalette.getState).toHaveBeenCalledTimes(2);
  });

  it("retains edits after a transient save failure and retries", async () => {
    const user = userEvent.setup();
    bridge.quickPalette.updateSettings
      .mockRejectedValueOnce(new Error("save failed"))
      .mockResolvedValueOnce({
        ...DISABLED,
        settings: { enabled: true, accelerator: "CommandOrControl+Alt+P" },
        registration: "registered",
      });
    renderApp(<QuickPaletteSettings />);
    await user.click(await screen.findByRole("switch", { name: "Enable global shortcut" }));
    const field = screen.getByLabelText("Global shortcut");
    await user.clear(field);
    await user.type(field, "CommandOrControl+Alt+P");
    await user.click(screen.getByRole("button", { name: "Save quick access" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be saved/i);
    expect(field).toHaveValue("CommandOrControl+Alt+P");
    await user.click(screen.getByRole("button", { name: "Try saving again" }));
    await waitFor(() => expect(screen.getByText("Registered")).toBeInTheDocument());
    expect(bridge.quickPalette.updateSettings).toHaveBeenCalledTimes(2);
  });

  it("disables a previously registered shortcut", async () => {
    const user = userEvent.setup();
    bridge.quickPalette.getState.mockResolvedValue({
      ...DISABLED,
      settings: { enabled: true, accelerator: "CommandOrControl+Alt+P" },
      registration: "registered",
    });
    bridge.quickPalette.updateSettings.mockResolvedValue({
      ...DISABLED,
      settings: { enabled: false, accelerator: "CommandOrControl+Alt+P" },
    });
    renderApp(<QuickPaletteSettings />);
    await user.click(await screen.findByRole("switch", { name: "Enable global shortcut" }));
    await user.click(screen.getByRole("button", { name: "Save quick access" }));

    expect(bridge.quickPalette.updateSettings).toHaveBeenCalledWith({
      enabled: false,
      accelerator: "CommandOrControl+Alt+P",
    });
    expect(await screen.findByText("Disabled")).toBeInTheDocument();
  });
});
