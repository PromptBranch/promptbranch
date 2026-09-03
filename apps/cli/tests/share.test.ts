import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, PromptLibrary } from "@promptbranch/core";

/**
 * publish/import against a node:http stub portal and a scratch DB (the CLI
 * test script builds dist/index.js first, same as cli.test.ts).
 *
 * Note: the child is spawned asynchronously (not spawnSync) — a synchronous
 * spawn would block this process's event loop and the in-process stub portal
 * could never answer the child's request, deadlocking the suite.
 */

const CLI = path.join(import.meta.dirname, "..", "dist", "index.js");
const CLI_PACKAGE_VERSION = (
  JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "package.json"), "utf8")) as {
    version: string;
  }
).version;
const SNAPSHOT_ID = "V1StGXR8_Z5jdHi6B-myT";
const MALFORMED_SNAPSHOT_ID = "AAAAAAAAAAAAAAAAAAAAA";
const GONE_SNAPSHOT_ID = "CCCCCCCCCCCCCCCCCCCCC";

let tmpDir: string;
let dbPath: string;
let server: http.Server;
let portalBase: string;
let publishRequests = 0;
let lastPublished: Record<string, unknown> | null = null;
let publishMode: "success" | "rate-limit" | "http-500" | "malformed" | "stale-parent" = "success";

const importedSnapshot = {
  formatVersion: 1,
  title: "security-audit",
  description: "Audit code",
  content: "You are a security auditor.",
  tags: ["security", "Security"],
  publishedAt: "2026-08-25T12:00:00.000Z",
};

function run(args: string[]): Promise<{ stdout: string; stderr: string; status: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, PROMPTBRANCH_DB: dbPath },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, status: code ?? 1 }));
  });
}

function withLibrary<T>(fn: (lib: PromptLibrary) => T): T {
  const { db } = openDatabase(dbPath);
  try {
    return fn(new PromptLibrary(db));
  } finally {
    db.close();
  }
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/snapshots") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        publishRequests += 1;
        lastPublished = JSON.parse(body).snapshot;
        if (publishMode === "rate-limit") {
          res.writeHead(429, { "content-type": "application/json", "retry-after": "7" });
          res.end(JSON.stringify({ error: "slow down" }));
          return;
        }
        if (publishMode === "http-500") {
          res.writeHead(500, { "content-type": "text/plain" });
          res.end("portal exploded");
          return;
        }
        if (publishMode === "malformed") {
          res.writeHead(201, { "content-type": "application/json" });
          res.end(JSON.stringify({ id: "invalid" }));
          return;
        }
        if (publishMode === "stale-parent" && lastPublished?.["parentId"]) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "stale parent" }));
          return;
        }
        // Re-publishes get distinct ids: shared_snapshots.snapshot_id is the
        // primary key, so a second record with the same id would be rejected.
        const id =
          publishRequests === 1 ? SNAPSHOT_ID : SNAPSHOT_ID.slice(0, 20) + publishRequests.toString(36);
        res.writeHead(201, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id,
            url: `${portalBase}/p/${id}`,
            deleteToken: "test-delete-token",
          }),
        );
      });
      return;
    }
    if (req.method === "GET" && req.url === `/api/snapshots/${SNAPSHOT_ID}`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: SNAPSHOT_ID,
          url: `${portalBase}/p/${SNAPSHOT_ID}`,
          publishedAt: "2026-08-25T12:00:00.000Z",
          snapshot: importedSnapshot,
        }),
      );
      return;
    }
    if (req.method === "GET" && req.url === `/api/snapshots/${MALFORMED_SNAPSHOT_ID}`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: MALFORMED_SNAPSHOT_ID, snapshot: { title: "missing fields" } }));
      return;
    }
    if (req.method === "GET" && req.url === `/api/snapshots/${GONE_SNAPSHOT_ID}`) {
      res.writeHead(410, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "gone" }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  portalBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "promptbranch-cli-share-test-"));
  dbPath = path.join(tmpDir, "library.db");
  withLibrary((lib) => {
    const prompt = lib.createPrompt({
      title: "Code review",
      description: "Reviews diffs",
      content: "Review this diff.",
      changeNote: "first",
    });
    lib.createVersion({
      promptId: prompt.id,
      branchId: lib.listBranches(prompt.id)[0]!.id,
      content: "Review this diff carefully.",
      changeNote: "tighter",
    });
    const tag = lib.createTag({ name: "review" });
    lib.addTagToPrompt(prompt.id, tag.id);
    lib.createPrompt({ title: "Leaky", content: `key: sk-${"a".repeat(30)}` });
    lib.createPrompt({ title: "Internal URL", content: "Review http://10.0.0.8/admin carefully." });
  });
});

beforeEach(() => {
  publishMode = "success";
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("promptbranch publish", () => {
  it("publishes the current version, prints URL + token, records the share", async () => {
    const result = await run(["publish", "Code review", "--portal", portalBase, "--json"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toMatchObject({
      ok: true,
      id: SNAPSHOT_ID,
      url: `${portalBase}/p/${SNAPSHOT_ID}`,
      deleteToken: "test-delete-token",
    });
    // Payload sent to the portal: current content, prompt tags, no history.
    expect(lastPublished).toMatchObject({
      title: "Code review",
      description: "Reviews diffs",
      content: "Review this diff carefully.",
      tags: ["review"],
      appVersion: `promptbranch-cli/${CLI_PACKAGE_VERSION}`,
    });
    expect(lastPublished).not.toHaveProperty("history");

    const records = withLibrary((lib) => lib.listSharedSnapshots());
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      snapshot_id: SNAPSHOT_ID,
      delete_token: "test-delete-token",
      portal_base_url: portalBase,
      full_history: 0,
    });
  });

  it("--full-history sends the oldest-first branch history", async () => {
    const result = await run(["publish", "Code review", "--full-history", "--portal", portalBase, "--json"]);
    expect(result.status).toBe(0);
    expect(lastPublished?.["history"]).toEqual([
      { version: 1, content: "Review this diff.", changeNote: "first" },
      { version: 2, content: "Review this diff carefully.", changeNote: "tighter" },
    ]);
  });

  it("blocks on high-severity findings before any request, exit 1", async () => {
    const before = publishRequests;
    const result = await run(["publish", "Leaky", "--portal", portalBase]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/blocked/i);
    expect(result.stderr).toMatch(/openai-api-key/);
    expect(publishRequests).toBe(before);

    const json = await run(["publish", "Leaky", "--portal", portalBase, "--json"]);
    expect(json.status).toBe(1);
    const parsed = JSON.parse(json.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.findings.some((f: { rule: string }) => f.rule === "openai-api-key")).toBe(true);
  });

  it("rejects a non-http(s) --portal URL before any request", async () => {
    const before = publishRequests;
    const result = await run(["publish", "Code review", "--portal", "ftp://portal.example.com"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/http\(s\)/);
    expect(publishRequests).toBe(before);
  });

  it("warns for medium findings but still publishes", async () => {
    const before = publishRequests;
    const result = await run(["publish", "Internal URL", "--portal", portalBase]);
    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/Warning: 1 medium-severity finding/);
    expect(result.stdout).toContain("Published");
    expect(publishRequests).toBe(before + 1);
  });

  it.each([
    ["rate-limit", /retry in 7s/i],
    ["http-500", /HTTP 500.*portal exploded/i],
    ["malformed", /unexpected response/i],
  ] as const)("reports %s portal failures without recording a share", async (mode, message) => {
    publishMode = mode;
    const before = withLibrary((lib) => lib.listSharedSnapshots()).length;
    const result = await run(["publish", "Code review", "--portal", portalBase]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(message);
    expect(result.stderr).not.toMatch(/\n\s+at\s/);
    expect(withLibrary((lib) => lib.listSharedSnapshots())).toHaveLength(before);
  });

  it("retries a stale parent once without lineage", async () => {
    publishMode = "stale-parent";
    const before = publishRequests;
    const result = await run(["publish", "Code review", "--portal", portalBase, "--json"]);
    expect(result.status).toBe(0);
    expect(publishRequests).toBe(before + 2);
    expect(lastPublished).not.toHaveProperty("parentId");
  });
});

describe("promptbranch import", () => {
  it("creates a new prompt with tags and a provenance note", async () => {
    const result = await run(["import", `${portalBase}/p/${SNAPSHOT_ID}`, "--json"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toMatchObject({ ok: true, title: "security-audit" });

    withLibrary((lib) => {
      const prompt = lib.getPrompt(parsed.promptId)!;
      expect(prompt.description).toBe("Audit code");
      expect(lib.listTagsForPrompt(prompt.id).map((t) => t.name)).toEqual(["security"]);
      expect(lib.listVersions(prompt.id)[0]!.content).toBe("You are a security auditor.");
      expect(lib.listNotes(prompt.id).map((n) => n.body)).toEqual([
        `Imported from ${portalBase}/p/${SNAPSHOT_ID}`,
      ]);
    });
  });

  it("imports by raw id against --portal and suffixes title conflicts", async () => {
    const result = await run(["import", SNAPSHOT_ID, "--portal", portalBase, "--json"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).title).toBe("security-audit (imported)");
  });

  it("exits 1 for unknown snapshots", async () => {
    const result = await run(["import", `${portalBase}/p/BBBBBBBBBBBBBBBBBBBBB`, "--json"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/not found/i);
  });

  it("rejects a non-http(s) --portal URL", async () => {
    const result = await run(["import", SNAPSHOT_ID, "--portal", "ftp://portal.example.com"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/http\(s\)/);
  });

  it("handles deleted and malformed snapshots without partial imports", async () => {
    const before = withLibrary((lib) => lib.listPrompts()).length;

    const gone = await run(["import", GONE_SNAPSHOT_ID, "--portal", portalBase]);
    expect(gone.status).toBe(1);
    expect(gone.stderr).toMatch(/deleted/i);

    const malformed = await run(["import", MALFORMED_SNAPSHOT_ID, "--portal", portalBase]);
    expect(malformed.status).toBe(1);
    expect(malformed.stderr).toMatch(/unexpected response/i);
    expect(withLibrary((lib) => lib.listPrompts())).toHaveLength(before);
  });
});
