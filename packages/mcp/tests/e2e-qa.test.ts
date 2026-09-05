import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase, PromptLibrary } from "@promptbranch/core";

/** Release-QA journeys through the built MCP server and official stdio client. */
const MCP = path.join(import.meta.dirname, "..", "dist", "index.js");

let tmpDir: string;
let dbPath: string;
let primaryPromptId: string;
let primaryInitialVersionId: string;
let primaryVersionId: string;
let otherVersionId: string;
let variablePromptId: string;
let variableVersionId: string;
let client: Client;

function resultText(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  expect(content[0]?.type).toBe("text");
  return content[0]?.text ?? "";
}

function resultJson<T>(result: unknown): T {
  return JSON.parse(resultText(result)) as T;
}

async function connectClient(name: string): Promise<Client> {
  const next = new Client({ name, version: "0.0.0" });
  await next.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [MCP],
      env: { ...process.env, PROMPTBRANCH_DB: dbPath } as Record<string, string>,
      stderr: "pipe",
    }),
  );
  return next;
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "promptbranch-mcp-e2e-qa-"));
  dbPath = path.join(tmpDir, "library.db");

  const { db } = openDatabase(dbPath);
  const lib = new PromptLibrary(db);
  const security = lib.createTag({ name: "security" });
  const production = lib.createCollection({ name: "Production" });
  const primary = lib.createPrompt({
    title: "Protocol security audit",
    description: "Reviews protocol implementations",
    content: "Audit the protocol implementation carefully.",
    changeNote: "initial",
    tagIds: [security.id],
  });
  primaryPromptId = primary.id;
  primaryInitialVersionId = primary.current_version_id!;
  lib.addPromptToCollection(production.id, primary.id);
  const main = lib.listBranches(primary.id)[0]!;
  const v2 = lib.createVersion({
    promptId: primary.id,
    branchId: main.id,
    content: "Audit the protocol implementation and its trust boundaries.",
    changeNote: "add trust boundaries",
  });
  primaryVersionId = v2.id;
  lib.createBranch({ promptId: primary.id, name: "concise", fromVersionId: lib.listVersions(primary.id)[0]!.id });
  lib.setCurrentVersion(primary.id, v2.id);
  lib.addNote({ promptId: primary.id, body: "Pay special attention to replay resistance." });

  const other = lib.createPrompt({
    title: "Protocol security audit legacy",
    content: "Audit the legacy protocol.",
  });
  otherVersionId = lib.listVersions(other.id)[0]!.id;

  const variablePrompt = lib.createPrompt({
    title: "Parallel code review",
    content: "Review {{ target }} using {{number_of_agents}} agents. Re-check {{target}}.",
  });
  variablePromptId = variablePrompt.id;
  variableVersionId = lib.listVersions(variablePrompt.id)[0]!.id;

  for (let index = 1; index <= 12; index++) {
    lib.createPrompt({
      title: `MCP fixture ${String(index).padStart(2, "0")}`,
      content: `Fixture content ${index} with MCP marker.`,
    });
  }
  db.close();

  client = await connectClient("mcp-release-qa");
});

afterAll(async () => {
  await client.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("promptbranch MCP release QA", () => {
  it("advertises the npm package version during initialization", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(import.meta.dirname, "..", "package.json"), "utf8"),
    ) as { version: string };

    expect(client.getServerVersion()).toEqual({
      name: "promptbranch",
      version: packageJson.version,
    });
  });

  it("advertises only the six agent-safe tools with required schemas", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "add_note",
      "get_prompt",
      "list_prompts",
      "report_run",
      "search_prompts",
      "suggest_variation",
    ]);
    expect(tools.map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining(["publish", "import", "delete_prompt", "approve_suggestion"]),
    );

    const report = tools.find((tool) => tool.name === "report_run")!;
    expect(report.inputSchema.required).toEqual(expect.arrayContaining(["prompt", "tool"]));
    expect(report.inputSchema.properties).toHaveProperty("versionId");
    const suggestion = tools.find((tool) => tool.name === "suggest_variation")!;
    expect(suggestion.inputSchema.required).toEqual(
      expect.arrayContaining(["prompt", "newContent", "rationale"]),
    );
    expect(suggestion.inputSchema.properties).toHaveProperty("baseVersionId");
  });

  it("resolves current, numbered, and branch-specific prompt versions", async () => {
    const current = resultJson<Record<string, unknown>>(
      await client.callTool({ name: "get_prompt", arguments: { prompt: primaryPromptId } }),
    );
    expect(current).toMatchObject({
      status: "ready",
      versionId: primaryVersionId,
      versionLabel: "v2",
      branch: "main",
      requiredVariables: [],
      missingVariables: [],
    });

    const old = resultJson<Record<string, unknown>>(
      await client.callTool({ name: "get_prompt", arguments: { prompt: "PROTOCOL SECURITY AUDIT", version: 1 } }),
    );
    expect(old).toMatchObject({ versionLabel: "v1", branch: "main", content: "Audit the protocol implementation carefully." });

    const pinned = resultJson<Record<string, unknown>>(
      await client.callTool({
        name: "get_prompt",
        arguments: { prompt: primaryPromptId, versionId: primaryInitialVersionId },
      }),
    );
    expect(pinned).toMatchObject({
      versionId: primaryInitialVersionId,
      versionLabel: "v1",
      content: "Audit the protocol implementation carefully.",
    });

    const branch = resultJson<Record<string, unknown>>(
      await client.callTool({ name: "get_prompt", arguments: { prompt: primaryPromptId, branch: "CONCISE" } }),
    );
    expect(branch).toMatchObject({ versionLabel: "concise v1", branch: "concise" });
  });

  it("asks for unique prompt variables before returning execution-ready content", async () => {
    const unresolved = resultJson<Record<string, unknown>>(
      await client.callTool({ name: "get_prompt", arguments: { prompt: variablePromptId } }),
    );
    expect(unresolved).toMatchObject({
      status: "needs_input",
      versionId: variableVersionId,
      templateContent: "Review {{ target }} using {{number_of_agents}} agents. Re-check {{target}}.",
      content: "Review {{ target }} using {{number_of_agents}} agents. Re-check {{target}}.",
      requiredVariables: ["target", "number_of_agents"],
      missingVariables: ["target", "number_of_agents"],
    });
    expect(String(unresolved["message"])).toContain("ask the user");
  });

  it("does not partially render while required prompt variables are missing", async () => {
    const partial = resultJson<Record<string, unknown>>(
      await client.callTool({
        name: "get_prompt",
        arguments: {
          prompt: variablePromptId,
          variables: { target: "packages/core" },
        },
      }),
    );
    expect(partial).toMatchObject({
      status: "needs_input",
      content: "Review {{ target }} using {{number_of_agents}} agents. Re-check {{target}}.",
      requiredVariables: ["target", "number_of_agents"],
      missingVariables: ["number_of_agents"],
    });
  });

  it("renders supplied scalar prompt variables without changing the stored version", async () => {
    const ready = resultJson<Record<string, unknown>>(
      await client.callTool({
        name: "get_prompt",
        arguments: {
          prompt: variablePromptId,
          variables: { target: "packages/core", number_of_agents: 3 },
        },
      }),
    );
    expect(ready).toMatchObject({
      status: "ready",
      templateContent: "Review {{ target }} using {{number_of_agents}} agents. Re-check {{target}}.",
      content: "Review packages/core using 3 agents. Re-check packages/core.",
      requiredVariables: ["target", "number_of_agents"],
      missingVariables: [],
    });

    const { db } = openDatabase(dbPath);
    const lib = new PromptLibrary(db);
    expect(lib.getVersion(variableVersionId)?.content).toBe(
      "Review {{ target }} using {{number_of_agents}} agents. Re-check {{target}}.",
    );
    db.close();
  });

  it("rejects unknown prompt variable names without terminating the session", async () => {
    const invalid = await client.callTool({
      name: "get_prompt",
      arguments: {
        prompt: variablePromptId,
        variables: { target: "packages/core", number_of_agent: 3 },
      },
    });
    expect((invalid as { isError?: boolean }).isError).toBe(true);
    expect(resultText(invalid)).toContain('Unknown variable "number_of_agent"');

    const healthy = resultJson<Record<string, unknown>>(
      await client.callTool({ name: "get_prompt", arguments: { prompt: primaryPromptId } }),
    );
    expect(healthy).toMatchObject({ status: "ready", versionId: primaryVersionId });
  });

  it("returns actionable domain errors without terminating the session", async () => {
    const ambiguous = await client.callTool({ name: "get_prompt", arguments: { prompt: "protocol security" } });
    expect((ambiguous as { isError?: boolean }).isError).toBe(true);
    expect(resultText(ambiguous)).toContain("2 prompts match");
    expect(resultText(ambiguous)).toContain("Protocol security audit legacy");

    const missingBranch = await client.callTool({
      name: "get_prompt",
      arguments: { prompt: primaryPromptId, branch: "missing" },
    });
    expect((missingBranch as { isError?: boolean }).isError).toBe(true);
    expect(resultText(missingBranch)).toMatch(/No branch/);

    const competingSelectors = await client.callTool({
      name: "get_prompt",
      arguments: {
        prompt: primaryPromptId,
        versionId: primaryVersionId,
        version: 2,
      },
    });
    expect((competingSelectors as { isError?: boolean }).isError).toBe(true);
    expect(resultText(competingSelectors)).toMatch(/cannot be combined/i);

    const stillAlive = resultJson<Array<{ id: string }>>(
      await client.callTool({ name: "list_prompts", arguments: { tag: "SECURITY" } }),
    );
    expect(stillAlive).toEqual([expect.objectContaining({ id: primaryPromptId })]);
  });

  it("filters list and full-text search by tag and collection with limits", async () => {
    const list = resultJson<Array<{ id: string }>>(
      await client.callTool({ name: "list_prompts", arguments: { tag: "security", collection: "production" } }),
    );
    expect(list).toEqual([expect.objectContaining({ id: primaryPromptId })]);

    const noteHit = resultJson<Array<{ promptId: string }>>(
      await client.callTool({ name: "search_prompts", arguments: { query: "replay", tag: "security" } }),
    );
    expect(noteHit).toEqual([expect.objectContaining({ promptId: primaryPromptId })]);

    const limited = resultJson<unknown[]>(
      await client.callTool({ name: "search_prompts", arguments: { query: "MCP", limit: 3 } }),
    );
    expect(limited).toHaveLength(3);
  });

  it("persists run metrics and version-scoped notes across server restart", async () => {
    const run = resultJson<{ runId: string }>(
      await client.callTool({
        name: "report_run",
        arguments: {
          prompt: primaryPromptId,
          versionId: primaryVersionId,
          tool: "mcp-release-qa",
          model: "test/model",
          outcomeRating: 4,
          resultSummary: "Found one replay issue",
          metrics: { latencyMs: 321, inputTokens: 55 },
        },
      }),
    );
    expect(run.runId).toBeTruthy();

    const note = resultJson<{ noteId: string }>(
      await client.callTool({
        name: "add_note",
        arguments: { prompt: primaryPromptId, versionId: primaryVersionId, body: "Version-scoped MCP note" },
      }),
    );
    expect(note.noteId).toBeTruthy();

    await client.close();
    client = await connectClient("mcp-release-qa-restarted");

    const { db } = openDatabase(dbPath);
    const lib = new PromptLibrary(db);
    const persistedRun = lib.listRuns(primaryPromptId).find((row) => row.id === run.runId)!;
    expect(persistedRun).toMatchObject({ tool: "mcp-release-qa", model: "test/model", outcome_rating: 4 });
    expect(JSON.parse(persistedRun.metrics_json ?? "{}")).toEqual({ latencyMs: 321, inputTokens: 55 });
    expect(lib.listNotes(primaryPromptId, primaryVersionId).map((row) => row.body)).toContain(
      "Version-scoped MCP note",
    );
    db.close();
  });

  it("rejects a version id owned by another prompt without a partial note", async () => {
    const result = await client.callTool({
      name: "add_note",
      arguments: { prompt: primaryPromptId, versionId: otherVersionId, body: "must not persist" },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(resultText(result)).toMatch(/not found on prompt/);

    const { db } = openDatabase(dbPath);
    const lib = new PromptLibrary(db);
    expect(lib.listNotes(primaryPromptId).map((row) => row.body)).not.toContain("must not persist");
    db.close();
  });

  it("keeps suggested content pending, non-current, and unsearchable", async () => {
    const suggestion = resultJson<{ status: string; versionId: string }>(
      await client.callTool({
        name: "suggest_variation",
        arguments: {
          prompt: primaryPromptId,
          baseVersionId: primaryInitialVersionId,
          newContent: "MCP-PENDING-ONLY-CONTENT must not leak.",
          rationale: "Release QA authority check",
        },
      }),
    );
    expect(suggestion.status).toBe("pending");

    const current = resultJson<Record<string, unknown>>(
      await client.callTool({ name: "get_prompt", arguments: { prompt: primaryPromptId } }),
    );
    expect(current).toMatchObject({ versionId: primaryVersionId, versionLabel: "v2" });
    expect(resultJson<unknown[]>(
      await client.callTool({ name: "search_prompts", arguments: { query: "MCP-PENDING-ONLY-CONTENT" } }),
    )).toEqual([]);

    const { db } = openDatabase(dbPath);
    const lib = new PromptLibrary(db);
    expect(lib.listSuggestions().map((row) => row.id)).toContain(suggestion.versionId);
    expect(lib.getVersion(suggestion.versionId)?.parent_version_id).toBe(primaryInitialVersionId);
    expect(lib.listVersions(primaryPromptId).map((row) => row.id)).not.toContain(suggestion.versionId);
    db.close();
  });

  it.each([
    ["missing required tool", { name: "report_run", arguments: { prompt: "Protocol security audit" } }],
    ["out-of-range rating", { name: "report_run", arguments: { prompt: "Protocol security audit", tool: "qa", outcomeRating: 6 } }],
    ["zero search limit", { name: "search_prompts", arguments: { query: "audit", limit: 0 } }],
    ["empty suggestion", { name: "suggest_variation", arguments: { prompt: "Protocol security audit", newContent: "", rationale: "qa" } }],
  ])("rejects invalid schema input and stays alive: %s", async (_label, request) => {
    const invalid = await client.callTool(request);
    expect((invalid as { isError?: boolean }).isError).toBe(true);

    const healthy = resultJson<unknown[]>(await client.callTool({ name: "list_prompts", arguments: {} }));
    expect(healthy.length).toBeGreaterThan(10);
  });
});
