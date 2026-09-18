// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  QuickPaletteItem,
  QuickPaletteSelection,
  QuickPaletteState,
} from "../../../shared/ipc.js";
import { installMockBridge, type MockBridge } from "../test/mock-bridge";
import { renderApp } from "../test/render";
import { QuickPalette } from "./QuickPalette";
import { RendererRoot } from "../RendererRoot";

const INITIAL_STATE: QuickPaletteState = {
  settings: { enabled: false, accelerator: "CommandOrControl+Shift+Space" },
  registration: "disabled",
  registrationError: null,
  sessionId: null,
};

const ITEM: QuickPaletteItem = {
  promptId: "prompt-1",
  title: "Greeting",
  starred: true,
  currentVersionId: "version-1",
  currentVersionLabel: "v1",
  matchedHistory: false,
};

const SELECTION: QuickPaletteSelection = {
  promptId: "prompt-1",
  title: "Greeting",
  versionId: "version-1",
  versionLabel: "v1",
  templateContent: "Hello {{name}} from {{place}}",
  requiredVariables: ["name", "place"],
};

let bridge: MockBridge;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flushSearch(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    vi.advanceTimersByTime(150);
    await Promise.resolve();
  });
}

async function openPalette(sessionId = "session-1"): Promise<void> {
  act(() => bridge.emitQuickPaletteOpen(sessionId));
  await flushSearch();
}

async function selectGreeting(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  bridge.quickPalette.resolve.mockResolvedValue({ ok: true, value: SELECTION });
  await user.click(await screen.findByRole("option", { name: /Greeting/ }));
  await waitFor(() => expect(screen.getByText("Prompt preview")).toBeInTheDocument());
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  bridge = installMockBridge();
  bridge.quickPalette.getState.mockResolvedValue(INITIAL_STATE);
  bridge.quickPalette.search.mockResolvedValue({ ok: true, value: [ITEM] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("QuickPalette sessions and search", () => {
  it("recovers an opening that arrived before subscriptions", async () => {
    bridge.quickPalette.getState.mockResolvedValue({ ...INITIAL_STATE, sessionId: "recovered" });

    renderApp(<QuickPalette />);
    await flushSearch();

    expect(bridge.quickPalette.search).toHaveBeenCalledWith({ sessionId: "recovered", query: "" });
    expect(await screen.findByLabelText("Search prompts")).toHaveFocus();
  });

  it("clears every temporary value on close and a new session", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderApp(<QuickPalette />);
    await openPalette();
    await user.type(screen.getByLabelText("Search prompts"), "private query");
    act(() => bridge.emitQuickPaletteClosed("session-1"));

    expect(screen.queryByLabelText("Search prompts")).not.toBeInTheDocument();
    act(() => bridge.emitQuickPaletteOpen("session-2"));
    await flushSearch();
    expect(screen.getByLabelText("Search prompts")).toHaveValue("");
    expect(bridge.quickPalette.search).toHaveBeenLastCalledWith({ sessionId: "session-2", query: "" });
  });

  it("shows distinct empty-library and no-match states", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    bridge.quickPalette.search.mockResolvedValue({ ok: true, value: [] });
    renderApp(<QuickPalette />);
    await openPalette();
    expect(await screen.findByText("No saved prompts yet")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Search prompts"), "missing");
    await flushSearch();
    expect(await screen.findByText(/No matches for “missing”/)).toBeInTheDocument();
  });

  it("supports arrow navigation, Enter selection, and a saved-history hint", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const second = { ...ITEM, promptId: "prompt-2", title: "Historic", matchedHistory: true };
    bridge.quickPalette.search.mockResolvedValue({ ok: true, value: [ITEM, second] });
    bridge.quickPalette.resolve.mockResolvedValue({
      ok: true,
      value: { ...SELECTION, promptId: "prompt-2", title: "Historic" },
    });
    renderApp(<QuickPalette />);
    await openPalette();

    expect(screen.getByText("Match in saved history")).toBeInTheDocument();
    const input = screen.getByLabelText("Search prompts");
    await user.keyboard("{ArrowDown}{Enter}");

    expect(bridge.quickPalette.resolve).toHaveBeenCalledWith({
      sessionId: "session-1",
      promptId: "prompt-2",
    });
    expect(await screen.findByText("Historic")).toBeInTheDocument();
    expect(input).not.toBeInTheDocument();
  });

  it("discards a late search reply from an older query", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const oldSearch = deferred<Awaited<ReturnType<typeof bridge.quickPalette.search>>>();
    bridge.quickPalette.search
      .mockImplementationOnce(() => oldSearch.promise)
      .mockResolvedValueOnce({ ok: true, value: [{ ...ITEM, title: "New result" }] });
    renderApp(<QuickPalette />);
    act(() => bridge.emitQuickPaletteOpen("session-1"));
    await flushSearch();
    await user.type(screen.getByLabelText("Search prompts"), "new");
    await flushSearch();
    expect(await screen.findByText("New result")).toBeInTheDocument();

    oldSearch.resolve({ ok: true, value: [{ ...ITEM, title: "Old result" }] });
    await act(async () => Promise.resolve());
    expect(screen.queryByText("Old result")).not.toBeInTheDocument();
  });
});

describe("QuickPalette rendering and copy", () => {
  it("shows missing input, then a ready plain-text preview with an opaque copy token", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    bridge.quickPalette.render.mockImplementation(async (input) => {
      const missingVariables = ["name", "place"].filter((name) => !input.variables[name]);
      return missingVariables.length > 0
        ? { ok: true as const, value: { status: "needs-input" as const, missingVariables } }
        : {
            ok: true as const,
            value: {
              status: "ready" as const,
              previewId: "preview-1",
              content: "Hello Ada from Zürich\n$1",
            },
          };
    });
    bridge.quickPalette.copy.mockResolvedValue({ ok: true, value: null });
    renderApp(<QuickPalette />);
    await openPalette();
    await selectGreeting(user);

    expect(await screen.findByText(/Fill all required variables/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy prompt" })).toBeDisabled();
    await user.type(screen.getByLabelText("name"), "Ada");
    await user.type(screen.getByLabelText("place"), "Zürich\n$1");

    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Prompt preview" }).textContent).toBe(
        "Hello Ada from Zürich\n$1",
      ),
    );
    await user.click(screen.getByRole("button", { name: "Copy prompt" }));
    expect(bridge.quickPalette.copy).toHaveBeenCalledWith({
      sessionId: "session-1",
      previewId: "preview-1",
    });
    expect(screen.queryByRole("region", { name: "Prompt preview" })).not.toBeInTheDocument();
  });

  it("renders no-variable prompts immediately and focuses Copy", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    bridge.quickPalette.resolve.mockResolvedValue({
      ok: true,
      value: {
        ...SELECTION,
        templateContent: "Plain saved content",
        requiredVariables: [],
      },
    });
    bridge.quickPalette.render.mockResolvedValue({
      ok: true,
      value: { status: "ready", previewId: "plain-preview", content: "Plain saved content" },
    });
    renderApp(<QuickPalette />);
    await openPalette();
    await user.click(screen.getByRole("option", { name: /Greeting/ }));

    expect(await screen.findByText("Plain saved content")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Copy prompt" })).toHaveFocus());
  });

  it("retains values and preview after copy failure, but stale revisions require refresh", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    bridge.quickPalette.render.mockResolvedValue({
      ok: true,
      value: { status: "ready", previewId: "preview-1", content: "Hello Ada from Paris" },
    });
    bridge.quickPalette.copy.mockResolvedValue({
      ok: false,
      code: "revision-changed",
      message: "The current saved version changed.",
    });
    renderApp(<QuickPalette />);
    await openPalette();
    await selectGreeting(user);
    await user.type(screen.getByLabelText("name"), "Ada");
    await user.type(screen.getByLabelText("place"), "Paris");
    await screen.findByText("Hello Ada from Paris");
    await user.click(screen.getByRole("button", { name: "Copy prompt" }));

    expect(screen.getByText("Hello Ada from Paris")).toBeInTheDocument();
    expect(screen.getByLabelText("name")).toHaveValue("Ada");
    expect(screen.getByRole("button", { name: "Copy prompt" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Refresh current version" })).toBeInTheDocument();
  });

  it("refreshes stale content and keeps values only for variables still present", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    bridge.quickPalette.render.mockResolvedValue({
      ok: true,
      value: { status: "ready", previewId: "preview-1", content: "old preview" },
    });
    bridge.quickPalette.copy.mockResolvedValue({
      ok: false,
      code: "revision-changed",
      message: "changed",
    });
    bridge.quickPalette.resolve
      .mockResolvedValueOnce({ ok: true, value: SELECTION })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          ...SELECTION,
          versionId: "version-2",
          versionLabel: "v2",
          templateContent: "Hi {{name}} / {{tone}}",
          requiredVariables: ["name", "tone"],
        },
      });
    renderApp(<QuickPalette />);
    await openPalette();
    await selectGreeting(user);
    await user.type(screen.getByLabelText("name"), "Ada");
    await user.type(screen.getByLabelText("place"), "Paris");
    await screen.findByText("old preview");
    await user.click(screen.getByRole("button", { name: "Copy prompt" }));
    await user.click(screen.getByRole("button", { name: "Refresh current version" }));

    expect(await screen.findByText("v2")).toBeInTheDocument();
    expect(screen.getByLabelText("name")).toHaveValue("Ada");
    expect(screen.queryByLabelText("place")).not.toBeInTheDocument();
    expect(screen.getByLabelText("tone")).toHaveValue("");
  });

  it("keeps multiline Enter input, ignores composing selection, and copies on Ctrl+Enter", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    bridge.quickPalette.resolve.mockResolvedValue({ ok: true, value: SELECTION });
    bridge.quickPalette.render.mockResolvedValue({
      ok: true,
      value: { status: "ready", previewId: "preview-1", content: "ready" },
    });
    bridge.quickPalette.copy.mockResolvedValue({ ok: true, value: null });
    renderApp(<QuickPalette />);
    await openPalette();
    const search = screen.getByLabelText("Search prompts");
    await user.type(search, "x");
    fireEvent.keyDown(search, { key: "Enter", isComposing: true });
    expect(bridge.quickPalette.resolve).not.toHaveBeenCalled();

    await user.click(screen.getByRole("option", { name: /Greeting/ }));
    const name = await screen.findByLabelText("name");
    await user.type(name, "Ada{Enter}Lovelace");
    expect(name).toHaveValue("Ada\nLovelace");
    await user.type(screen.getByLabelText("place"), "London");
    await screen.findByText("ready");
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(bridge.quickPalette.copy).toHaveBeenCalledWith({
      sessionId: "session-1",
      previewId: "preview-1",
    });
  });

  it("blocks overlong values visibly without sending them to main", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderApp(<QuickPalette />);
    await openPalette();
    await selectGreeting(user);
    const value = "x".repeat(100_001);

    act(() => {
      const textarea = screen.getByLabelText("name");
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(screen.getByLabelText("name")).toHaveValue(value);
    expect(await screen.findByText(/100,000 characters or fewer/)).toBeInTheDocument();
    expect(bridge.quickPalette.render).not.toHaveBeenCalledWith(
      expect.objectContaining({ variables: expect.objectContaining({ name: value }) }),
    );
  });

  it("discards an old resolution reply after returning to search", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const oldResolve = deferred<Awaited<ReturnType<typeof bridge.quickPalette.resolve>>>();
    bridge.quickPalette.resolve
      .mockImplementationOnce(() => oldResolve.promise)
      .mockResolvedValueOnce({ ok: true, value: { ...SELECTION, promptId: "prompt-2", title: "Second" } });
    bridge.quickPalette.search.mockResolvedValue({
      ok: true,
      value: [ITEM, { ...ITEM, promptId: "prompt-2", title: "Second" }],
    });
    renderApp(<QuickPalette />);
    await openPalette();
    await user.click(screen.getByRole("option", { name: /Greeting/ }));
    await user.click(screen.getByRole("button", { name: "Back to search" }));
    await user.click(screen.getByRole("option", { name: /Second/ }));
    expect(await screen.findByText("Second")).toBeInTheDocument();
    oldResolve.resolve({ ok: true, value: SELECTION });
    await act(async () => Promise.resolve());
    expect(screen.queryByText("Greeting")).not.toBeInTheDocument();
  });

  it("discards an old render reply after a variable edit", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const oldRender = deferred<Awaited<ReturnType<typeof bridge.quickPalette.render>>>();
    bridge.quickPalette.resolve.mockResolvedValue({ ok: true, value: SELECTION });
    bridge.quickPalette.render
      .mockImplementationOnce(() => oldRender.promise)
      .mockResolvedValue({
        ok: true,
        value: { status: "ready", previewId: "new-preview", content: "new preview" },
      });
    renderApp(<QuickPalette />);
    await openPalette();
    await user.click(screen.getByRole("option", { name: /Greeting/ }));
    await waitFor(() => expect(bridge.quickPalette.render).toHaveBeenCalledTimes(1));
    fireEvent.change(await screen.findByLabelText("name"), { target: { value: "Ada" } });

    expect(await screen.findByText("new preview")).toBeInTheDocument();
    oldRender.resolve({
      ok: true,
      value: { status: "ready", previewId: "old-preview", content: "old preview" },
    });
    await act(async () => Promise.resolve());
    expect(screen.queryByText("old preview")).not.toBeInTheDocument();
    expect(screen.getByText("new preview")).toBeInTheDocument();
  });
});

describe("QuickPalette dismissal, theme, and isolated root", () => {
  it("submits Escape dismissal once and native close clears immediately", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderApp(<QuickPalette />);
    await openPalette();

    await user.keyboard("{Escape}{Escape}");
    expect(bridge.quickPalette.dismiss).toHaveBeenCalledTimes(1);
    act(() => bridge.emitQuickPaletteClosed("session-1"));
    expect(screen.queryByLabelText("Search prompts")).not.toBeInTheDocument();
  });

  it("refreshes the existing theme preference whenever a session opens", async () => {
    renderApp(<QuickPalette />);
    localStorage.setItem("promptbuilder:theme", "light");

    await openPalette();

    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("palette routing mounts no normal application data effects", async () => {
    renderApp(<RendererRoot hash="#quick-palette" />);
    await openPalette();

    expect(await screen.findByLabelText("Search prompts")).toBeInTheDocument();
    expect(bridge.prompts.list).not.toHaveBeenCalled();
    expect(bridge.collections.list).not.toHaveBeenCalled();
    expect(bridge.ai.providers.list).not.toHaveBeenCalled();
  });
});
