import { X509Certificate, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import selfsigned from "selfsigned";

/**
 * Device identity for peer sync: a self-signed certificate whose SHA-256
 * fingerprint is the device's transport identity. The fingerprint doubles as
 * the pairing authenticator — the 8-char pairing code is derived from it, so
 * a man-in-the-middle presenting a different certificate produces a
 * different code and fails the check (a short authentication string).
 */

export interface DeviceIdentity {
  certPem: string;
  keyPem: string;
  /** SHA-256 of the certificate DER, lowercase hex (matches fingerprint256). */
  fingerprint: string;
  /** Human-facing short form, e.g. "a1b2c3d4e5". */
  fingerprintShort: string;
  /** Pairing code, "XXXX-XXXX" base32. */
  pairingCode: string;
}

const RFC4648 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function fingerprintOfCert(certPem: string): string {
  return new X509Certificate(certPem).fingerprint256.replace(/:/g, "").toLowerCase();
}

export function fingerprintShort(fingerprint: string): string {
  return fingerprint.slice(0, 10);
}

/** Deterministic 8-char code from the fingerprint — the pairing SAS. */
export function derivePairingCode(fingerprint: string): string {
  const digest = createHash("sha256").update(fingerprint, "utf8").digest();
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of digest) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < 8) {
      out += RFC4648[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    if (out.length >= 8) break;
  }
  return `${out.slice(0, 4)}-${out.slice(4, 8)}`;
}

async function mintIdentity(): Promise<DeviceIdentity> {
  // The common name is informational only; trust comes from the fingerprint.
  const keys = await selfsigned.generate(
    [{ name: "commonName", value: `promptbranch-${Date.now().toString(36)}` }],
    { keyType: "rsa", keySize: 2048, notAfterDate: new Date(Date.now() + 3650 * 86_400_000) },
  );
  const certPem = keys.cert;
  const keyPem = keys.private;
  const fingerprint = fingerprintOfCert(certPem);
  return {
    certPem,
    keyPem,
    fingerprint,
    fingerprintShort: fingerprintShort(fingerprint),
    pairingCode: derivePairingCode(fingerprint),
  };
}

/** Loads (or creates, 0600) the device identity under `dir`. */
export async function loadOrCreateIdentity(dir: string): Promise<DeviceIdentity> {
  const certPath = path.join(dir, "device.crt");
  const keyPath = path.join(dir, "device.key");
  try {
    const certPem = fs.readFileSync(certPath, "utf8");
    const keyPem = fs.readFileSync(keyPath, "utf8");
    const fingerprint = fingerprintOfCert(certPem);
    return { certPem, keyPem, fingerprint, fingerprintShort: fingerprintShort(fingerprint), pairingCode: derivePairingCode(fingerprint) };
  } catch (err) {
    // Only a missing identity is first-run; anything else (corrupt files,
    // permissions) must fail loudly rather than silently rotate the device
    // identity and orphan every pairing.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    const identity = await mintIdentity();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(certPath, identity.certPem, { mode: 0o644 });
    fs.writeFileSync(keyPath, identity.keyPem, { mode: 0o600 });
    return identity;
  }
}
