// @vitest-environment jsdom
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PromptDetail,
  SharePreviewResult,
  SharePublishResult,
} from "../../../shared/ipc.js";
import { installMockBridge, type MockBridge } from "../test/mock-bridge";
import { renderApp } from "../test/render";
import { ShareDialog } from "./ShareDialog";

const prompt: PromptDetail = {
  id: "prompt-1",
  title: "Greeting",
  description: null,
  icon: null,
  isStarred: false,
  versionLabel: "v1",
  tags: [],
  createdAt: "2026-08-01T09:00:00Z",
  updatedAt: "2026-08-01T09:00:00Z",
  deletedAt: null,
  currentVersionId: "v-1",
  draftContent: null,
  collectionIds: [],
};

const cleanPreview: SharePreviewResult = {
  payload: {
    formatVersion: 1,
    title: "Greeting",
    content: "Say hi.",
    tags: [],
    publishedAt: "2026-08-26T12:00:00.000Z",
    appVersion: "0.1.0-test",
  },
  findings: [],
};

// No deleteToken: SharePublishResult omits it — the token is recorded by the
// main process and never crosses IPC (plan: renderer trust boundary).
const publishResult: SharePublishResult = {
  id: "V1StGXR8_Z5jdHi6B-myT",
  url: "https://promptbranch.app/p/V1StGXR8_Z5jdHi6B-myT",
};

let bridge: MockBridge;

beforeEach(() => {
  bridge = installMockBridge();
  bridge.share.preview.mockResolvedValue(cleanPreview);
  bridge.share.publish.mockResolvedValue(publishResult);
});

function renderDialog(content = "Say hi.") {
  return renderApp(<ShareDialog open onOpenChange={vi.fn()} prompt={prompt} content={content} />);
}

describe("ShareDialog", () => {
  it("shows the exact payload preview and the success screen after publishing", async () => {
    const user = userEvent.setup();
    renderDialog();
    // Payload JSON is shown verbatim before anything is sent.
    expect(await screen.findByText(/"title": "Greeting"/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Publish" }));
    expect(bridge.share.publish).toHaveBeenCalledWith({
      promptId: "prompt-1",
      includeHistory: false,
      content: "Say hi.",
    });
    expect(await screen.findByText(publishResult.url)).toBeInTheDocument();
    // The delete token stays in the main process; the dialog only notes it.
    expect(screen.getByText(/delete token is stored locally/i)).toBeInTheDocument();
  });

  it("blocks publishing on high-severity findings", async () => {
    bridge.share.preview.mockResolvedValue({
      ...cleanPreview,
      findings: [
        { severity: "high", rule: "openai-api-key", line: 4, match: 'sk-aaaa…' },
      ],
    });
    renderDialog();
    expect(await screen.findByText(/Publishing blocked/)).toBeInTheDocument();
    expect(screen.getByText(/line 4/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();
    expect(bridge.share.publish).not.toHaveBeenCalled();
  });

  it("warns on medium-severity findings but still allows publishing", async () => {
    bridge.share.preview.mockResolvedValue({
      ...cleanPreview,
      findings: [
        { severity: "medium", rule: "email-address", line: 6, match: "jane@example.com" },
      ],
    });
    renderDialog();
    expect(await screen.findByText(/1 warning/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Publish" })).toBeEnabled();
  });

  it("refetches the preview when switching to full history", async () => {
    const user = userEvent.setup();
    renderDialog();
    await screen.findByText(/"title": "Greeting"/);
    await user.click(screen.getByRole("radio", { name: /Include full history/ }));
    await waitFor(() =>
      expect(bridge.share.preview).toHaveBeenCalledWith({
        promptId: "prompt-1",
        includeHistory: true,
        content: "Say hi.",
      }),
    );
  });
});
