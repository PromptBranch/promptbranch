// @vitest-environment jsdom
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderApp } from "../test/render";
import { RateDialog } from "./dialogs";

function renderRateDialog(onSubmit = vi.fn(), onOpenChange = vi.fn()) {
  renderApp(<RateDialog open onOpenChange={onOpenChange} title="Rate v3" onSubmit={onSubmit} />);
  return { onSubmit, onOpenChange };
}

/** The labeled row of one rating dimension. */
function dimensionRow(label: string): HTMLElement {
  const row = screen.getByText(label).parentElement;
  if (!row) throw new Error(`row not found for ${label}`);
  return row;
}

describe("RateDialog", () => {
  it("keeps Save disabled until at least one dimension is rated", async () => {
    const user = userEvent.setup();
    renderRateDialog();
    const save = screen.getByRole("button", { name: /save rating/i });
    expect(save).toBeDisabled();

    const effectiveness = dimensionRow("Effectiveness");
    await user.click(within(effectiveness).getByRole("button", { name: "4 stars" }));
    expect(save).toBeEnabled();

    // Toggling the same star back off blocks saving again.
    await user.click(within(effectiveness).getByRole("button", { name: "4 stars" }));
    expect(save).toBeDisabled();
  });

  it("submits only the dimensions that were rated", async () => {
    const user = userEvent.setup();
    const { onSubmit, onOpenChange } = renderRateDialog();
    await user.click(within(dimensionRow("Effectiveness")).getByRole("button", { name: "4 stars" }));
    await user.click(within(dimensionRow("Clarity")).getByRole("button", { name: "2 stars" }));
    await user.click(screen.getByRole("button", { name: /save rating/i }));
    expect(onSubmit).toHaveBeenCalledWith({ effectiveness: 4, clarity: 2 });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
