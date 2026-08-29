// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiCatalogDto, AiProviderDto } from "../../../shared/ipc.js";
import { qk } from "../hooks/use-data";
import { installMockBridge, type MockBridge } from "../test/mock-bridge";
import { createTestQueryClient, renderApp } from "../test/render";
import { NewPromptDialog } from "./dialogs";

const provider: AiProviderDto = {
  id: "prov-anth",
  type: "anthropic",
  driver: "anthropic",
  name: "Anthropic",
  baseUrl: null,
  enabled: true,
  hasApiKey: true,
  createdAt: "2026-01-01T00:00:00Z",
  models: [],
};

const catalog: AiCatalogDto = {
  fetchedAt: "2026-01-01T00:00:00Z",
  providers: [],
  models: {
    anthropic: [
      {
        id: "claude-opus",
        name: "Claude Opus",
        contextWindow: null,
        outputLimit: null,
        inputModalities: ["text"],
        outputModalities: ["text"],
        reasoning: false,
        toolCall: false,
        costInput: null,
        costOutput: null,
      },
    ],
  },
};

let bridge: MockBridge;

beforeEach(() => {
  bridge = installMockBridge();
  bridge.ai.assist.mockResolvedValue({ text: "AI generated draft" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderDialog() {
  // Mock the bridge (queries refetch on mount) and pre-seed the cache so the
  // first available model is selected synchronously.
  bridge.ai.providers.list.mockResolvedValue([provider]);
  bridge.ai.catalog.get.mockResolvedValue(catalog);
  const queryClient = createTestQueryClient();
  queryClient.setQueryData(qk.aiProviders, [provider]);
  queryClient.setQueryData(qk.aiCatalog, catalog);
  renderApp(<NewPromptDialog open onOpenChange={vi.fn()} allTags={[]} onCreate={vi.fn()} />, {
    queryClient,
  });
}

async function requestGenerate() {
  renderDialog();
  const user = userEvent.setup();
  await user.type(screen.getByPlaceholderText(/code review — security focus/i), "My prompt");
  await user.type(screen.getByPlaceholderText(/senior engineer/i), "Draft I wrote myself");
  await user.click(screen.getByRole("button", { name: /generate with ai/i }));
  await user.type(screen.getByPlaceholderText(/describe the prompt you want/i), "a code reviewer");
  await user.click(screen.getByRole("button", { name: /^generate$/i }));
  await waitFor(() => expect(bridge.ai.assist).toHaveBeenCalledOnce());
  return user;
}

describe("NewPromptDialog generate flow", () => {
  it("keeps the user's content when the overwrite confirm is declined", async () => {
    const user = await requestGenerate();
    // The styled ConfirmDialog (not window.confirm) guards the overwrite.
    const confirm = await screen.findByRole("alertdialog");
    expect(within(confirm).getByText(/replace existing content/i)).toBeInTheDocument();
    await user.click(within(confirm).getByRole("button", { name: /cancel/i }));
    expect(bridge.ai.assist).toHaveBeenCalledWith({
      mode: "generate",
      description: "a code reviewer",
      providerId: "prov-anth",
      modelId: "claude-opus",
    });
    expect(screen.getByPlaceholderText(/senior engineer/i)).toHaveValue("Draft I wrote myself");
  });

  it("replaces the content with the generated draft when confirmed", async () => {
    const user = await requestGenerate();
    const confirm = await screen.findByRole("alertdialog");
    await user.click(within(confirm).getByRole("button", { name: /replace content/i }));
    await waitFor(() =>
      expect(screen.getByPlaceholderText(/senior engineer/i)).toHaveValue("AI generated draft"),
    );
  });

  it("applies the generated draft without confirming when the content is empty", async () => {
    renderDialog();
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText(/code review — security focus/i), "My prompt");
    await user.click(screen.getByRole("button", { name: /generate with ai/i }));
    await user.type(screen.getByPlaceholderText(/describe the prompt you want/i), "a code reviewer");
    await user.click(screen.getByRole("button", { name: /^generate$/i }));
    await waitFor(() =>
      expect(screen.getByPlaceholderText(/senior engineer/i)).toHaveValue("AI generated draft"),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
