import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  openDatabase,
  PromptLibrary,
  resolveDatabasePath,
  resolvePrompt,
  resolveVersion,
  type PromptRow,
} from "@promptbranch/core";
import {
  buildSnapshotPayload,
  describeShareError,
  fetchSnapshot,
  publishSnapshot,
  resolvePortalBaseUrl,
  scanForSecrets,
  uniqueImportTitle,
  OFFICIAL_PORTAL_BASE_URL,
  type HistoryEntry,
} from "@promptbranch/share";

/**
 * PromptBranch CLI — same tool surface as the MCP server, for shell pipelines
 * and agents that don't speak MCP. Thin adapter over @promptbranch/core.
 * Every command supports --json for machine-readable output.
 */

const USAGE = `promptbranch — PromptBranch library CLI

Usage:
  promptbranch list [--tag t] [--collection c]
  promptbranch get <name-or-id> [--version n] [--branch b]
  promptbranch search <query> [--limit n]
  promptbranch report-run --prompt <name-or-id> [--version n] [--tool t] [--model m] [--outcome 1-5] [--summary "..."]
  promptbranch add-note --prompt <name-or-id> --body "..." [--version-id id]
  promptbranch suggest --prompt <name-or-id> (--file path | --content "...") [--rationale "..."] [--base-version n]
  promptbranch suggestions
  promptbranch publish <name-or-id> [--full-history] [--description "..."] [--portal <base-url>]
  promptbranch import <url-or-id> [--portal <base-url>]
  promptbranch db-path

Global flags:
  --json    Machine-readable JSON output

Database: ${resolveDatabasePath()}
(override with the PROMPTBRANCH_DB environment variable)
`;

class CliError extends Error {}

let library: PromptLibrary | null = null;

function getLibrary(): PromptLibrary {
  if (!library) {
    const dbPath = resolveDatabasePath();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const { db } = openDatabase(dbPath);
    library = new PromptLibrary(db);
  }
  return library;
}

function currentVersionLabel(lib: PromptLibrary, prompt: PromptRow): string | null {
  try {
    return resolveVersion(lib, prompt.id).label;
  } catch {
    return null;
  }
}

/** CLI builds are versioned with the app; keep in sync with package.json. */
const CLI_APP_VERSION = "promptbranch-cli/0.1.0";

/** --portal flag wins; then the library setting; then the official instance. */
function portalBaseUrl(lib: PromptLibrary, flag: string | undefined): string {
  if (flag) {
    const trimmed = flag.replace(/\/+$/, "");
    // Same http(s)-only rule the desktop enforces in setPortalBaseUrl.
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      throw new CliError("--portal must be a valid http(s) URL");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new CliError("--portal must be a valid http(s) URL");
    }
    return trimmed;
  }
  const stored = lib.getSetting("portal_base_url");
  return stored && stored.trim() ? stored.trim() : OFFICIAL_PORTAL_BASE_URL;
}

/** Oldest-first default-branch history for --full-history publishes. */
function branchHistory(lib: PromptLibrary, promptId: string): HistoryEntry[] {
  return lib
    .listDefaultBranchVersions(promptId)
    .map((v) => ({ version: v.number, content: v.content, changeNote: v.change_note ?? "" }));
}

/** Prints $1 as JSON when --json, otherwise calls the human formatter. */
function out(json: boolean, data: unknown, human: () => void): void {
  if (json) {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
  } else {
    human();
  }
}

function parseIntFlag(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new CliError(`--${name} must be a positive integer, got "${value}"`);
  return n;
}

const LIST_OPTS = {
  tag: { type: "string" },
  collection: { type: "string" },
  json: { type: "boolean" },
} as const;

const GET_OPTS = {
  version: { type: "string" },
  branch: { type: "string" },
  json: { type: "boolean" },
} as const;

const SEARCH_OPTS = {
  limit: { type: "string" },
  json: { type: "boolean" },
} as const;

const REPORT_RUN_OPTS = {
  prompt: { type: "string" },
  version: { type: "string" },
  tool: { type: "string" },
  model: { type: "string" },
  outcome: { type: "string" },
  summary: { type: "string" },
  json: { type: "boolean" },
} as const;

const ADD_NOTE_OPTS = {
  prompt: { type: "string" },
  "version-id": { type: "string" },
  body: { type: "string" },
  json: { type: "boolean" },
} as const;

const SUGGEST_OPTS = {
  prompt: { type: "string" },
  file: { type: "string" },
  content: { type: "string" },
  rationale: { type: "string" },
  "base-version": { type: "string" },
  json: { type: "boolean" },
} as const;

const NO_OPTS = { json: { type: "boolean" } } as const;

const PUBLISH_OPTS = {
  "full-history": { type: "boolean" },
  description: { type: "string" },
  portal: { type: "string" },
  json: { type: "boolean" },
} as const;

const IMPORT_OPTS = {
  portal: { type: "string" },
  json: { type: "boolean" },
} as const;

function required(value: string | undefined, flag: string): string {
  if (!value) throw new CliError(`Missing required flag --${flag}`);
  return value;
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return;
  }

  if (command === "db-path") {
    const { values } = parseArgs({ args: rest, options: NO_OPTS, strict: true });
    const resolvedPath = resolveDatabasePath();
    out(values.json ?? false, { path: resolvedPath }, () => {
      process.stdout.write(resolvedPath + "\n");
    });
    return;
  }

  const lib = getLibrary();

  switch (command) {
    case "list": {
      const { values } = parseArgs({ args: rest, options: LIST_OPTS, strict: true });
      const prompts = lib.listPrompts({
        ...(values.tag ? { tagIds: [tagIdByName(lib, values.tag)] } : {}),
        ...(values.collection ? { collectionId: collectionIdByName(lib, values.collection) } : {}),
      });
      const rows = prompts.map((p) => ({
        id: p.id,
        title: p.title,
        currentVersionLabel: currentVersionLabel(lib, p),
        updatedAt: p.updated_at,
      }));
      out(values.json ?? false, rows, () => {
        for (const row of rows) {
          process.stdout.write(`${row.title}\t${row.currentVersionLabel ?? "-"}\t${row.updatedAt}\t${row.id}\n`);
        }
        if (rows.length === 0) process.stdout.write("(no prompts)\n");
      });
      return;
    }

    case "get": {
      const { values, positionals } = parseArgs({ args: rest, options: GET_OPTS, strict: true, allowPositionals: true });
      const ref = positionals[0];
      if (!ref) throw new CliError("Usage: promptbranch get <name-or-id> [--version n] [--branch b]");
      const prompt = resolvePrompt(lib, ref);
      const resolved = resolveVersion(lib, prompt.id, {
        ...(values.version !== undefined ? { version: parseIntFlag(values.version, "version")! } : {}),
        ...(values.branch !== undefined ? { branch: values.branch } : {}),
      });
      if (values.json) {
        out(true, {
          id: prompt.id,
          title: prompt.title,
          versionId: resolved.version.id,
          versionLabel: resolved.label,
          branch: resolved.branchName,
          changeNote: resolved.version.change_note,
          content: resolved.version.content,
        }, () => {});
      } else {
        // Plain content on stdout so the command pipes cleanly.
        process.stdout.write(resolved.version.content);
        if (!resolved.version.content.endsWith("\n")) process.stdout.write("\n");
      }
      return;
    }

    case "search": {
      const { values, positionals } = parseArgs({ args: rest, options: SEARCH_OPTS, strict: true, allowPositionals: true });
      const query = positionals.join(" ").trim();
      if (!query) throw new CliError("Usage: promptbranch search <query> [--limit n]");
      const limit = parseIntFlag(values.limit, "limit") ?? 10;
      const rows = lib.search(query).slice(0, limit).map((r) => {
        const prompt = lib.getPrompt(r.promptId);
        return {
          promptId: r.promptId,
          title: r.title,
          snippet: r.snippet,
          currentVersionLabel: prompt ? currentVersionLabel(lib, prompt) : null,
        };
      });
      out(values.json ?? false, rows, () => {
        for (const row of rows) {
          process.stdout.write(`${row.title}\t${row.currentVersionLabel ?? "-"}\t${row.snippet}\t${row.promptId}\n`);
        }
        if (rows.length === 0) process.stdout.write("(no matches)\n");
      });
      return;
    }

    case "report-run": {
      const { values } = parseArgs({ args: rest, options: REPORT_RUN_OPTS, strict: true });
      const prompt = resolvePrompt(lib, required(values.prompt, "prompt"));
      const resolved = resolveVersion(lib, prompt.id, {
        ...(values.version !== undefined ? { version: parseIntFlag(values.version, "version")! } : {}),
      });
      const outcome = parseIntFlag(values.outcome, "outcome");
      if (outcome !== undefined && outcome > 5) throw new CliError("--outcome must be between 1 and 5");
      const run = lib.addRun({
        promptId: prompt.id,
        versionId: resolved.version.id,
        tool: values.tool ?? "cli",
        ...(values.model !== undefined ? { model: values.model } : {}),
        ...(outcome !== undefined ? { outcomeRating: outcome } : {}),
        ...(values.summary !== undefined ? { resultSummary: values.summary } : {}),
      });
      out(values.json ?? false, { runId: run.id, promptId: prompt.id, versionId: run.version_id, versionLabel: resolved.label }, () => {
        process.stdout.write(`Logged run ${run.id} for "${prompt.title}" (${resolved.label})\n`);
      });
      return;
    }

    case "add-note": {
      const { values } = parseArgs({ args: rest, options: ADD_NOTE_OPTS, strict: true });
      const prompt = resolvePrompt(lib, required(values.prompt, "prompt"));
      const note = lib.addNote({
        promptId: prompt.id,
        ...(values["version-id"] !== undefined ? { versionId: values["version-id"] } : {}),
        body: required(values.body, "body"),
      });
      out(values.json ?? false, { noteId: note.id, promptId: prompt.id }, () => {
        process.stdout.write(`Added note ${note.id} to "${prompt.title}"\n`);
      });
      return;
    }

    case "suggest": {
      const { values } = parseArgs({ args: rest, options: SUGGEST_OPTS, strict: true });
      const prompt = resolvePrompt(lib, required(values.prompt, "prompt"));
      if ((values.file !== undefined) === (values.content !== undefined)) {
        throw new CliError("suggest requires exactly one of --file or --content");
      }
      let newContent: string;
      if (values.file !== undefined) {
        newContent = fs.readFileSync(values.file, "utf8");
      } else {
        newContent = values.content!;
      }
      const base = resolveVersion(lib, prompt.id, {
        ...(values["base-version"] !== undefined ? { version: parseIntFlag(values["base-version"], "base-version")! } : {}),
      });
      const { branch, version } = lib.suggestVariation({
        promptId: prompt.id,
        baseVersionId: base.version.id,
        newContent,
        rationale: values.rationale ?? "Suggested via promptbranch CLI",
      });
      out(values.json ?? false, {
        status: "pending",
        promptId: prompt.id,
        branch: branch.name,
        versionId: version.id,
      }, () => {
        process.stdout.write(
          `Suggestion ${version.id} created on branch "${branch.name}" — PENDING human review in the PromptBranch app.\n`,
        );
      });
      return;
    }

    case "suggestions": {
      const { values } = parseArgs({ args: rest, options: NO_OPTS, strict: true });
      const rows = lib.listSuggestions().map((s) => ({
        versionId: s.id,
        promptId: s.prompt_id,
        promptTitle: s.prompt_title,
        branch: s.branch_name,
        baseVersionId: s.parent_version_id,
        rationale: s.change_note,
        source: s.source,
        createdAt: s.created_at,
      }));
      out(values.json ?? false, rows, () => {
        for (const row of rows) {
          process.stdout.write(`${row.promptTitle}\t${row.branch}\t${row.rationale ?? ""}\t${row.versionId}\n`);
        }
        if (rows.length === 0) process.stdout.write("(no pending suggestions)\n");
      });
      return;
    }

    case "publish": {
      const { values, positionals } = parseArgs({ args: rest, options: PUBLISH_OPTS, strict: true, allowPositionals: true });
      const ref = positionals[0];
      if (!ref) {
        throw new CliError('Usage: promptbranch publish <name-or-id> [--full-history] [--description "..."] [--portal <base-url>]');
      }
      const prompt = resolvePrompt(lib, ref);
      const current = resolveVersion(lib, prompt.id);
      const includeHistory = values["full-history"] ?? false;
      const base = portalBaseUrl(lib, values.portal);
      // Re-publishing links to the latest still-active share on this portal,
      // forming the public update chain (same rule as the desktop app).
      const parentId = lib
        .listSharedSnapshots(prompt.id)
        .find((record) => !record.deleted_at && record.portal_base_url === base)?.snapshot_id;
      const payload = buildSnapshotPayload({
        title: prompt.title,
        ...(values.description !== undefined ? { description: values.description } : {}),
        promptDescription: prompt.description,
        content: current.version.content,
        tags: lib.listTagsForPrompt(prompt.id).map((t) => t.name),
        ...(includeHistory ? { history: branchHistory(lib, prompt.id) } : {}),
        ...(parentId ? { parentId } : {}),
        appVersion: CLI_APP_VERSION,
      });
      // Scan the exact payload (same JSON shape the portal receives).
      const findings = scanForSecrets(JSON.stringify(payload, null, 2));
      const high = findings.filter((f) => f.severity === "high");
      if (high.length > 0) {
        if (values.json) {
          process.stdout.write(JSON.stringify({ ok: false, blocked: true, findings }, null, 2) + "\n");
        } else {
          process.stderr.write("Publishing blocked — high-severity findings:\n");
          for (const f of high) {
            process.stderr.write(`  line ${f.line}: ${f.rule} — ${f.match}\n`);
          }
        }
        process.exit(1);
      }
      if (!values.json && findings.length > 0) {
        process.stderr.write(`Warning: ${findings.length} medium-severity finding(s); publishing anyway.\n`);
      }
      const result0 = await publishSnapshot(base, payload);
      // Stale lineage (portal reset or parent purged): retry once unlinked.
      // Any other 400 just fails again — dropping parentId can't fix it.
      const result =
        !result0.ok && result0.error.kind === "http" && result0.error.status === 400 && payload.parentId
          ? await publishSnapshot(base, (({ parentId: _dropped, ...rest }) => rest)(payload))
          : result0;
      if (!result.ok) throw new CliError(describeShareError(result.error));
      lib.recordSharedSnapshot({
        snapshotId: result.value.id,
        promptId: prompt.id,
        portalBaseUrl: base,
        url: result.value.url,
        deleteToken: result.value.deleteToken,
        fullHistory: includeHistory,
        publishedAt: payload.publishedAt,
      });
      out(values.json ?? false, {
        ok: true,
        id: result.value.id,
        url: result.value.url,
        deleteToken: result.value.deleteToken,
        findings,
      }, () => {
        process.stdout.write(`Published "${prompt.title}": ${result.value.url}\n`);
        process.stdout.write(`Delete token (shown once, also stored locally): ${result.value.deleteToken}\n`);
      });
      return;
    }

    case "import": {
      const { values, positionals } = parseArgs({ args: rest, options: IMPORT_OPTS, strict: true, allowPositionals: true });
      const ref = positionals[0];
      if (!ref) throw new CliError("Usage: promptbranch import <url-or-id> [--portal <base-url>]");
      const base = resolvePortalBaseUrl(ref, portalBaseUrl(lib, values.portal));
      const result = await fetchSnapshot(base, ref);
      if (!result.ok) throw new CliError(describeShareError(result.error));
      const title = uniqueImportTitle(
        lib.listPrompts().map((p) => p.title),
        result.value.snapshot.title,
      );
      const provenance = `Imported from ${result.value.url}`;
      const prompt = lib.createPrompt({
        title,
        ...(result.value.snapshot.description ? { description: result.value.snapshot.description } : {}),
        tagNames: result.value.snapshot.tags,
        content: result.value.snapshot.content,
        changeNote: provenance,
        initialNote: provenance,
      });
      out(values.json ?? false, {
        ok: true,
        promptId: prompt.id,
        title: prompt.title,
        sourceUrl: result.value.url,
      }, () => {
        process.stdout.write(`Imported "${prompt.title}" (${prompt.id}) from ${result.value.url}\n`);
      });
      return;
    }

    default:
      throw new CliError(`Unknown command "${command}". Run "promptbranch help" for usage.`);
  }
}

function tagIdByName(lib: PromptLibrary, name: string): string {
  const tag = lib.listTags().find((t) => t.name.toLowerCase() === name.toLowerCase());
  if (!tag) throw new CliError(`Tag not found: "${name}"`);
  return tag.id;
}

function collectionIdByName(lib: PromptLibrary, name: string): string {
  const collection = lib.listCollections().find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (!collection) throw new CliError(`Collection not found: "${name}"`);
  return collection.id;
}

main(process.argv.slice(2)).catch((err: unknown) => {
  process.stderr.write(`promptbranch: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
