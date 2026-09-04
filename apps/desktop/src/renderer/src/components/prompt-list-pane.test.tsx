// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import type { AppView } from "../state/app-state";
import { useAppState } from "../state/app-state";
import type { PromptDetail, PromptSummary } from "../../../shared/ipc.js";
import { installMockBridge, type MockBridge } from "../test/mock-bridge";
import { renderApp } from "../test/render";
import { PromptListPane } from "./PromptListPane";

const alpha: PromptSummary = {
  id: "prompt-a",
  title: "Alpha",
  description: null,
  icon: null,
  isStarred: true,
  versionLabel: "v1",
  tags: [],
  createdAt: "2026-09-03T10:00:00.000Z",
  updatedAt: "2026-09-03T10:00:00.000Z",
  deletedAt: null,
};

const beta: PromptSummary = {
  ...alpha,
  id: "prompt-b",
  title: "Beta",
  isStarred: false,
  versionLabel: "v3",
};

const betaDetail: PromptDetail = {
  ...beta,
  currentVersionId: "version-b3",
  draftContent: null,
  collectionIds: [],
};

function PaneInView({ view }: { view: AppView }) {
  const { setView } = useAppState();
  useEffect(() => setView(view), [setView, view.kind, view.collectionId, view.collectionName]);
  return <PromptListPane />;
}

async function openPromptMenu(user: ReturnType<typeof userEvent.setup>, title = "Beta") {
  const titleNode = await screen.findByText(title);
  await user.pointer({ target: titleNode.closest("button")!, keys: "[MouseRight]" });
  return within(await screen.findByRole("menu", { name: `${title} actions` }));
}

let bridge: MockBridge;

beforeEach(() => {
  bridge = installMockBridge();
  bridge.prompts.list.mockResolvedValue([alpha, beta]);
  bridge.prompts.get.mockImplementation(async (id) => (id === beta.id ? betaDetail : null));
  bridge.collections.list.mockResolvedValue([
    { id: "collection-1", name: "Work", sortOrder: 0, promptCount: 0 },
  ]);
});

describe("PromptListPane context menu", () => {
  it("applies an action to the right-clicked prompt", async () => {
    const user = userEvent.setup();
    renderApp(<PaneInView view={{ kind: "library" }} />);
    await user.click((await screen.findByText("Alpha")).closest("button")!);

    const menu = await openPromptMenu(user);
    expect(menu.getByRole("menuitem", { name: "Rename" })).toBeInTheDocument();
    expect(menu.getByRole("menuitem", { name: "Move to collection…" })).toBeInTheDocument();
    expect(menu.getByRole("menuitem", { name: "Duplicate as new prompt…" })).toBeInTheDocument();
    expect(menu.getByRole("menuitem", { name: "Duplicate current version as variation…" })).toBeInTheDocument();
    expect(menu.getByRole("menuitem", { name: "Export prompt JSON" })).toBeInTheDocument();
    await user.click(menu.getByRole("menuitem", { name: "Star" }));

    expect(bridge.prompts.setStarred).toHaveBeenCalledWith(beta.id, true);
  });

  it("renames the right-clicked prompt", async () => {
    const user = userEvent.setup();
    renderApp(<PaneInView view={{ kind: "library" }} />);

    const menu = await openPromptMenu(user);
    await user.click(menu.getByRole("menuitem", { name: "Rename" }));
    const title = await screen.findByLabelText("Title");
    await user.clear(title);
    await user.type(title, "Renamed Beta");
    await user.click(screen.getByRole("button", { name: "Rename" }));

    expect(bridge.prompts.update).toHaveBeenCalledWith(beta.id, { title: "Renamed Beta" });
  });

  it("moves the right-clicked prompt to a collection", async () => {
    const user = userEvent.setup();
    renderApp(<PaneInView view={{ kind: "library" }} />);

    const menu = await openPromptMenu(user);
    await user.click(menu.getByRole("menuitem", { name: "Move to collection…" }));
    const dialog = await screen.findByRole("dialog", { name: "Move to collection" });
    await user.click(within(dialog).getByRole("checkbox", { name: "Work" }));

    await waitFor(() =>
      expect(bridge.collections.addPrompt).toHaveBeenCalledWith("collection-1", beta.id),
    );
  });

  it("duplicates the current version as a variation", async () => {
    bridge.branches.create.mockResolvedValue({
      branch: {
        id: "branch-new",
        name: "concise",
        description: null,
        createdAt: "2026-09-03T10:00:00.000Z",
      },
      version: {
        id: "version-new",
        promptId: beta.id,
        branchId: "branch-new",
        branchName: "concise",
        parentVersionId: "version-b3",
        number: 1,
        label: null,
        displayLabel: "concise v1",
        changeNote: null,
        author: "human",
        createdAt: "2026-09-03T10:00:00.000Z",
        isCurrent: false,
      },
    });
    const user = userEvent.setup();
    renderApp(<PaneInView view={{ kind: "library" }} />);

    const menu = await openPromptMenu(user);
    await user.click(menu.getByRole("menuitem", { name: "Duplicate current version as variation…" }));
    await user.type(await screen.findByLabelText("Variation name"), "concise");
    await user.click(screen.getByRole("button", { name: "Create variation" }));

    await waitFor(() =>
      expect(bridge.branches.create).toHaveBeenCalledWith({
        promptId: beta.id,
        name: "concise",
        fromVersionId: "version-b3",
      }),
    );
    expect(bridge.versions.setCurrent).toHaveBeenCalledWith(beta.id, "version-new");
  });

  it("duplicates the current version as a new prompt", async () => {
    bridge.prompts.duplicate.mockResolvedValue({
      ...betaDetail,
      id: "prompt-copy",
      title: "Beta standalone",
      currentVersionId: "copy-v1",
    });
    const user = userEvent.setup();
    renderApp(<PaneInView view={{ kind: "library" }} />);

    const menu = await openPromptMenu(user);
    await user.click(menu.getByRole("menuitem", { name: "Duplicate as new prompt…" }));
    const title = await screen.findByLabelText("Title");
    expect(title).toHaveValue("Beta copy");
    await user.clear(title);
    await user.type(title, "Beta standalone");
    await user.click(screen.getByRole("button", { name: "Duplicate" }));

    await waitFor(() =>
      expect(bridge.prompts.duplicate).toHaveBeenCalledWith({
        promptId: beta.id,
        versionId: "version-b3",
        title: "Beta standalone",
      }),
    );
  });

  it("exports and deletes the right-clicked prompt", async () => {
    const user = userEvent.setup();
    renderApp(<PaneInView view={{ kind: "library" }} />);

    let menu = await openPromptMenu(user);
    await user.click(menu.getByRole("menuitem", { name: "Export prompt JSON" }));
    expect(bridge.prompts.exportJson).toHaveBeenCalledWith(beta.id);

    menu = await openPromptMenu(user);
    await user.click(menu.getByRole("menuitem", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Move to Trash" }));
    expect(bridge.prompts.softDelete).toHaveBeenCalledWith(beta.id);
  });

  it("removes the right-clicked prompt from the viewed collection", async () => {
    const user = userEvent.setup();
    renderApp(
      <PaneInView
        view={{ kind: "collection", collectionId: "collection-1", collectionName: "Work" }}
      />,
    );

    const menu = await openPromptMenu(user);
    await user.click(menu.getByRole("menuitem", { name: "Remove from this collection" }));

    expect(bridge.collections.removePrompt).toHaveBeenCalledWith("collection-1", beta.id);
  });

  it("offers restore and permanent deletion in Trash", async () => {
    bridge.prompts.list.mockResolvedValue([{ ...beta, deletedAt: "2026-09-03T11:00:00.000Z" }]);
    const user = userEvent.setup();
    renderApp(<PaneInView view={{ kind: "trash" }} />);

    let menu = await openPromptMenu(user);
    expect(menu.queryByRole("menuitem", { name: "Rename" })).not.toBeInTheDocument();
    await user.click(menu.getByRole("menuitem", { name: "Restore" }));
    expect(bridge.prompts.restore).toHaveBeenCalledWith(beta.id);

    menu = await openPromptMenu(user);
    await user.click(menu.getByRole("menuitem", { name: "Delete permanently" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Delete permanently" }));
    expect(bridge.prompts.hardDelete).toHaveBeenCalledWith(beta.id);
  });
});
