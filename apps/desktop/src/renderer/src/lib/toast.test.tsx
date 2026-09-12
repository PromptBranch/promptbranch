// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider, useToast } from "./toast";

function ToastHarness() {
  const { toast } = useToast();

  return (
    <>
      <button type="button" onClick={() => toast("Saved")}>Show ordinary toast</button>
      <button
        type="button"
        onClick={() =>
          toast("PromptBranch 0.2.0 is available", "info", {
            action: { label: "View update", onClick: () => {} },
            durationMs: null,
            dismissLabel: "Later",
          })
        }
      >
        Show update toast
      </button>
    </>
  );
}

describe("ToastProvider", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("keeps a persistent toast visible until the user dismisses it", () => {
    render(
      <ToastProvider>
        <ToastHarness />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Show update toast" }));

    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.getByText("PromptBranch 0.2.0 is available")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(screen.queryByText("PromptBranch 0.2.0 is available")).not.toBeInTheDocument();
  });

  it("continues to expire ordinary toasts automatically", () => {
    render(
      <ToastProvider>
        <ToastHarness />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Show ordinary toast" }));
    expect(screen.getByText("Saved")).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(3_600));
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
  });

  it("does not evict a persistent toast when later messages fill the toast stack", () => {
    render(
      <ToastProvider>
        <ToastHarness />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Show update toast" }));
    for (let index = 0; index < 5; index += 1) {
      fireEvent.click(screen.getByRole("button", { name: "Show ordinary toast" }));
    }

    expect(screen.getByText("PromptBranch 0.2.0 is available")).toBeInTheDocument();
  });
});
