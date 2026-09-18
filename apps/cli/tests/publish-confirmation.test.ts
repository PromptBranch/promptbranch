import { describe, expect, it, vi } from "vitest";
import { runConfirmedPublish } from "../src/publish-confirmation.js";

describe("runConfirmedPublish", () => {
  it("runs the publish callback for explicit --yes without reading input", async () => {
    const ask = vi.fn(async () => "no");
    const publish = vi.fn(async () => "published");

    await expect(
      runConfirmedPublish({ yes: true, interactive: false, ask, publish }),
    ).resolves.toEqual({ status: "approved", value: "published" });
    expect(ask).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledOnce();
  });

  it("does not call the publish callback when terminal confirmation is declined", async () => {
    const publish = vi.fn(async () => "published");

    await expect(
      runConfirmedPublish({
        yes: false,
        interactive: true,
        ask: async () => "no",
        publish,
      }),
    ).resolves.toEqual({ status: "declined" });
    expect(publish).not.toHaveBeenCalled();
  });

  it.each(["y", "yes", "Y", " YES "])("accepts %j as terminal approval", async (answer) => {
    const publish = vi.fn(async () => "published");

    await expect(
      runConfirmedPublish({
        yes: false,
        interactive: true,
        ask: async () => answer,
        publish,
      }),
    ).resolves.toEqual({ status: "approved", value: "published" });
    expect(publish).toHaveBeenCalledOnce();
  });

  it("requires --yes outside an interactive terminal without reading input", async () => {
    const ask = vi.fn(async () => "yes");
    const publish = vi.fn(async () => "published");

    await expect(
      runConfirmedPublish({ yes: false, interactive: false, ask, publish }),
    ).resolves.toEqual({ status: "requires-yes" });
    expect(ask).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
});
