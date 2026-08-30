import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase, PromptLibrary } from "@promptbranch/core";

/**
 * End-to-end smoke test: seeds a temp library, spawns the built server over
 * stdio and drives initialize → tools/list → get_prompt → report_run →
 * suggest_variation through the real MCP client.
 */

let tmpDir: string;
let dbPath: string;
let promptTitle: string;
let client: Client;
let transport: StdioClientTransport;

function resultText(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  expect(content[0]?.type).toBe("text");
  return content[0]?.text ?? "";
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "promptbranch-mcp-test-"));
  dbPath = path.join(tmpDir, "library.db");

  const { db } = openDatabase(dbPath);
  const lib = new PromptLibrary(db);
  promptTitle = "Security audit";
  lib.createPrompt({
    title: promptTitle,
    description: "Reviews code for security issues",
    content: "You are a meticulous security auditor.",
    changeNote: "initial",
  });
  db.close();

  client = new Client({ name: "mcp-smoke-test", version: "0.0.0" });
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(import.meta.dirname, "..", "dist", "index.js")],
    env: { ...process.env, PROMPTBRANCH_DB: dbPath } as Record<string, string>,
    stderr: "pipe",
  });
  await client.connect(transport);
});

afterAll(async () => {
  await client.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("promptbranch-mcp smoke", () => {
  it("lists exactly the six documented tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "add_note",
      "get_prompt",
      "list_prompts",
      "report_run",
      "search_prompts",
      "suggest_variation",
    ]);
  });

  it("get_prompt resolves a fuzzy name and returns the current version", async () => {
    const result = await client.callTool({ name: "get_prompt", arguments: { prompt: "security AUDIT" } });
    const payload = JSON.parse(resultText(result)) as Record<string, unknown>;
    expect(payload["title"]).toBe(promptTitle);
    expect(payload["versionLabel"]).toBe("v1");
    expect(payload["content"]).toBe("You are a meticulous security auditor.");
  });

  it("search_prompts and list_prompts find the seeded prompt", async () => {
    const search = await client.callTool({ name: "search_prompts", arguments: { query: "auditor" } });
    const hits = JSON.parse(resultText(search)) as Array<Record<string, unknown>>;
    expect(hits).toHaveLength(1);
    expect(hits[0]!["title"]).toBe(promptTitle);
    expect(hits[0]!["currentVersionLabel"]).toBe("v1");

    const list = await client.callTool({ name: "list_prompts", arguments: {} });
    const prompts = JSON.parse(resultText(list)) as Array<Record<string, unknown>>;
    expect(prompts.map((p) => p["title"])).toContain(promptTitle);
  });

  it("report_run and add_note write rows visible in the DB", async () => {
    const run = await client.callTool({
      name: "report_run",
      arguments: { prompt: promptTitle, tool: "mcp", model: "test-model", outcomeRating: 5, resultSummary: "worked" },
    });
    const runPayload = JSON.parse(resultText(run)) as { runId: string; versionLabel: string };
    expect(runPayload.versionLabel).toBe("v1");

    const note = await client.callTool({
      name: "add_note",
      arguments: { prompt: promptTitle, body: "note from agent" },
    });
    expect(JSON.parse(resultText(note))).toMatchObject({ promptId: expect.any(String) });

    // Reopen the DB and verify the rows landed.
    const { db } = openDatabase(dbPath);
    const lib = new PromptLibrary(db);
    const prompt = lib.listPrompts()[0]!;
    const runs = lib.listRuns(prompt.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.tool).toBe("mcp");
    expect(runs[0]!.outcome_rating).toBe(5);
    expect(lib.listNotes(prompt.id).map((n) => n.body)).toContain("note from agent");
    db.close();
  });

  it("suggest_variation creates a pending suggestion, not an active version", async () => {
    const result = await client.callTool({
      name: "suggest_variation",
      arguments: {
        prompt: promptTitle,
        newContent: "You are a ruthless security auditor.",
        rationale: "Stronger persona found more issues in testing",
      },
    });
    const payload = JSON.parse(resultText(result)) as Record<string, unknown>;
    expect(payload["status"]).toBe("pending");
    expect(String(payload["branch"])).toMatch(/^agent-\d{8}-/);

    const { db } = openDatabase(dbPath);
    const lib = new PromptLibrary(db);
    const prompt = lib.listPrompts()[0]!;
    const suggestions = lib.listSuggestions();
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.prompt_title).toBe(promptTitle);
    // Current version unchanged; pending version invisible in default listing.
    expect(lib.listVersions(prompt.id)).toHaveLength(1);
    expect(prompt.current_version_id).not.toBe(suggestions[0]!.id);
    db.close();
  });

  it("returns a helpful error for unknown prompts", async () => {
    const result = await client.callTool({ name: "get_prompt", arguments: { prompt: "does-not-exist" } });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(resultText(result)).toMatch(/No prompt matches/);
  });
});
