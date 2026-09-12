// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

function usePlatform(platform: string): void {
  vi.spyOn(window.navigator, "platform", "get").mockReturnValue(platform);
}

beforeEach(() => {
  vi.restoreAllMocks();
  bridge = installMockBridge();
  bridge.quickPalette.getState.mockResolvedValue(DISABLED);
});

describe("QuickPaletteSettings", () => {
  it("shows a readable shortcut without exposing accelerator implementation details", async () => {
    renderApp(<QuickPaletteSettings />);

    expect(await screen.findByRole("switch", { name: "Enable global shortcut" })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Keyboard shortcut" })).toHaveTextContent(
      "Ctrl + Shift + Space",
    );
    expect(screen.queryByText(/Electron accelerator format/i)).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue(/CommandOrControl/)).not.toBeInTheDocument();
    expect(screen.getByText("Disabled")).toBeInTheDocument();
    expect(screen.getByText(/copies only when you explicitly choose Copy/)).toBeInTheDocument();
  });

  it("records a readable key combination and saves its internal binding", async () => {
    const user = userEvent.setup();
    bridge.quickPalette.updateSettings.mockResolvedValue({
      ...DISABLED,
      settings: { enabled: true, accelerator: "Control+Alt+P" },
      registration: "registered",
    });
    renderApp(<QuickPaletteSettings />);
    const toggle = await screen.findByRole("switch", { name: "Enable global shortcut" });
    await user.click(toggle);
    await user.click(screen.getByRole("button", { name: "Record new shortcut" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "Keyboard shortcut" }), {
      key: "p",
      ctrlKey: true,
      altKey: true,
    });
    expect(screen.getByRole("button", { name: "Keyboard shortcut" })).toHaveTextContent(
      "Ctrl + Alt + P",
    );
    await user.click(screen.getByRole("button", { name: "Save quick access" }));

    expect(bridge.quickPalette.updateSettings).toHaveBeenCalledWith({
      enabled: true,
      accelerator: "Control+Alt+P",
    });
    expect(await screen.findByText("Registered")).toBeInTheDocument();
  });

  it.each([
    {
      platform: "MacIntel",
      saved: "Command+P",
      displayed: "⌘ P",
    },
    {
      platform: "Win32",
      saved: "Super+P",
      displayed: "Win + P",
    },
    {
      platform: "Linux x86_64",
      saved: "Super+P",
      displayed: "Super + P",
    },
  ])("records the native primary key on $platform", async ({ platform, saved, displayed }) => {
    usePlatform(platform);
    const user = userEvent.setup();
    bridge.quickPalette.updateSettings.mockResolvedValue({
      ...DISABLED,
      settings: { enabled: true, accelerator: saved },
      registration: "registered",
    });
    renderApp(<QuickPaletteSettings />);
    await user.click(await screen.findByRole("switch", { name: "Enable global shortcut" }));
    await user.click(screen.getByRole("button", { name: "Record new shortcut" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "Keyboard shortcut" }), {
      key: "p",
      metaKey: true,
    });

    expect(screen.getByRole("button", { name: "Keyboard shortcut" })).toHaveTextContent(
      displayed,
    );
    await user.click(screen.getByRole("button", { name: "Save quick access" }));
    expect(bridge.quickPalette.updateSettings).toHaveBeenCalledWith({
      enabled: true,
      accelerator: saved,
    });
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
      registrationError: "That keyboard shortcut is already in use or unavailable.",
    });
    renderApp(<QuickPaletteSettings />);
    await screen.findByRole("button", { name: "Keyboard shortcut" });
    await user.click(screen.getByRole("button", { name: "Record new shortcut" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "Keyboard shortcut" }), {
      key: " ",
      ctrlKey: true,
      shiftKey: true,
    });
    await user.click(screen.getByRole("button", { name: "Save quick access" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("unavailable");
    expect(screen.getByRole("button", { name: "Keyboard shortcut" })).toHaveTextContent(
      "Ctrl + Alt + P",
    );
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
    await user.click(screen.getByRole("button", { name: "Record new shortcut" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "Keyboard shortcut" }), {
      key: "p",
      ctrlKey: true,
      altKey: true,
    });
    await user.click(screen.getByRole("button", { name: "Save quick access" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be saved/i);
    expect(screen.getByRole("button", { name: "Keyboard shortcut" })).toHaveTextContent(
      "Ctrl + Alt + P",
    );
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

  it("resets a recorded shortcut to the readable default", async () => {
    const user = userEvent.setup();
    bridge.quickPalette.getState.mockResolvedValue({
      ...DISABLED,
      settings: { enabled: true, accelerator: "Control+Alt+P" },
      registration: "registered",
    });
    renderApp(<QuickPaletteSettings />);

    await user.click(await screen.findByRole("button", { name: "Reset to default" }));

    expect(screen.getByRole("button", { name: "Keyboard shortcut" })).toHaveTextContent(
      "Ctrl + Shift + Space",
    );
  });
});
