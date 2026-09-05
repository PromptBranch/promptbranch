import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import packageJson from "../package.json" with { type: "json" };
import {
  extractPromptVariables,
  missingPromptVariables,
  openDatabase,
  PromptLibrary,
  resolveDatabasePath,
  resolvePrompt,
  resolveVersion,
  substitutePromptVariables,
  type Database,
  type PromptVariableValue,
  type PromptRow,
} from "@promptbranch/core";

/**
 * PromptBranch MCP server (stdio). Thin adapter over @promptbranch/core —
 * agents read prompts and report runs/notes, and can *propose* variations that
 * stay pending until a human approves them in the desktop app.
 */

const dbPath = resolveDatabasePath();
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const { db } = openDatabase(dbPath);
const library = new PromptLibrary(db);

function text(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [
      { type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2) },
    ],
  };
}

function fail(err: unknown): { isError: true; content: Array<{ type: "text"; text: string }> } {
  return { isError: true, content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] };
}

function tagsForPrompt(db: Database, promptId: string): string[] {
  return (
    db
      .prepare(
        `SELECT t.name FROM tags t JOIN prompt_tags pt ON pt.tag_id = t.id
         WHERE pt.prompt_id = ? ORDER BY t.name COLLATE NOCASE ASC`,
      )
      .all(promptId) as Array<{ name: string }>
  ).map((t) => t.name);
}

function currentVersionLabel(prompt: PromptRow): string | null {
  try {
    return resolveVersion(library, prompt.id).label;
  } catch {
    return null;
  }
}

function tagIdByName(name: string): string {
  const tag = library.listTags().find((t) => t.name.toLowerCase() === name.toLowerCase());
  if (!tag) throw new Error(`Tag not found: "${name}"`);
  return tag.id;
}

function collectionIdByName(name: string): string {
  const collection = library.listCollections().find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (!collection) throw new Error(`Collection not found: "${name}"`);
  return collection.id;
}

const promptRef = z.string().min(1).describe("Prompt title (exact or unique substring) or id");
const versionNumber = z.number().int().positive().optional().describe("Per-branch version number; defaults to the current version");
const branchName = z.string().min(1).optional().describe("Branch name; defaults to the current version's branch");
const promptVariables = z
  .record(z.string(), z.union([z.string().max(100_000), z.number().finite(), z.boolean()]))
  .optional()
  .describe(
    "Values for {{variables}}. If the response says needs_input, ask the user for every missing variable and call get_prompt again.",
  );

const server = new McpServer({ name: "promptbranch", version: packageJson.version });

server.registerTool(
  "get_prompt",
  {
    description:
      "Fetch and render a prompt. If status is needs_input, do not execute content: ask the user for every missingVariables value, then call get_prompt again with variables. Execute content only when status is ready. Defaults to the current (preferred) version; pin with version and/or branch.",
    inputSchema: {
      prompt: promptRef,
      version: versionNumber,
      branch: branchName,
      variables: promptVariables,
    },
  },
  ({ prompt, version, branch, variables }) => {
    try {
      const row = resolvePrompt(library, prompt);
      const resolved = resolveVersion(library, row.id, { version, branch });
      const templateContent = resolved.version.content;
      const requiredVariables = extractPromptVariables(templateContent);
      const suppliedVariables: Record<string, PromptVariableValue> = variables ?? {};
      const unknownVariables = Object.keys(suppliedVariables).filter(
        (name) => !requiredVariables.includes(name),
      );
      if (unknownVariables.length > 0) {
        const noun = unknownVariables.length === 1 ? "variable" : "variables";
        throw new Error(
          `Unknown ${noun} ${unknownVariables.map((name) => `"${name}"`).join(", ")} for prompt "${row.title}"`,
        );
      }

      const missingVariables = missingPromptVariables(templateContent, suppliedVariables);
      const status = missingVariables.length > 0 ? "needs_input" : "ready";
      return text({
        status,
        id: row.id,
        title: row.title,
        description: row.description,
        versionId: resolved.version.id,
        versionLabel: resolved.label,
        branch: resolved.branchName,
        templateContent,
        content:
          status === "ready"
            ? substitutePromptVariables(templateContent, suppliedVariables)
            : templateContent,
        requiredVariables,
        missingVariables,
        ...(status === "needs_input"
          ? {
              message:
                "This prompt requires input. Do not execute content yet; ask the user for every missingVariables value, then call get_prompt again with variables.",
            }
          : {}),
        changeNote: resolved.version.change_note,
        tags: tagsForPrompt(db, row.id),
      });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "search_prompts",
  {
    description: "Full-text search over prompt titles, descriptions, tags, notes and version content.",
    inputSchema: {
      query: z.string().min(1),
      tag: z.string().min(1).optional().describe("Restrict to prompts carrying this tag (name)"),
      collection: z.string().min(1).optional().describe("Restrict to this collection (name)"),
      limit: z.number().int().min(1).max(100).optional().describe("Max results (default 10)"),
    },
  },
  ({ query, tag, collection, limit }) => {
    try {
      const results = library.search(query, {
        ...(tag ? { tagIds: [tagIdByName(tag)] } : {}),
        ...(collection ? { collectionId: collectionIdByName(collection) } : {}),
      });
      const capped = results.slice(0, limit ?? 10).map((r) => {
        const prompt = library.getPrompt(r.promptId);
        return {
          promptId: r.promptId,
          title: r.title,
          snippet: r.snippet,
          currentVersionLabel: prompt ? currentVersionLabel(prompt) : null,
        };
      });
      return text(capped);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "list_prompts",
  {
    description: "List prompts in the library, optionally filtered by collection or tag.",
    inputSchema: {
      collection: z.string().min(1).optional(),
      tag: z.string().min(1).optional(),
    },
  },
  ({ collection, tag }) => {
    try {
      const prompts = library.listPrompts({
        ...(collection ? { collectionId: collectionIdByName(collection) } : {}),
        ...(tag ? { tagIds: [tagIdByName(tag)] } : {}),
      });
      return text(
        prompts.map((p) => ({
          id: p.id,
          title: p.title,
          currentVersionLabel: currentVersionLabel(p),
          updatedAt: p.updated_at,
        })),
      );
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "report_run",
  {
    description:
      "Report that a prompt version was used: which tool/model ran it, the outcome rating (1–5) and a short result summary.",
    inputSchema: {
      prompt: promptRef,
      version: versionNumber,
      tool: z.string().min(1).max(100).describe("Tool that ran the prompt, e.g. 'kimi-cli', 'mcp'"),
      model: z.string().min(1).max(100).optional(),
      outcomeRating: z.number().int().min(1).max(5).optional(),
      resultSummary: z.string().max(100_000).optional(),
      metrics: z.record(z.string(), z.unknown()).optional().describe("Arbitrary structured metrics (tokens, latency…)"),
    },
  },
  ({ prompt, version, tool, model, outcomeRating, resultSummary, metrics }) => {
    try {
      const row = resolvePrompt(library, prompt);
      const resolved = resolveVersion(library, row.id, { version });
      const run = library.addRun({
        promptId: row.id,
        versionId: resolved.version.id,
        tool,
        ...(model !== undefined ? { model } : {}),
        ...(outcomeRating !== undefined ? { outcomeRating } : {}),
        ...(resultSummary !== undefined ? { resultSummary } : {}),
        ...(metrics !== undefined ? { metrics } : {}),
      });
      return text({ runId: run.id, promptId: row.id, versionId: resolved.version.id, versionLabel: resolved.label });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "add_note",
  {
    description: "Attach a freeform note to a prompt (or a specific version of it).",
    inputSchema: {
      prompt: promptRef,
      versionId: z.string().min(1).optional().describe("Specific version id; omit for a prompt-level note"),
      body: z.string().min(1).max(100_000),
    },
  },
  ({ prompt, versionId, body }) => {
    try {
      const row = resolvePrompt(library, prompt);
      const note = library.addNote({ promptId: row.id, ...(versionId !== undefined ? { versionId } : {}), body });
      return text({ noteId: note.id, promptId: row.id });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "suggest_variation",
  {
    description:
      "Propose a rewritten version of a prompt. Creates a PENDING suggestion that a human must approve in the PromptBranch app before it becomes usable — agents propose, humans approve.",
    inputSchema: {
      prompt: promptRef,
      baseVersion: versionNumber.describe("Version number to base the suggestion on; defaults to current"),
      newContent: z.string().min(1),
      rationale: z.string().min(1).max(2_000).describe("Why this change improves the prompt"),
    },
  },
  ({ prompt, baseVersion, newContent, rationale }) => {
    try {
      const row = resolvePrompt(library, prompt);
      const base = resolveVersion(library, row.id, baseVersion !== undefined ? { version: baseVersion } : {});
      const { branch, version } = library.suggestVariation({
        promptId: row.id,
        baseVersionId: base.version.id,
        newContent,
        rationale,
      });
      return text({
        status: "pending",
        promptId: row.id,
        branch: branch.name,
        versionId: version.id,
        message:
          "Suggestion recorded as PENDING. It is not active, not searchable and cannot be made current until a human approves it in the PromptBranch app (Suggestions view).",
      });
    } catch (err) {
      return fail(err);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[promptbranch-mcp] serving ${dbPath} over stdio`);

let closing = false;
const shutdown = () => {
  if (closing) return;
  closing = true;
  void server.close().then(() => {
    db.close();
    process.exit(0);
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
