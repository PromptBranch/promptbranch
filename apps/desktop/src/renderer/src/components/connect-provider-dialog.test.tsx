// @vitest-environment jsdom
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiCatalogDto, AiProviderDto } from "../../../shared/ipc.js";
import { installMockBridge, type MockBridge } from "../test/mock-bridge";
import { renderApp } from "../test/render";
import { ConnectProviderDialog } from "./ConnectProviderDialog";

const googleProvider: AiProviderDto = {
  id: "prov-google",
  type: "google",
  driver: "google",
  name: "Google",
  baseUrl: null,
  enabled: true,
  hasApiKey: true,
  createdAt: "2026-08-26T00:00:00Z",
  models: [],
};

const catalog: AiCatalogDto = {
  fetchedAt: "2026-08-26T00:00:00Z",
  providers: [
    {
      id: "google",
      name: "Google",
      env: ["GOOGLE_GENERATIVE_AI_API_KEY"],
      api: null,
      npm: null,
      doc: null,
      modelCount: 4,
      popular: true,
      driver: "google",
    },
  ],
  models: {
    google: [
      {
        id: "gemini-2.5-flash-lite",
        name: "Gemini 2.5 Flash-Lite",
        contextWindow: null,
        outputLimit: null,
        inputModalities: ["text"],
        outputModalities: ["text"],
        reasoning: false,
        toolCall: false,
        costInput: 0.1,
        costOutput: 0.4,
      },
      {
        id: "gemini-3.5-flash-lite",
        name: "Gemini 3.5 Flash-Lite",
        contextWindow: null,
        outputLimit: null,
        inputModalities: ["text"],
        outputModalities: ["text"],
        reasoning: false,
        toolCall: false,
        costInput: 0.05,
        costOutput: 0.2,
      },
      // The two models that broke the real flow: a free image-generation
      // model ("Nano Banana") and a no-modality-data music model (Lyria),
      // both priced $0 so a naive cheapest-first sort picks them.
      {
        id: "gemini-3.1-flash-lite-image",
        name: "Nano Banana 2 Lite",
        contextWindow: null,
        outputLimit: null,
        inputModalities: ["text"],
        outputModalities: ["image"],
        reasoning: false,
        toolCall: false,
        costInput: 0,
        costOutput: 0,
      },
      {
        id: "lyria-3-clip",
        name: "Lyria 3",
        contextWindow: null,
        outputLimit: null,
        inputModalities: [],
        outputModalities: [],
        reasoning: false,
        toolCall: false,
        costInput: 0,
        costOutput: 0,
      },
    ],
  },
};

let bridge: MockBridge;

beforeEach(() => {
  bridge = installMockBridge();
  bridge.ai.catalog.get.mockResolvedValue(catalog);
  bridge.ai.providers.list.mockResolvedValue([]);
  bridge.ai.envDetect.mockResolvedValue({});
  bridge.ai.providers.create.mockResolvedValue(googleProvider);
  bridge.ai.providers.update.mockResolvedValue(googleProvider);
  bridge.ai.providers.test.mockResolvedValue({ ok: true });
});

async function openGoogleForm(user: ReturnType<typeof userEvent.setup>) {
  renderApp(<ConnectProviderDialog open onOpenChange={vi.fn()} />);
  await user.click(await screen.findByRole("button", { name: /Google/ }));
  await user.type(screen.getByLabelText(/API key/), "a-test-key");
}

describe("ConnectProviderDialog test model choice", () => {
  it("does not claim a provider was saved when creation fails", async () => {
    bridge.ai.providers.create.mockRejectedValue(
      new Error("Base URL must use https:// (http:// is only allowed for localhost)"),
    );
    const user = userEvent.setup();
    renderApp(<ConnectProviderDialog open onOpenChange={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: /Custom OpenAI-compatible provider/ }));
    await user.type(screen.getByLabelText(/Base URL/), "http://example.com/v1");
    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(await screen.findByText(/Nothing was saved/)).toBeInTheDocument();
    expect(screen.queryByText(/The provider was saved/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("requires an explicit test model: Connect stays disabled until one is chosen", async () => {
    const user = userEvent.setup();
    await openGoogleForm(user);

    const select = screen.getByLabelText("Test model");
    // No auto-selection — not the cheapest, not a heuristic guess.
    expect(select).toHaveValue("");
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();

    // Ordering suggests chat models first but keeps everything selectable.
    const optionIds = within(select)
      .getAllByRole("option")
      .map((option) => option.getAttribute("value"));
    expect(optionIds).toEqual([
      "",
      "gemini-3.5-flash-lite",
      "gemini-2.5-flash-lite",
      "lyria-3-clip",
      "gemini-3.1-flash-lite-image",
    ]);

    await user.selectOptions(select, "gemini-3.5-flash-lite");
    expect(screen.getByRole("button", { name: "Connect" })).toBeEnabled();
  });

  it("tests with exactly the chosen model, and the chosen one on retry", async () => {
    bridge.ai.providers.test.mockResolvedValue({
      ok: false,
      error:
        "Provider request failed (HTTP 429): You exceeded your current quota, please check your plan and billing details.",
      modelUnavailable: true,
    });
    const user = userEvent.setup();
    await openGoogleForm(user);

    await user.selectOptions(screen.getByLabelText("Test model"), "lyria-3-clip");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(bridge.ai.providers.test).toHaveBeenLastCalledWith("prov-google", "lyria-3-clip");
    expect(await screen.findByText(/this is not a key problem/i)).toBeInTheDocument();

    // Retry with a different explicit choice.
    bridge.ai.providers.test.mockResolvedValue({ ok: true });
    await user.selectOptions(screen.getByLabelText("Test model"), "gemini-3.5-flash-lite");
    await user.click(screen.getByRole("button", { name: "Fix & retry" }));
    expect(bridge.ai.providers.test).toHaveBeenLastCalledWith("prov-google", "gemini-3.5-flash-lite");
    expect(await screen.findByText(/Connected/)).toBeInTheDocument();
  });

  it("shows no model-unavailable hint for auth failures", async () => {
    bridge.ai.providers.test.mockResolvedValue({ ok: false, error: "Provider request failed (HTTP 401): bad key" });
    const user = userEvent.setup();
    await openGoogleForm(user);

    await user.selectOptions(screen.getByLabelText("Test model"), "gemini-3.5-flash-lite");
    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(await screen.findByText(/HTTP 401/)).toBeInTheDocument();
    expect(screen.queryByText(/this is not a key problem/i)).not.toBeInTheDocument();
  });
});
