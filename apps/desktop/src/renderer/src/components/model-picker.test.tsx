// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiCatalogDto, AiCatalogModelDto, AiProviderDto } from "../../../shared/ipc.js";
import { installMockBridge, type MockBridge } from "../test/mock-bridge";
import { renderApp } from "../test/render";
import { MAX_MULTI_SELECT, ModelPicker } from "./model-picker";
import type { ModelRef } from "../lib/ai-prefs";

function catalogModel(id: string, name: string): AiCatalogModelDto {
  return {
    id,
    name,
    contextWindow: 200_000,
    outputLimit: null,
    inputModalities: ["text"],
    outputModalities: ["text"],
    reasoning: false,
    toolCall: true,
    costInput: 3,
    costOutput: 15,
  };
}

function catalogProvider(): AiProviderDto {
  return {
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
}

function customProvider(): AiProviderDto {
  return {
    id: "prov-local",
    type: "openai-compatible",
    driver: "openai-compatible",
    name: "Local box",
    baseUrl: "http://localhost:11434/v1",
    enabled: true,
    hasApiKey: false,
    createdAt: "2026-01-01T00:00:00Z",
    models: [{ modelId: "llama-local", displayName: null, enabled: true }],
  };
}

const catalog: AiCatalogDto = {
  fetchedAt: "2026-01-01T00:00:00Z",
  providers: [],
  models: {
    anthropic: [catalogModel("claude-opus", "Claude Opus"), catalogModel("claude-haiku", "Claude Haiku")],
  },
};

let bridge: MockBridge;

beforeEach(() => {
  bridge = installMockBridge();
  bridge.ai.providers.list.mockResolvedValue([catalogProvider(), customProvider()]);
  bridge.ai.catalog.get.mockResolvedValue(catalog);
});

function renderPicker(props: { multi?: boolean; selection?: ModelRef[]; recents?: ModelRef[] } = {}) {
  const onChange = vi.fn();
  const onOpenChange = vi.fn();
  renderApp(
    <ModelPicker
      multi={props.multi ?? true}
      selection={props.selection ?? []}
      recents={props.recents}
      onChange={onChange}
      open
      onOpenChange={onOpenChange}
    />,
  );
  return { onChange, onOpenChange };
}

const optionNames = () =>
  screen.getAllByRole("option").map((el) => el.textContent ?? "");

describe("ModelPicker", () => {
  it("lists catalog models grouped by provider plus declared models of custom endpoints", async () => {
    renderPicker();
    await screen.findByRole("option", { name: /claude opus/i });
    expect(optionNames()).toHaveLength(3);
    expect(screen.getByText("Anthropic")).toBeInTheDocument();
    expect(screen.getByText("Local box")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /llama-local/i })).toBeInTheDocument();
  });

  it("shows the empty state when no providers are connected", async () => {
    bridge.ai.providers.list.mockResolvedValue([]);
    renderPicker();
    expect(
      await screen.findByText(/no models available yet/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /connect a provider/i })).toBeInTheDocument();
  });

  it("surfaces recents first without duplicating them in provider groups", async () => {
    renderPicker({ recents: [{ providerId: "prov-anth", modelId: "claude-haiku" }] });
    await screen.findByRole("option", { name: /claude haiku/i });
    expect(screen.getByText("Recent")).toBeInTheDocument();
    const names = optionNames();
    expect(names).toHaveLength(3); // haiku appears once, not twice
    expect(names[0]).toMatch(/claude haiku/i);
  });

  it("filters by search and reports when nothing matches", async () => {
    const user = userEvent.setup();
    renderPicker();
    const search = await screen.findByRole("combobox", { name: /search models/i });
    await user.type(search, "local");
    expect(optionNames()).toEqual([expect.stringMatching(/llama-local/i)]);
    await user.clear(search);
    await user.type(search, "zzz-no-such-model");
    expect(await screen.findByText(/no models match/i)).toBeInTheDocument();
    expect(screen.queryByRole("option")).toBeNull();
  });

  it("wires the search input as the combobox controlling the listbox", async () => {
    const user = userEvent.setup();
    renderPicker();
    const combobox = await screen.findByRole("combobox", { name: /search models/i });
    const listbox = screen.getByRole("listbox");
    // The combobox owns the popup relationship and the active descendant.
    expect(combobox).toHaveAttribute("aria-expanded", "true");
    expect(listbox.id).not.toBe("");
    expect(combobox).toHaveAttribute("aria-controls", listbox.id);
    // Multi mode advertises multi-selectability on the listbox.
    expect(listbox).toHaveAttribute("aria-multiselectable", "true");
    await screen.findAllByRole("option");
    const options = screen.getAllByRole("option");
    expect(combobox).toHaveAttribute("aria-activedescendant", options[0]!.id);
    // Keyboard navigation moves the active descendant.
    await user.click(combobox);
    await user.keyboard("{ArrowDown}");
    expect(combobox).toHaveAttribute("aria-activedescendant", options[1]!.id);
  });

  it("single-select listbox is not multiselectable", async () => {
    renderPicker({ multi: false });
    await screen.findByRole("combobox", { name: /search models/i });
    expect(screen.getByRole("listbox")).not.toHaveAttribute("aria-multiselectable");
  });

  it("multi-select toggles refs through onChange", async () => {
    const user = userEvent.setup();
    const { onChange } = renderPicker({ selection: [{ providerId: "prov-anth", modelId: "claude-opus" }] });
    // Clicking an unselected model appends it.
    await user.click(await screen.findByRole("option", { name: /claude haiku/i }));
    expect(onChange).toHaveBeenLastCalledWith([
      { providerId: "prov-anth", modelId: "claude-opus" },
      { providerId: "prov-anth", modelId: "claude-haiku" },
    ]);
    // Clicking a selected model removes it.
    await user.click(screen.getByRole("option", { name: /claude opus/i }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("caps multi-select at 6, shows the hint and ignores further clicks", async () => {
    const user = userEvent.setup();
    const selection = Array.from({ length: MAX_MULTI_SELECT }, (_, i) => ({
      providerId: "prov-anth",
      modelId: `picked-${i}`,
    }));
    const { onChange } = renderPicker({ selection });
    expect(
      await screen.findByText(new RegExp(`max ${MAX_MULTI_SELECT} models`, "i")),
    ).toBeInTheDocument();
    await user.click(await screen.findByRole("option", { name: /claude opus/i }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("single-select picks one model and closes the popover", async () => {
    const user = userEvent.setup();
    const { onChange, onOpenChange } = renderPicker({ multi: false });
    await user.click(await screen.findByRole("option", { name: /llama-local/i }));
    expect(onChange).toHaveBeenCalledWith([{ providerId: "prov-local", modelId: "llama-local" }]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("stacks the menu above dialogs (z-[80]) so option clicks are not swallowed", async () => {
    renderPicker();
    await screen.findByRole("listbox");
    // The judge dialog's overlay/content sit at z-[60]/[70]; the picker menu
    // must top them or option clicks hit the overlay (the e2e picker race).
    expect(screen.getByRole("listbox").closest(".pb-menu")?.className).toContain("z-[80]");
  });
});
