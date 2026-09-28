// @vitest-environment jsdom
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  MarkdownImportPreviewDto,
  MarkdownImportResultDto,
} from "../../../shared/ipc.js";
import { useAppState } from "../state/app-state";
import { installMockBridge, type MockBridge } from "../test/mock-bridge";
import { renderApp } from "../test/render";
import { ImportMarkdownDialog } from "./ImportMarkdownDialog";

const sourceUrl = "https://example.com/prompts/review.md";
const markdown: MarkdownImportPreviewDto = {
  previewId: "550e8400-e29b-41d4-a716-446655440000",
  sourceUrl,
  finalUrl: "https://cdn.example.net/prompts/review.md",
  suggestedTitle: "review",
  content: "# Review\n\nPreserve this exact Markdown.\r\n",
};
const imported: MarkdownImportResultDto = { promptId: "prompt-new", title: "review" };

let bridge: MockBridge;

beforeEach(() => {
  bridge = installMockBridge();
  bridge.markdown.preview.mockResolvedValue(markdown);
  bridge.markdown.confirm.mockResolvedValue(imported);
});

function DeepLinkWiring() {
  const { setMarkdownImportUrl } = useAppState();
  useEffect(
    () => window.promptBuilder.markdown.onOpenImport((url) => setMarkdownImportUrl(url)),
    [setMarkdownImportUrl],
  );
  return null;
}

function SelectedPromptProbe() {
  const { selectedPromptId } = useAppState();
  return <span data-testid="selected-prompt">{selectedPromptId ?? "none"}</span>;
}

async function renderAndOpen(url = sourceUrl) {
  const user = userEvent.setup();
  renderApp(
    <>
      <DeepLinkWiring />
      <SelectedPromptProbe />
      <ImportMarkdownDialog />
    </>,
  );
  act(() => bridge.emitOpenMarkdownImport(url));
  return user;
}

async function findMarkdownContent() {
  const content = await screen.findByLabelText("Markdown content");
  await waitFor(() => expect(content.textContent).toBe(markdown.content));
  return content;
}

describe("ImportMarkdownDialog", () => {
  it("opens from the deep link without fetching until the user asks", async () => {
    await renderAndOpen();

    expect(await screen.findByText(sourceUrl)).toBeInTheDocument();
    expect(bridge.markdown.preview).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Fetch Markdown" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Markdown content")).not.toBeInTheDocument();
  });

  it("fetches on click and displays the exact content, source URLs, and editable title", async () => {
    const user = await renderAndOpen();
    await user.click(screen.getByRole("button", { name: "Fetch Markdown" }));

    expect(bridge.markdown.preview).toHaveBeenCalledWith(sourceUrl);
    expect(await screen.findByText(`Final URL: ${markdown.finalUrl}`)).toBeInTheDocument();
    expect((await findMarkdownContent()).textContent).toBe(markdown.content);
    expect(screen.getByLabelText("Prompt title")).toHaveValue("review");
  });

  it("imports only the reviewed preview token and selects the new prompt", async () => {
    const user = await renderAndOpen();
    await user.click(screen.getByRole("button", { name: "Fetch Markdown" }));
    await findMarkdownContent();
    await user.clear(screen.getByLabelText("Prompt title"));
    await user.type(screen.getByLabelText("Prompt title"), "Reviewed title");
    await user.click(screen.getByRole("button", { name: "Import as new prompt" }));

    expect(bridge.markdown.confirm).toHaveBeenCalledWith({
      previewId: markdown.previewId,
      title: "Reviewed title",
    });
    await waitFor(() => expect(screen.getByTestId("selected-prompt")).toHaveTextContent("prompt-new"));
    expect(await screen.findByText('Imported "review"')).toBeInTheDocument();
  });

  it("cancels and discards the preview without importing", async () => {
    const user = await renderAndOpen();
    await user.click(screen.getByRole("button", { name: "Fetch Markdown" }));
    await findMarkdownContent();
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(bridge.markdown.discard).toHaveBeenCalledWith(markdown.previewId));
    expect(bridge.markdown.confirm).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Markdown content")).not.toBeInTheDocument();
  });

  it("shows a fetch failure and leaves the library unchanged", async () => {
    bridge.markdown.preview.mockRejectedValue(new Error("The Markdown URL could not be reached"));
    const user = await renderAndOpen();
    await user.click(screen.getByRole("button", { name: "Fetch Markdown" }));

    expect(await screen.findByText(/could not be reached/i)).toBeInTheDocument();
    expect(bridge.markdown.confirm).not.toHaveBeenCalled();
  });

  it("keeps the reviewed preview available after an import failure", async () => {
    bridge.markdown.confirm.mockRejectedValue(new Error("Disk is full"));
    const user = await renderAndOpen();
    await user.click(screen.getByRole("button", { name: "Fetch Markdown" }));
    await findMarkdownContent();
    await user.click(screen.getByRole("button", { name: "Import as new prompt" }));

    expect(await screen.findByText("Disk is full")).toBeInTheDocument();
    expect((await findMarkdownContent()).textContent).toBe(markdown.content);
    expect(screen.getByRole("button", { name: "Import as new prompt" })).toBeInTheDocument();
  });

  it("discards a late fetch response if the dialog closes before it returns", async () => {
    let resolvePreview!: (value: MarkdownImportPreviewDto) => void;
    bridge.markdown.preview.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePreview = resolve;
        }),
    );
    const user = await renderAndOpen();
    await user.click(screen.getByRole("button", { name: "Fetch Markdown" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await act(async () => resolvePreview(markdown));

    await waitFor(() => expect(bridge.markdown.discard).toHaveBeenCalledWith(markdown.previewId));
    expect(screen.queryByLabelText("Markdown content")).not.toBeInTheDocument();
  });
});
