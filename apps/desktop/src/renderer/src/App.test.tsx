// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PropsWithChildren, Ref } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installMockBridge } from "./test/mock-bridge";
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

beforeEach(() => {
  panelState.clear();
  localStorage.clear();
  installMockBridge();
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
