// @vitest-environment jsdom
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import type { ShareImportPreview, ShareImportResult } from "../../../shared/ipc.js";
import { useAppState } from "../state/app-state";
import { installMockBridge, type MockBridge } from "../test/mock-bridge";
import { renderApp } from "../test/render";
import { ImportSnapshotDialog } from "./ImportSnapshotDialog";

const preview: ShareImportPreview = {
  id: "V1StGXR8_Z5jdHi6B-myT",
  url: "https://promptbranch.app/p/V1StGXR8_Z5jdHi6B-myT",
  publishedAt: "2026-08-25T12:00:00.000Z",
  snapshot: {
    formatVersion: 1,
    title: "security-audit",
    description: "Audit code",
    content: "You are a security auditor.",
    tags: ["security", "review"],
    history: [
      { version: 1, content: "draft", changeNote: "first" },
      { version: 2, content: "You are a security auditor.", changeNote: "tighter" },
    ],
    publishedAt: "2026-08-25T12:00:00.000Z",
  },
};

const importResult: ShareImportResult = { promptId: "new-prompt-id", title: "security-audit" };

let bridge: MockBridge;

beforeEach(() => {
  bridge = installMockBridge();
  bridge.share.importPreview.mockResolvedValue(preview);
  bridge.share.import.mockResolvedValue(importResult);
});

/**
 * Replicates the App.tsx deep-link subscription
 * (`onOpenImport` → `setImportUrl`) so tests drive the dialog through
 * `bridge.emitOpenImport` exactly like a real promptbranch://import link.
 */
function DeepLinkWiring() {
  const { setImportUrl } = useAppState();
  useEffect(
    () => window.promptBuilder.share.onOpenImport((url) => setImportUrl(url)),
    [setImportUrl],
  );
  return null;
}

async function renderAndOpen() {
  const user = userEvent.setup();
  renderApp(
    <>
      <DeepLinkWiring />
      <ImportSnapshotDialog />
    </>,
  );
  act(() => bridge.emitOpenImport(preview.url));
  return user;
}

describe("ImportSnapshotDialog", () => {
  it("previews the snapshot and imports on confirm", async () => {
    const user = await renderAndOpen();
    expect(await screen.findByText("security-audit")).toBeInTheDocument();
    expect(screen.getByText("Audit code")).toBeInTheDocument();
    expect(screen.getByText("security")).toBeInTheDocument();
    expect(screen.getByText(/includes 2 versions/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Import prompt" }));
    expect(bridge.share.import).toHaveBeenCalledWith(preview);
    // Dialog closes after a successful import.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Import prompt" })).not.toBeInTheDocument(),
    );
  });

  it("fetches the preview via the bridge with the deep-link url", async () => {
    await renderAndOpen();
    await screen.findByText("security-audit");
    expect(bridge.share.importPreview).toHaveBeenCalledWith(preview.url);
  });

  it("shows an error state when the fetch fails", async () => {
    bridge.share.importPreview.mockRejectedValue(new Error("Snapshot was deleted from the portal"));
    await renderAndOpen();
    expect(await screen.findByText(/deleted from the portal/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Import prompt" })).not.toBeInTheDocument();
  });

  it("surfaces a failed import as an error toast and keeps the dialog open", async () => {
    bridge.share.import.mockRejectedValue(new Error("Disk is full"));
    const user = await renderAndOpen();
    await screen.findByText("security-audit");
    await user.click(screen.getByRole("button", { name: "Import prompt" }));
    // The mutation wrapper's error toast is the signal; the dialog stays so
    // the user can retry or cancel instead of the failure vanishing silently.
    expect(await screen.findByText("Disk is full")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import prompt" })).toBeInTheDocument();
  });
});
