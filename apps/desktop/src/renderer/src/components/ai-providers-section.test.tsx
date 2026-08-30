// @vitest-environment jsdom
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiCatalogDto, AiProviderDto } from "../../../shared/ipc.js";
import { installMockBridge, type MockBridge } from "../test/mock-bridge";
import { renderApp } from "../test/render";
import { AiProvidersSection } from "./AiProvidersSection";

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
  providers: [],
  models: {
    google: [
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
      {
        id: "lyria-3-clip-preview",
        name: "Lyria",
        contextWindow: null,
        outputLimit: null,
        inputModalities: ["text", "image"],
        outputModalities: ["text", "audio"],
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
  bridge.ai.providers.list.mockResolvedValue([googleProvider]);
  bridge.ai.catalog.get.mockResolvedValue(catalog);
  bridge.ai.providers.test.mockResolvedValue({ ok: true });
});

describe("AiProvidersSection re-test", () => {
  it("asks for a test model instead of auto-picking, and runs on the choice", async () => {
    const user = userEvent.setup();
    renderApp(<AiProvidersSection />);

    await screen.findByText("Google");
    await user.click(screen.getByRole("button", { name: "Actions for Google" }));
    await user.click(await screen.findByRole("menuitem", { name: /Re-test connection/ }));

    const select = await screen.findByLabelText("Test model");
    // Nothing is auto-selected from the catalog — the user chooses (the
    // fixture's $0 Lyria is exactly the model auto-picks kept choosing).
    expect(select).toHaveValue("");
    expect(withinOptions(select)).toContain("lyria-3-clip-preview");

    await user.selectOptions(select, "gemini-3.5-flash-lite");
    await user.click(screen.getByRole("button", { name: "Run test" }));
    expect(bridge.ai.providers.test).toHaveBeenCalledWith("prov-google", "gemini-3.5-flash-lite");
  });

  it("re-tests directly on the remembered model — no re-choosing", async () => {
    bridge.ai.providers.list.mockResolvedValue([{ ...googleProvider, testModel: "gemini-3.5-flash-lite" }]);
    const user = userEvent.setup();
    renderApp(<AiProvidersSection />);

    await screen.findByText("Google");
    await user.click(screen.getByRole("button", { name: "Actions for Google" }));
    await user.click(await screen.findByRole("menuitem", { name: /Re-test connection/ }));

    // The remembered pick is used straight away; the chooser never opens.
    expect(bridge.ai.providers.test).toHaveBeenCalledWith("prov-google", "gemini-3.5-flash-lite");
    expect(screen.queryByLabelText("Test model")).not.toBeInTheDocument();
  });

  it("offers one-click switch to the provider-named replacement", async () => {
    bridge.ai.providers.list.mockResolvedValue([{ ...googleProvider, testModel: "gemini-2.5-flash-lite" }]);
    bridge.ai.providers.test.mockResolvedValue({
      ok: false,
      error:
        "Provider request failed (HTTP 404): This model models/gemini-2.5-flash-lite is no longer available to new users. Please update your code to use models/gemini-3.5-flash-lite.",
      modelUnavailable: true,
      suggestedModel: "gemini-3.5-flash-lite",
    });
    const user = userEvent.setup();
    renderApp(<AiProvidersSection />);

    await screen.findByText("Google");
    await user.click(screen.getByRole("button", { name: "Actions for Google" }));
    await user.click(await screen.findByRole("menuitem", { name: /Re-test connection/ }));

    // Retest ran on the remembered (retired) model and failed…
    expect(bridge.ai.providers.test).toHaveBeenCalledWith("prov-google", "gemini-2.5-flash-lite");
    const switchButton = await screen.findByRole("button", {
      name: "Switch to gemini-3.5-flash-lite and re-test",
    });

    bridge.ai.providers.test.mockResolvedValue({ ok: true });
    await user.click(switchButton);
    // …and the one-click recovery retests on the replacement.
    expect(bridge.ai.providers.test).toHaveBeenLastCalledWith("prov-google", "gemini-3.5-flash-lite");
    expect(await screen.findByText("Connected")).toBeInTheDocument();
  });

  it("re-tests directly after a model was chosen once — the chooser never reopens", async () => {
    // The providers list starts without a remembered model; the refetch
    // after the first test reflects the persisted choice.
    let chosen = false;
    bridge.ai.providers.list.mockImplementation(async () => [
      chosen ? { ...googleProvider, testModel: "gemini-3.5-flash-lite" } : googleProvider,
    ]);
    bridge.ai.providers.test.mockImplementation(async (_providerId: string, modelId?: string) => {
      chosen = true;
      return modelId === "gemini-3.5-flash-lite" ? { ok: true } : { ok: false, error: "wrong model" };
    });
    const user = userEvent.setup();
    renderApp(<AiProvidersSection />);

    // First Re-test: nothing remembered yet → the chooser opens.
    await screen.findByText("Google");
    await user.click(screen.getByRole("button", { name: "Actions for Google" }));
    await user.click(await screen.findByRole("menuitem", { name: /Re-test connection/ }));
    const select = await screen.findByLabelText("Test model");
    await user.selectOptions(select, "gemini-3.5-flash-lite");
    await user.click(screen.getByRole("button", { name: "Run test" }));
    expect(await screen.findByText("Connected")).toBeInTheDocument();

    // Second Re-test: the remembered choice runs directly, no chooser.
    await user.click(screen.getByRole("button", { name: "Actions for Google" }));
    await user.click(await screen.findByRole("menuitem", { name: /Re-test connection/ }));
    await waitFor(() =>
      expect(bridge.ai.providers.test).toHaveBeenLastCalledWith("prov-google", "gemini-3.5-flash-lite"),
    );
    expect(screen.queryByLabelText("Test model")).not.toBeInTheDocument();
  });

  it("preselects the remembered model in the chooser", async () => {
    bridge.ai.providers.list.mockResolvedValue([{ ...googleProvider, testModel: "gemini-2.5-pro" }]);
    const user = userEvent.setup();
    renderApp(<AiProvidersSection />);

    await screen.findByText("Google");
    await user.click(screen.getByRole("button", { name: "Actions for Google" }));
    await user.click(await screen.findByRole("menuitem", { name: /Choose test model/ }));

    expect(await screen.findByLabelText("Test model")).toHaveValue("gemini-2.5-pro");
  });

  it("preselects the first declared model in the chooser", async () => {
    bridge.ai.providers.list.mockResolvedValue([
      { ...googleProvider, models: [{ modelId: "gemini-2.5-pro", displayName: null, enabled: true }] },
    ]);
    const user = userEvent.setup();
    renderApp(<AiProvidersSection />);

    await screen.findByText("Google");
    await user.click(screen.getByRole("button", { name: "Actions for Google" }));
    await user.click(await screen.findByRole("menuitem", { name: /Choose test model/ }));

    expect(await screen.findByLabelText("Test model")).toHaveValue("gemini-2.5-pro");
    await user.click(screen.getByRole("button", { name: "Run test" }));
    expect(bridge.ai.providers.test).toHaveBeenCalledWith("prov-google", "gemini-2.5-pro");
  });
});

function withinOptions(select: HTMLElement): string[] {
  return Array.from(select.querySelectorAll("option")).map((option) => option.getAttribute("value") ?? "");
}
