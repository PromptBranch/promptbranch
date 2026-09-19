// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { installMockBridge } from "../test/mock-bridge";
import { renderApp } from "../test/render";
import { useAppState } from "../state/app-state";
import { LeftRail } from "./LeftRail";

const tag = {
  id: "tag-security",
  name: "security",
  color: "#3b82f6",
  usageCount: 2,
};

function FilterStateProbe() {
  const { view, filters } = useAppState();
  return <output data-testid="filter-state">{JSON.stringify({ view, filters })}</output>;
}

describe("LeftRail tag filtering", () => {
  beforeEach(() => {
    const bridge = installMockBridge();
    bridge.tags.list.mockResolvedValue([tag]);
  });

  it("opens the library filtered to the clicked tag", async () => {
    const user = userEvent.setup();

    renderApp(
      <>
        <LeftRail />
        <FilterStateProbe />
      </>,
    );

    await user.click(await screen.findByRole("button", { name: /security/ }));

    expect(screen.getByTestId("filter-state")).toHaveTextContent(
      JSON.stringify({ view: { kind: "library" }, filters: { tagIds: [tag.id], starredOnly: false } }),
    );
  });

  it("clears the active tag filter when the same tag is clicked again", async () => {
    const user = userEvent.setup();

    renderApp(
      <>
        <LeftRail />
        <FilterStateProbe />
      </>,
    );

    const tagButton = await screen.findByRole("button", { name: /security/ });
    await user.click(tagButton);
    await user.click(tagButton);

    expect(screen.getByTestId("filter-state")).toHaveTextContent(
      JSON.stringify({ view: { kind: "library" }, filters: { tagIds: [], starredOnly: false } }),
    );
  });
});
