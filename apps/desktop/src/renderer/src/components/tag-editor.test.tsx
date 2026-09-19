// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import type { PromptDetail } from "../../../shared/ipc.js";
import { installMockBridge } from "../test/mock-bridge";
import { renderApp } from "../test/render";
import { useAppState } from "../state/app-state";
import { TagEditor } from "./TagEditor";

const tag = {
  id: "tag-security",
  name: "security",
  color: "#3b82f6",
  usageCount: 1,
};

const prompt: PromptDetail = {
  id: "prompt-1",
  title: "Security prompt",
  description: null,
  icon: null,
  isStarred: false,
  versionLabel: "v1",
  tags: [tag],
  createdAt: "2026-09-03T10:00:00.000Z",
  updatedAt: "2026-09-03T10:00:00.000Z",
  deletedAt: null,
  currentVersionId: "version-1",
  draftContent: null,
  draftBaseVersionId: null,
  collectionIds: [],
};

function FilterStateProbe() {
  const { view, filters } = useAppState();
  return <output data-testid="filter-state">{JSON.stringify({ view, filters })}</output>;
}

describe("TagEditor tag filtering", () => {
  beforeEach(() => {
    const bridge = installMockBridge();
    bridge.tags.list.mockResolvedValue([]);
  });

  it("opens the library filtered to an attached tag when its chip is clicked", async () => {
    const user = userEvent.setup();

    renderApp(
      <>
        <TagEditor prompt={prompt} />
        <FilterStateProbe />
      </>,
    );

    await user.click(screen.getByRole("button", { name: "Filter by tag security" }));

    expect(screen.getByTestId("filter-state")).toHaveTextContent(
      JSON.stringify({ view: { kind: "library" }, filters: { tagIds: [tag.id], starredOnly: false } }),
    );
  });
});
