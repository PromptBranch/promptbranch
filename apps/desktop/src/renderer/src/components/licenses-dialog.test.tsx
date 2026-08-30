// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { installMockBridge } from "../test/mock-bridge";
import { renderApp } from "../test/render";
import { LicensesDialog } from "./LicensesDialog";

describe("LicensesDialog", () => {
  it("lists bundled packages with their licenses (mock fixture)", async () => {
    const bridge = installMockBridge();
    renderApp(<LicensesDialog open onOpenChange={vi.fn()} />);

    expect(await screen.findByText("alpha-pkg")).toBeInTheDocument();
    expect(screen.getByText("@beta-scope/beta-pkg")).toBeInTheDocument();
    expect(screen.getByText("MIT")).toBeInTheDocument();
    expect(screen.getByText("Apache-2.0")).toBeInTheDocument();
    expect(bridge.app.licensesText).toHaveBeenCalled();
    expect(screen.getByText("Showing 2 of 2 packages")).toBeInTheDocument();
  });

  it("filters the list by package name", async () => {
    installMockBridge();
    renderApp(<LicensesDialog open onOpenChange={vi.fn()} />);
    await screen.findByText("alpha-pkg");

    await userEvent.type(screen.getByLabelText("Search licenses"), "beta");
    expect(screen.queryByText("alpha-pkg")).not.toBeInTheDocument();
    expect(screen.getByText("@beta-scope/beta-pkg")).toBeInTheDocument();
    expect(screen.getByText("Showing 1 of 2 packages")).toBeInTheDocument();
  });

  it("expands an entry to show its license text", async () => {
    installMockBridge();
    renderApp(<LicensesDialog open onOpenChange={vi.fn()} />);
    await screen.findByText("alpha-pkg");

    await userEvent.click(screen.getByRole("button", { name: /alpha-pkg@1\.2\.3/ }));
    expect(screen.getByText("Fake MIT license text for alpha-pkg.")).toBeInTheDocument();
  });

  it("explains packages that ship no license file", async () => {
    installMockBridge();
    renderApp(<LicensesDialog open onOpenChange={vi.fn()} />);
    await screen.findByText("alpha-pkg");

    await userEvent.click(screen.getByRole("button", { name: /@beta-scope\/beta-pkg@2\.0\.0/ }));
    expect(screen.getByText(/declared license \(Apache-2\.0\) applies/)).toBeInTheDocument();
  });
});
