import { describe, expect, it } from "vitest";
import { scanForSecrets } from "../src/scanner.js";

describe("scanForSecrets — high severity rules", () => {
  it("flags OpenAI keys, including sk-proj- variants", () => {
    const plain = scanForSecrets(`key: sk-${"a".repeat(30)}`);
    expect(plain).toHaveLength(1);
    expect(plain[0]).toMatchObject({ severity: "high", rule: "openai-api-key", line: 1 });

    const project = scanForSecrets(`sk-proj-${"b".repeat(30)}`);
    expect(project).toHaveLength(1);
    expect(project[0]).toMatchObject({ rule: "openai-api-key" });
  });

  it("flags Anthropic keys exactly once (not double-flagged as OpenAI)", () => {
    const findings = scanForSecrets(`sk-ant-api03-${"c".repeat(30)}`);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: "high", rule: "anthropic-api-key" });
  });

  it("flags Google API keys", () => {
    const findings = scanForSecrets(`AIza${"d".repeat(35)}`);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: "high", rule: "google-api-key" });
  });

  it("flags AWS access key ids", () => {
    const findings = scanForSecrets(`aws_key = AKIA${"E".repeat(16)}`);
    expect(findings.some((f) => f.rule === "aws-access-key" && f.severity === "high")).toBe(true);
  });

  it("flags GCP service account JSON", () => {
    const findings = scanForSecrets('{ "type": "service_account", "project_id": "x" }');
    expect(findings.some((f) => f.rule === "gcp-service-account" && f.severity === "high")).toBe(true);
  });

  it("flags GitHub tokens (classic, fine-grained, oauth)", () => {
    for (const token of [`ghp_${"f".repeat(36)}`, `github_pat_${"g".repeat(30)}`, `gho_${"h".repeat(36)}`]) {
      const findings = scanForSecrets(token);
      expect(findings.some((f) => f.rule === "github-token" && f.severity === "high")).toBe(true);
    }
  });

  it("flags Slack tokens", () => {
    const findings = scanForSecrets(`xoxb-${"1".repeat(12)}-${"2".repeat(12)}`);
    expect(findings.some((f) => f.rule === "slack-token" && f.severity === "high")).toBe(true);
  });

  it("flags PEM private key blocks", () => {
    const findings = scanForSecrets("-----BEGIN RSA PRIVATE KEY-----\nMIIE...");
    expect(findings.some((f) => f.rule === "pem-private-key" && f.severity === "high")).toBe(true);
  });

  it("flags high-entropy key assignments only above the entropy gate", () => {
    const flagged = scanForSecrets('api_key = "xK9mQ2vL8pR4nT7wZ3yB6cF"');
    expect(flagged.some((f) => f.rule === "high-entropy-assignment" && f.severity === "high")).toBe(true);

    // Low entropy (repeated characters) under the same shape is not flagged.
    const ignored = scanForSecrets(`api_key = "${"a".repeat(24)}"`);
    expect(ignored.some((f) => f.rule === "high-entropy-assignment")).toBe(false);
  });

  it("flags bearer/basic auth headers", () => {
    const findings = scanForSecrets("Authorization: Bearer abcdefgh12345678");
    expect(findings.some((f) => f.rule === "auth-header" && f.severity === "high")).toBe(true);
  });

  it("does not flag short lookalikes or prose", () => {
    expect(scanForSecrets("sk-short")).toHaveLength(0);
    expect(scanForSecrets("Use your password manager to store secrets.")).toHaveLength(0);
    expect(scanForSecrets('note = "a perfectly regular sentence here"')).toHaveLength(0);
  });
});

describe("scanForSecrets — medium severity rules", () => {
  it("flags internal hostnames and private-network URLs", () => {
    for (const text of [
      "http://localhost:5432/db",
      "https://wiki.corp/onboarding",
      "http://192.168.1.10:8080/admin",
      "http://10.0.0.4/internal",
      "https://nas.local/share",
    ]) {
      const findings = scanForSecrets(text);
      expect(findings.some((f) => f.rule === "internal-url" && f.severity === "medium")).toBe(true);
    }
  });

  it("flags email addresses", () => {
    const findings = scanForSecrets("Reach me at jane.doe@example.com for access.");
    expect(findings.some((f) => f.rule === "email-address" && f.severity === "medium")).toBe(true);
  });

  it("does not flag public URLs", () => {
    expect(scanForSecrets("Docs: https://example.com/docs and https://promptbranch.app")).toHaveLength(0);
  });
});

describe("scanForSecrets — reporting", () => {
  it("reports 1-based line numbers and sorts findings by line", () => {
    const text = `line one\nline two\nsk-${"a".repeat(30)}\ncontact jane@example.com`;
    const findings = scanForSecrets(text);
    expect(findings[0]).toMatchObject({ rule: "openai-api-key", line: 3 });
    expect(findings[1]).toMatchObject({ rule: "email-address", line: 4 });
  });

  it("truncates long matches to 80 characters", () => {
    const findings = scanForSecrets(`sk-${"a".repeat(100)}`);
    expect(findings[0]!.match).toHaveLength(80);
  });

  it("returns an empty array for clean text", () => {
    expect(scanForSecrets("You are a helpful assistant. Answer concisely.")).toEqual([]);
  });
});
