// @vitest-environment jsdom
import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PropsWithChildren, Ref } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PromptDetail, UpdateStateDto } from "../../shared/ipc.js";
import { installMockBridge, type MockBridge } from "./test/mock-bridge";
import { renderApp } from "./test/render";
import App from "./App";

interface PanelSize {
  asPercentage: number;
  inPixels: number;
}

interface PanelHandle {
  collapse(): void;
  expand(): void;
  isCollapsed(): boolean;
  getSize(): PanelSize;
  resize(): void;
}

const panelState = vi.hoisted(() => new Map<string, boolean>());

const AVAILABLE_UPDATE: UpdateStateDto = {
  status: "update-available",
  currentVersion: "0.1.0",
  latestVersion: "0.2.0",
  platform: "macOS",
  architecture: "arm64",
  automaticChecksEnabled: true,
  lastCheckedAt: "2026-08-31T12:00:00.000Z",
  checkSource: "automatic",
  releaseName: "PromptBranch 0.2.0",
  releaseNotes: "A safer update flow",
  publishedAt: "2026-08-31T10:00:00.000Z",
  assets: [
    {
      name: "promptbranch_0.2.0_macos_arm64.dmg",
      label: "macOS disk image",
      kind: "dmg",
      sizeBytes: 12_345,
      recommended: true,
    },
  ],
  errorMessage: null,
};

const CREATED_PROMPT: PromptDetail = {
  id: "created-prompt",
  title: "Inside collection",
  description: null,
  icon: null,
  isStarred: false,
  versionLabel: "v1",
  tags: [],
  createdAt: "2026-09-03T10:00:00.000Z",
  updatedAt: "2026-09-03T10:00:00.000Z",
  deletedAt: null,
  currentVersionId: "version-1",
  draftContent: null,
  collectionIds: ["collection-1"],
};

// The live Electron regression occurs when an imperative expand changes the
// panel width before its ResizeObserver-backed onResize callback catches up.
// Keep the real App/rail/list components and model only that framework edge.
vi.mock("react-resizable-panels", async () => {
  const React = await import("react");

  interface PanelProps extends PropsWithChildren {
    id?: string | number;
    panelRef?: Ref<PanelHandle | null>;
    collapsedSize?: number | string;
    defaultSize?: number | string;
    onResize?: (size: PanelSize) => void;
  }

  function Group({ children }: PropsWithChildren) {
    return <div>{children}</div>;
  }

  function Panel({ children, id, panelRef, collapsedSize = 0, defaultSize = 100, onResize }: PanelProps) {
    const key = String(id ?? "panel");
    const collapsedPixels = Number(collapsedSize);
    const defaultPixels = Number(defaultSize);
    const handle: PanelHandle = {
      collapse() {
        panelState.set(key, true);
        onResize?.({ asPercentage: 0, inPixels: collapsedPixels });
      },
      expand() {
        panelState.set(key, false);
      },
      isCollapsed() {
        return panelState.get(key) ?? false;
      },
      getSize() {
        return {
          asPercentage: 0,
          inPixels: panelState.get(key) ? collapsedPixels : defaultPixels,
        };
      },
      resize() {},
    };
    React.useImperativeHandle(panelRef, () => handle);
    return <div data-panel={key}>{children}</div>;
  }

  function Separator() {
    return <div role="separator" />;
  }

  return {
    Group,
    Panel,
    Separator,
    useDefaultLayout: () => ({ defaultLayout: undefined, onLayoutChanged: () => {} }),
    usePanelRef: () => React.useRef<PanelHandle | null>(null),
  };
});

let bridge: MockBridge;

beforeEach(() => {
  panelState.clear();
  localStorage.clear();
  bridge = installMockBridge();
});

describe("App collapsible navigation", () => {
  it("restores the prompt-list content immediately after imperative expansion", async () => {
    const user = userEvent.setup();
    renderApp(<App />);

    await user.click(await screen.findByRole("button", { name: "Collapse prompt list" }));
    await user.click(screen.getByRole("button", { name: "Expand prompt list" }));

    expect(screen.getByRole("button", { name: "Collapse prompt list" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Search prompts (⌘K)")).toBeInTheDocument();
  });

  it("restores the sidebar content immediately after imperative expansion", async () => {
    const user = userEvent.setup();
    renderApp(<App />);

    await user.click(await screen.findByRole("button", { name: "Collapse sidebar" }));
    await user.click(screen.getByRole("button", { name: "Expand sidebar" }));

    expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Library" })).toBeInTheDocument();
  });
});

describe("App prompt-list empty states", () => {
  it("does not claim Trash is empty when an active search hides its prompts", async () => {
    const user = userEvent.setup();
    renderApp(<App />);

    await user.type(await screen.findByPlaceholderText("Search prompts (⌘K)"), "needle");
    await user.click(screen.getByRole("button", { name: "Trash" }));

    expect(await screen.findByText("No matching prompts")).toBeInTheDocument();
    expect(screen.queryByText("Trash is empty")).not.toBeInTheDocument();
  });
});

describe("App collection prompt creation", () => {
  beforeEach(() => {
    bridge.collections.list.mockResolvedValue([
      { id: "collection-1", name: "Work", sortOrder: 0, promptCount: 0 },
    ]);
    bridge.prompts.create.mockResolvedValue(CREATED_PROMPT);
  });

  it("creates a prompt in the collection currently being viewed", async () => {
    const user = userEvent.setup();
    renderApp(<App />);

    await user.click(await screen.findByRole("button", { name: /Work/ }));
    await user.click(screen.getByRole("button", { name: "New prompt" }));
    await user.type(await screen.findByLabelText("Title"), "Inside collection");
    await user.click(screen.getByRole("button", { name: "Create prompt" }));

    expect(bridge.prompts.create).toHaveBeenCalledWith({
      title: "Inside collection",
      content: "",
      collectionId: "collection-1",
    });
  });

  it("offers New Prompt when a collection is right-clicked", async () => {
    const user = userEvent.setup();
    renderApp(<App />);

    await user.pointer({
      target: await screen.findByRole("button", { name: /Work/ }),
      keys: "[MouseRight]",
    });
    await user.click(await screen.findByRole("menuitem", { name: "New Prompt" }));
    await user.type(await screen.findByLabelText("Title"), "Inside collection");
    await user.click(screen.getByRole("button", { name: "Create prompt" }));

    expect(bridge.prompts.create).toHaveBeenCalledWith({
      title: "Inside collection",
      content: "",
      collectionId: "collection-1",
    });
  });
});

describe("App update events", () => {
  it("opens Settings to Updates and starts a check from the application menu", async () => {
    bridge.updates.check.mockResolvedValue({ ...AVAILABLE_UPDATE, checkSource: "manual" });
    renderApp(<App />);

    act(() => bridge.emitOpenUpdates());

    expect(await screen.findAllByText("Updates")).toHaveLength(2);
    expect(bridge.updates.check).toHaveBeenCalledTimes(1);
  });

  it("shows an actionable notification for an automatically discovered update", async () => {
    const user = userEvent.setup();
    renderApp(<App />);

    act(() => bridge.emitUpdateState(AVAILABLE_UPDATE));

    expect(await screen.findByText("PromptBranch 0.2.0 is available")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "View update" }));
    expect(await screen.findAllByText("Updates")).toHaveLength(2);
  });
});
