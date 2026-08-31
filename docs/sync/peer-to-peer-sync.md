# Sync between your devices

PromptBranch syncs your library directly between your own desktop devices on a
local network or VPN. It does not require an account or a cloud copy of your
library. Changes remain saved locally while a device is offline and catch up
when paired devices can reach each other.

## Pair two devices

1. On both devices, open **Settings → Sync** and enable **Device-to-device
   sync**. On macOS, allow the Local Network permission when asked.
2. On one device, select **Show pairing code**.
3. On the other device, enter that code under **Add a device** and select the
   nearby device.
4. If the devices are connected through a VPN or do not appear nearby, use
   **Pair by address** and enter the other device's address and port.

Each pairing code confirms the other device's identity. After pairing,
PromptBranch connects only to that saved device unless you choose to forget it.

## What syncs

Prompts, versions, variations, tags, collections, notes, ratings, run records,
and share records sync. Changes made through the desktop app, CLI, or MCP
server all flow into the same library and are included.

Your API keys, app settings, and local model catalog stay on each device. A
paired device can manage a shared link because share revocation tokens sync
with the share record.

## Conflicts and status

Concurrent additions are retained. When two devices change the same small
prompt detail, PromptBranch chooses one consistent result and keeps the prompt
history available for review. Each device's sync footer shows whether it is
synced, syncing, waiting for devices, offline, or needs attention.

Select the footer or return to **Settings → Sync** to see paired devices, run
**Sync now**, rename this device, or forget a device. Forgetting a device stops
automatic reconnection; pair it again if you want to restore access.

## If pairing fails

- Confirm sync is enabled on both devices and re-open the pairing code.
- Check that both devices can reach each other on the same network or VPN.
- On macOS, check that PromptBranch has Local Network permission.
- Use **Pair by address** when network discovery is unavailable.
