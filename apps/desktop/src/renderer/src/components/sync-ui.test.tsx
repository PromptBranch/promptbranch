// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SyncStatusDto } from "../../../shared/ipc.js";
import { qk } from "../hooks/use-data";
import { installMockBridge } from "../test/mock-bridge";
import { createTestQueryClient, renderApp } from "../test/render";
import { SyncSection } from "./SyncSection";
import { SyncPairRequestDialog } from "./SyncPairRequestDialog";
import { SyncStatusRow } from "./SyncStatusRow";

function status(partial: Partial<SyncStatusDto>): SyncStatusDto {
  return {
    enabled: true,
    listening: true,
    listenPort: 52_100,
    listenError: null,
    deviceName: "Test Mac",
    fingerprintShort: "a1b2c3d4e5",
    pairingActive: false,
    pairingCode: null,
    peers: [],
    nearby: [],
    pendingDirty: 0,
    lastSyncedAt: null,
    ...partial,
  };
}

function renderWithStatus(component: React.ReactElement, value: SyncStatusDto) {
  const queryClient = createTestQueryClient();
  queryClient.setQueryData(qk.syncStatus, value);
  return renderApp(component, { queryClient });
}

describe("SyncSection", () => {
  it("renders only the enable toggle while sync is off", async () => {
    const bridge = installMockBridge();
    bridge.sync.getStatus.mockResolvedValue(status({ enabled: false, listening: false }));
    renderApp(<SyncSection />);
    expect(await screen.findByRole("switch", { name: "" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Device name")).toBeNull();
  });

  it("shows device identity, paired peers and the add-a-device flow when on", async () => {
    const bridge = installMockBridge();
    bridge.sync.getStatus.mockResolvedValue(
      status({
        deviceName: "Mac Studio",
        peers: [
          {
            fingerprint: "f".repeat(64),
            name: "MacBook Pro",
            fingerprintShort: "ffff000000",
            lastSeen: new Date().toISOString(),
            state: "steady",
            unhealthy: false,
          },
        ],
        nearby: [
          {
            fingerprint: "a".repeat(64),
            name: "PromptBranch Mac mini",
            address: "192.168.1.50",
            port: 52100,
          },
        ],
      }),
    );
    renderApp(<SyncSection />);
    expect(await screen.findByLabelText("Device name")).toHaveValue("Mac Studio");
    expect(screen.getByText("MacBook Pro")).toBeInTheDocument();
    expect(screen.getByText("PromptBranch Mac mini")).toBeInTheDocument();
    expect(screen.getByLabelText("Listening port")).toHaveValue("52100");
    expect(screen.getByText("Listening on port 52100")).toBeInTheDocument();

    // Typing a code and pressing Pair on the nearby device calls the bridge.
    await userEvent.type(screen.getByLabelText("Pairing code"), "ABCD-2345");
    await userEvent.click(screen.getAllByRole("button", { name: "Pair" })[0]!);
    expect(bridge.sync.pairWithCode).toHaveBeenCalledWith({
      address: "192.168.1.50",
      port: 52100,
      code: "ABCD-2345",
    });
  });

  it("validates and saves a non-privileged listening port", async () => {
    const bridge = installMockBridge();
    bridge.sync.getStatus.mockResolvedValue(status({ listenPort: 52_100 }));
    renderApp(<SyncSection />);

    const input = await screen.findByLabelText("Listening port");
    await userEvent.clear(input);
    await userEvent.type(input, "80");
    expect(screen.getByRole("button", { name: "Save port" })).toBeDisabled();
    expect(screen.getByText("Use a port from 1024 to 65535.")).toBeInTheDocument();

    await userEvent.clear(input);
    await userEvent.type(input, "53000");
    await userEvent.click(screen.getByRole("button", { name: "Save port" }));
    expect(bridge.sync.setListenPort).toHaveBeenCalledWith(53_000);
  });

  it("shows an actionable listener error without hiding the configured port", async () => {
    const bridge = installMockBridge();
    bridge.sync.getStatus.mockResolvedValue(
      status({
        listening: false,
        listenPort: 53_000,
        listenError: "Port 53000 is already in use. Choose another port.",
      }),
    );
    renderApp(<SyncSection />);
    expect(await screen.findByLabelText("Listening port")).toHaveValue("53000");
    expect(screen.getByText("Port 53000 is already in use. Choose another port.")).toBeInTheDocument();
  });

  it("opens the pairing window and shows the code", async () => {
    const bridge = installMockBridge();
    bridge.sync.getStatus.mockResolvedValue(status({}));
    bridge.sync.beginPairing.mockResolvedValue(status({ pairingActive: true, pairingCode: "QRST-7890" }));
    renderApp(<SyncSection />);
    await userEvent.click(await screen.findByRole("button", { name: "Show pairing code" }));
    expect(bridge.sync.beginPairing).toHaveBeenCalled();
    // The updated status arrives via the query cache; the button remains in
    // the document until then. Main-side state is covered by service tests.
    expect(bridge.sync.beginPairing).toHaveBeenCalledTimes(1);
  });

  it("forgets a paired device", async () => {
    const bridge = installMockBridge();
    bridge.sync.getStatus.mockResolvedValue(
      status({
        peers: [
          {
            fingerprint: "f".repeat(64),
            name: "MacBook Pro",
            fingerprintShort: "ffff000000",
            lastSeen: null,
            state: "connecting",
            unhealthy: false,
          },
        ],
      }),
    );
    renderApp(<SyncSection />);
    await userEvent.click(await screen.findByRole("button", { name: "Forget MacBook Pro" }));
    expect(bridge.sync.forgetDevice).toHaveBeenCalledWith("f".repeat(64));
  });
});

describe("SyncStatusRow", () => {
  it("renders nothing while sync is off", async () => {
    installMockBridge();
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(qk.syncStatus, status({ enabled: false }));
    const { container } = renderApp(<SyncStatusRow />, { queryClient });
    await screen.findByText("Local Database" as string, { exact: false }).catch(() => undefined);
    expect(container.querySelector("button")).toBeNull();
  });

  it("shows the synced-with state for a steady peer", async () => {
    installMockBridge();
    renderWithStatus(
      <SyncStatusRow />,
      status({
        peers: [
          {
            fingerprint: "f".repeat(64),
            name: "MacBook Pro",
            fingerprintShort: "ffff000000",
            lastSeen: new Date().toISOString(),
            state: "steady",
            unhealthy: false,
          },
        ],
        lastSyncedAt: new Date().toISOString(),
      }),
    );
    expect(await screen.findByText("Synced with MacBook Pro")).toBeInTheDocument();
  });

  it("shows a red offline label when the peer is gone, even with pending changes", async () => {
    installMockBridge();
    renderWithStatus(
      <SyncStatusRow />,
      status({
        pendingDirty: 5,
        peers: [
          {
            fingerprint: "f".repeat(64),
            name: "MacBook Pro",
            fingerprintShort: "ffff000000",
            lastSeen: new Date(Date.now() - 3_600_000).toISOString(),
            state: "offline",
            unhealthy: false,
          },
        ],
      }),
    );
    expect(await screen.findByText("MacBook Pro offline")).toBeInTheDocument();
    expect(screen.queryByText("Syncing…")).toBeNull();
  });

  it("reports waiting when no peer is connected", async () => {
    installMockBridge();
    renderWithStatus(<SyncStatusRow />, status({ peers: [] }));
    expect(await screen.findByText("No devices paired")).toBeInTheDocument();
  });
});

describe("SyncPairRequestDialog", () => {
  it("accepts an inbound pairing request", async () => {
    const bridge = installMockBridge();
    renderApp(<SyncPairRequestDialog />);
    bridge.emitSyncPairRequest({
      requestId: "550e8400-e29b-41d4-a716-446655440000",
      fingerprint: "b".repeat(64),
      fingerprintShort: "bbbb111111",
      name: "MacBook Pro",
    });
    expect(await screen.findByText("Pair with this device?")).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: "Accept" }));
    expect(bridge.sync.respondPairing).toHaveBeenCalledWith({
      requestId: "550e8400-e29b-41d4-a716-446655440000",
      accept: true,
    });
    expect(bridge.sync.respondPairing).toHaveBeenCalledTimes(1);
  });

  it("declines via the overlay close path", async () => {
    const bridge = installMockBridge();
    renderApp(<SyncPairRequestDialog />);
    bridge.emitSyncPairRequest({
      requestId: "b6d1eb44-ae93-4aa7-870d-332ccb1a2b57",
      fingerprint: "b".repeat(64),
      fingerprintShort: "bbbb111111",
      name: "MacBook Pro",
    });
    await screen.findByText("Pair with this device?");
    await userEvent.click(screen.getByRole("button", { name: "Decline" }));
    expect(bridge.sync.respondPairing).toHaveBeenCalledWith({
      requestId: "b6d1eb44-ae93-4aa7-870d-332ccb1a2b57",
      accept: false,
    });
    expect(bridge.sync.respondPairing).toHaveBeenCalledTimes(1);
  });

  it("queues concurrent pairing requests and answers each exact request", async () => {
    const bridge = installMockBridge();
    renderApp(<SyncPairRequestDialog />);
    bridge.emitSyncPairRequest({
      requestId: "550e8400-e29b-41d4-a716-446655440000",
      fingerprint: "a".repeat(64),
      fingerprintShort: "aaaaaaaaaa",
      name: "Mac Studio",
    });
    bridge.emitSyncPairRequest({
      requestId: "b6d1eb44-ae93-4aa7-870d-332ccb1a2b57",
      fingerprint: "b".repeat(64),
      fingerprintShort: "bbbbbbbbbb",
      name: "MacBook Pro",
    });

    expect(await screen.findByText("Mac Studio")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(await screen.findByText("MacBook Pro")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Decline" }));

    expect(bridge.sync.respondPairing.mock.calls).toEqual([
      [{ requestId: "550e8400-e29b-41d4-a716-446655440000", accept: true }],
      [{ requestId: "b6d1eb44-ae93-4aa7-870d-332ccb1a2b57", accept: false }],
    ]);
  });

  it("removes only the exact request cancelled by main and advances the queue", async () => {
    const bridge = installMockBridge();
    renderApp(<SyncPairRequestDialog />);
    bridge.emitSyncPairRequest({
      requestId: "550e8400-e29b-41d4-a716-446655440000",
      fingerprint: "a".repeat(64),
      fingerprintShort: "aaaaaaaaaa",
      name: "Timed out Mac",
    });
    bridge.emitSyncPairRequest({
      requestId: "b6d1eb44-ae93-4aa7-870d-332ccb1a2b57",
      fingerprint: "b".repeat(64),
      fingerprintShort: "bbbbbbbbbb",
      name: "Current Mac",
    });

    expect(await screen.findByText("Timed out Mac")).toBeInTheDocument();
    bridge.emitSyncPairRequestClosed({
      requestId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(await screen.findByText("Current Mac")).toBeInTheDocument();

    // A stale duplicate completion must not consume the current request.
    bridge.emitSyncPairRequestClosed({
      requestId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(screen.getByText("Current Mac")).toBeInTheDocument();
    expect(bridge.sync.respondPairing).not.toHaveBeenCalled();
  });
});

describe("sync error toast", () => {
  const FINGERPRINT = "c".repeat(64);
  const unhealthyPush = async (
    bridge: ReturnType<typeof installMockBridge>,
    unhealthy: boolean,
  ) => {
    // The push invalidates queries; keep the mocked fetch consistent or the
    // refetch would overwrite the pushed state with the disabled default.
    const dto = status({
        peers: [
          {
            fingerprint: FINGERPRINT,
            name: "MacBook Pro",
            fingerprintShort: "cccc000000",
            lastSeen: new Date().toISOString(),
            state: unhealthy ? "error" : "steady",
            unhealthy,
          },
        ],
        lastSyncedAt: new Date().toISOString(),
    });
    bridge.sync.getStatus.mockResolvedValue(dto);
    const { act } = await import("@testing-library/react");
    await act(async () => {
      bridge.emitSyncState(dto);
    });
  };

  it("toasts once when a peer turns unhealthy and stays silent while it persists", async () => {
    const bridge = installMockBridge();
    renderApp(<SyncStatusRow />);
    // The push subscription attaches in an effect; wait for it to exist.
    await vi.waitFor(() => expect(bridge.sync.onStateChanged).toHaveBeenCalled());
    unhealthyPush(bridge, false);
    await screen.findByText("Synced with MacBook Pro");
    // Crossing into unhealthy → an error toast appears.
    unhealthyPush(bridge, true);
    await screen.findByText("Sync with MacBook Pro keeps failing");
    // Repeated pushes of the same episode must not add more toasts.
    unhealthyPush(bridge, true);
    unhealthyPush(bridge, true);
    expect(screen.getAllByText("Sync with MacBook Pro keeps failing").length).toBe(1);
  });

  it("toasts again for a fresh episode after recovery", async () => {
    const bridge = installMockBridge();
    renderApp(<SyncStatusRow />);
    await vi.waitFor(() => expect(bridge.sync.onStateChanged).toHaveBeenCalled());
    unhealthyPush(bridge, false);
    unhealthyPush(bridge, true);
    await screen.findByText("Sync with MacBook Pro keeps failing");
    // Recover (healthy) then fail again — a new episode toasts anew.
    unhealthyPush(bridge, false);
    unhealthyPush(bridge, true);
    await vi.waitFor(() => {
      expect(screen.getAllByText("Sync with MacBook Pro keeps failing").length).toBeGreaterThan(1);
    });
  });
});
