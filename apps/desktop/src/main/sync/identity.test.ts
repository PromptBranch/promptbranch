import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  derivePairingCode,
  fingerprintOfCert,
  loadOrCreateIdentity,
} from "./identity.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pb-sync-identity-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("device identity", () => {
  it("creates once and is stable across reloads", async () => {
    const dir = tempDir();
    const first = await loadOrCreateIdentity(dir);
    const second = await loadOrCreateIdentity(dir);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.certPem).toBe(first.certPem);
    expect(second.pairingCode).toBe(first.pairingCode);
  });

  it("mints distinct identities per device", async () => {
    const a = await loadOrCreateIdentity(tempDir());
    const b = await loadOrCreateIdentity(tempDir());
    expect(a.fingerprint).not.toBe(b.fingerprint);
    expect(a.pairingCode).not.toBe(b.pairingCode);
  });

  it("fingerprint matches node's TLS view of the certificate", async () => {
    const identity = await loadOrCreateIdentity(tempDir());
    const tlsView = new X509Certificate(identity.certPem).fingerprint256.replace(/:/g, "").toLowerCase();
    expect(fingerprintOfCert(identity.certPem)).toBe(tlsView);
    expect(identity.fingerprint).toBe(tlsView);
  });

  it("pairing code format and derivation", async () => {
    const identity = await loadOrCreateIdentity(tempDir());
    expect(identity.pairingCode).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    expect(identity.pairingCode).toBe(derivePairingCode(identity.fingerprint));
    // A different fingerprint yields a different code.
    expect(derivePairingCode("0".repeat(64))).not.toBe(identity.pairingCode);
  });
});
