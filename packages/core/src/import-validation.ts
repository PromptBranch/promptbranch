import type {
  BranchRow, CollectionPromptRow, CollectionRow, NoteRow, PromptRow, PromptTagRow,
  ProviderModelRow, ProviderRow, RatingRow, RunRow, SettingRow, TagRow, VersionRow,
} from "./types.js";

export interface LibraryExport {
  meta: { formatVersion: 1; exportedAt: string };
  tables: {
    prompts: PromptRow[];
    branches: BranchRow[];
    versions: VersionRow[];
    notes: NoteRow[];
    tags: TagRow[];
    prompt_tags: PromptTagRow[];
    collections: CollectionRow[];
    collection_prompts: CollectionPromptRow[];
    ratings: RatingRow[];
    runs: RunRow[];
    settings: SettingRow[];
    /** Keys are device-bound and exported as null; absent in pre-v3 bundles. */
    providers?: ProviderRow[];
    /** Per-provider model visibility; absent in pre-v3 bundles. */
    provider_models?: ProviderModelRow[];
  };
}

export interface NormalizedLibraryExport extends LibraryExport {
  tables: Required<LibraryExport["tables"]>;
}
type Table = keyof NormalizedLibraryExport["tables"];
type TableRules = {
  [T in Table]: { [F in keyof NormalizedLibraryExport["tables"][T][number]]: FieldRule };
};

export interface LibraryImportIssue {
  path: string;
  code: string;
  message: string;
}

export class LibraryImportValidationError extends Error {
  readonly issues: LibraryImportIssue[];

  constructor(issues: LibraryImportIssue[]) {
    super(`Invalid library import: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`);
    this.name = "LibraryImportValidationError";
    this.issues = issues;
  }
}

type FieldRule = {
  kind: "string" | "id" | "timestamp" | "integer" | "flag" | "rating" | "enum";
  nullable?: boolean;
  values?: readonly string[];
  legacyDefault?: string | number | null | ((row: Record<string, unknown>) => unknown);
};
const text: FieldRule = { kind: "string" };
const nullableText: FieldRule = { kind: "string", nullable: true };
const id: FieldRule = { kind: "id" };
const nullableId: FieldRule = { kind: "id", nullable: true };
const timestamp: FieldRule = { kind: "timestamp" };
const integer: FieldRule = { kind: "integer" };
const flag: FieldRule = { kind: "flag" };
const rating: FieldRule = { kind: "rating", nullable: true };
const legacyNullableText: FieldRule = { ...nullableText, legacyDefault: null };

// This order is also the public issue order; field paths within each row sort lexically.
const rowRules = {
  prompts: {
    id, title: text, description: nullableText, icon: nullableText, draft_content: nullableText,
    draft_base_version_id: { ...nullableId, legacyDefault: null }, current_version_id: nullableId,
    is_starred: flag, created_at: timestamp, updated_at: timestamp,
    deleted_at: { ...timestamp, nullable: true },
  },
  branches: { id, prompt_id: id, name: text, description: nullableText, created_at: timestamp },
  versions: {
    id, prompt_id: id, branch_id: id, parent_version_id: nullableId, number: integer,
    label: nullableText, content: text, content_format: text, change_note: nullableText,
    author: text, created_at: timestamp,
    status: { kind: "enum", values: ["active", "pending", "rejected"], legacyDefault: "active" },
    source: { kind: "enum", values: ["user", "agent"], legacyDefault: "user" },
  },
  notes: { id, prompt_id: id, version_id: nullableId, body: text, created_at: timestamp },
  tags: { id, name: text, color: nullableText },
  prompt_tags: { prompt_id: id, tag_id: id },
  collections: { id, name: text, sort_order: integer },
  collection_prompts: { collection_id: id, prompt_id: id, sort_order: integer },
  ratings: {
    id, target_type: { kind: "enum", values: ["prompt", "version"] }, target_id: id,
    effectiveness: rating, clarity: rating, completeness: rating, actionability: rating,
    created_at: timestamp,
  },
  runs: {
    id, prompt_id: id, version_id: id, tool: text, model: nullableText,
    provider: { ...nullableId, legacyDefault: null },
    status: { kind: "enum", values: ["completed", "error"], legacyDefault: "completed" },
    output: legacyNullableText, prompt_content: legacyNullableText, error: legacyNullableText,
    latency_ms: { ...integer, nullable: true, legacyDefault: null },
    run_group_id: legacyNullableText, outcome_rating: rating, result_summary: nullableText,
    metrics_json: nullableText, started_at: { ...timestamp, nullable: true }, created_at: timestamp,
  },
  settings: { key: text, value: text },
  providers: {
    id, type: text, driver: { ...text, legacyDefault: (row: Record<string, unknown>) => row.type },
    name: text, api_key_enc: legacyNullableText, base_url: legacyNullableText,
    enabled: { ...flag, legacyDefault: 1 },
    created_at: { ...timestamp, legacyDefault: () => new Date().toISOString() },
  },
  provider_models: { provider_id: id, model_id: id, display_name: nullableText, enabled: flag },
} satisfies TableRules;
const tables = Object.keys(rowRules) as Table[];

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isTimestamp(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]! &&
    Number(match[4]) <= 23 && Number(match[5]) <= 59 && Number(match[6]) <= 59 &&
    (match[7] === undefined || (Number(match[7]) <= 23 && Number(match[8]) <= 59));
}

function validField(value: unknown, rule: FieldRule): boolean {
  if (value === null) return rule.nullable === true;
  switch (rule.kind) {
    case "string": return typeof value === "string";
    case "id": return typeof value === "string" && value.trim().length > 0;
    case "timestamp": return typeof value === "string" && isTimestamp(value);
    case "integer": return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
    case "flag": return value === 0 || value === 1;
    case "rating": return typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= 5;
    case "enum": return typeof value === "string" && rule.values!.includes(value);
  }
}

function orderIssues(issues: LibraryImportIssue[]): LibraryImportIssue[] {
  const key = (path: string): [number, number, string] => {
    const match = /^tables\.([^.[\]]+)(?:\[(\d+)\])?(.*)$/.exec(path);
    if (!match) return [-1, -1, path];
    return [tables.indexOf(match[1] as Table), Number(match[2] ?? -1), match[3]!];
  };
  return issues.sort((a, b) => {
    const ak = key(a.path);
    const bk = key(b.path);
    return ak[0] - bk[0] || ak[1] - bk[1] ||
      (ak[2] < bk[2] ? -1 : ak[2] > bk[2] ? 1 : 0);
  });
}

/** Validates only incoming data, before a destination database transaction exists. */
export function preflightLibraryImport(input: unknown): NormalizedLibraryExport {
  const issues: LibraryImportIssue[] = [];
  const issue = (path: string, code: string, message: string): void => {
    issues.push({ path, code, message });
  };
  const fail = (): never => { throw new LibraryImportValidationError(orderIssues(issues)); };
  if (!isRecord(input)) {
    issue("$", "invalid_type", "Expected a library object");
    return fail();
  }
  if (!isRecord(input.meta)) issue("meta", "invalid_type", "Expected a metadata object");
  else {
    if (input.meta.formatVersion !== 1) issue("meta.formatVersion", "invalid_format", "Expected format version 1");
    if (!validField(input.meta.exportedAt, timestamp)) {
      issue("meta.exportedAt", "invalid_value", "Expected an ISO timestamp");
    }
  }
  if (!isRecord(input.tables)) {
    issue("tables", "invalid_type", "Expected a tables object");
    return fail();
  }
  const parsed: Partial<Record<Table, Record<string, unknown>[]>> = {};
  for (const table of tables) {
    const raw = input.tables[table];
    if (raw === undefined && (table === "providers" || table === "provider_models")) {
      parsed[table] = [];
      continue;
    }
    if (!Array.isArray(raw)) {
      issue(`tables.${table}`, "invalid_type", "Expected an array of rows");
      continue;
    }
    parsed[table] = Array.from(raw, (row: unknown, index) => {
      const path = `tables.${table}[${index}]`;
      if (!isRecord(row)) {
        issue(path, "invalid_type", "Expected a plain-object row");
        return {};
      }
      const result: Record<string, unknown> = {};
      for (const [field, rule] of Object.entries<FieldRule>(rowRules[table])) {
        let value = row[field];
        if (value === undefined && Object.hasOwn(rule, "legacyDefault")) {
          value = typeof rule.legacyDefault === "function" ? rule.legacyDefault(row) : rule.legacyDefault;
        }
        if (!validField(value, rule)) {
          issue(`${path}.${field}`, "invalid_value", `Expected ${rule.kind}${rule.nullable ? " or null" : ""}`);
        }
        result[field] = value;
      }
      return result;
    });
  }
  if (issues.length) return fail();

  // Every table and primitive field has been checked and legacy fields filled above.
  const normalized = {
    meta: { formatVersion: 1, exportedAt: (input.meta as Record<string, unknown>).exportedAt },
    tables: parsed,
  } as unknown as NormalizedLibraryExport;
  const rows = normalized.tables;
  const indexRows = <T extends { id: string }>(table: Table, entries: T[]): Map<string, T> => {
    const index = new Map<string, T>();
    entries.forEach((row, i) => {
      if (index.has(row.id)) issue(`tables.${table}[${i}].id`, "duplicate_id", "Duplicate incoming id");
      else index.set(row.id, row);
    });
    return index;
  };
  const prompts = indexRows("prompts", rows.prompts);
  const branches = indexRows("branches", rows.branches);
  const versions = indexRows("versions", rows.versions);
  const tags = indexRows("tags", rows.tags);
  const collections = indexRows("collections", rows.collections);
  const providers = indexRows("providers", rows.providers);
  indexRows("notes", rows.notes);
  indexRows("runs", rows.runs);
  indexRows("ratings", rows.ratings);

  const reference = <T>(index: Map<string, T>, value: string | null, path: string): T | undefined => {
    if (value === null) return undefined;
    const row = index.get(value);
    if (!row) issue(path, "missing_reference", "Referenced row is absent from the incoming library");
    return row;
  };
  const ownedVersion = (value: string | null, promptId: string, path: string, active = false): void => {
    const version = reference(versions, value, path);
    if (version && version.prompt_id !== promptId) issue(path, "foreign_owner", "Version belongs to another prompt");
    if (version && active && version.status !== "active") issue(path, "inactive_version", "Version must be active");
  };
  rows.prompts.forEach((row, i) => {
    const path = `tables.prompts[${i}]`;
    ownedVersion(row.current_version_id, row.id, `${path}.current_version_id`, true);
    ownedVersion(row.draft_base_version_id, row.id, `${path}.draft_base_version_id`, true);
    if (row.draft_base_version_id !== null && row.draft_content === null) {
      issue(`${path}.draft_base_version_id`, "missing_draft", "A draft base requires draft content");
    }
  });
  rows.branches.forEach((row, i) => reference(prompts, row.prompt_id, `tables.branches[${i}].prompt_id`));
  rows.versions.forEach((row, i) => {
    const path = `tables.versions[${i}]`;
    reference(prompts, row.prompt_id, `${path}.prompt_id`);
    const branch = reference(branches, row.branch_id, `${path}.branch_id`);
    if (branch && branch.prompt_id !== row.prompt_id) issue(`${path}.branch_id`, "foreign_owner", "Branch belongs to another prompt");
    ownedVersion(row.parent_version_id, row.prompt_id, `${path}.parent_version_id`);
  });

  // A functional graph needs no recursion: walk each chain once, recording only
  // this walk's positions to distinguish a cycle from an already-checked ancestor.
  const visited = new Set<string>();
  const cyclic = new Set<string>();
  for (const start of versions.keys()) {
    const chain: string[] = [];
    const positions = new Map<string, number>();
    let current: string | null = start;
    while (current !== null && versions.has(current) && !visited.has(current)) {
      const position = positions.get(current);
      if (position !== undefined) {
        for (let i = position; i < chain.length; i += 1) cyclic.add(chain[i]!);
        break;
      }
      positions.set(current, chain.length);
      chain.push(current);
      current = versions.get(current)!.parent_version_id;
    }
    for (const value of chain) visited.add(value);
  }
  rows.versions.forEach((row, i) => {
    if (cyclic.has(row.id)) issue(`tables.versions[${i}].parent_version_id`, "parent_cycle", "Version ancestry contains a cycle");
  });
  for (const table of ["notes", "runs"] as const) {
    rows[table].forEach((row, i) => {
      reference(prompts, row.prompt_id, `tables.${table}[${i}].prompt_id`);
      ownedVersion(row.version_id, row.prompt_id, `tables.${table}[${i}].version_id`);
    });
  }
  rows.ratings.forEach((row, i) => {
    const path = `tables.ratings[${i}].target_id`;
    if (row.target_type === "prompt") reference(prompts, row.target_id, path);
    else reference(versions, row.target_id, path);
  });
  rows.prompt_tags.forEach((row, i) => {
    reference(prompts, row.prompt_id, `tables.prompt_tags[${i}].prompt_id`);
    reference(tags, row.tag_id, `tables.prompt_tags[${i}].tag_id`);
  });
  rows.collection_prompts.forEach((row, i) => {
    reference(collections, row.collection_id, `tables.collection_prompts[${i}].collection_id`);
    reference(prompts, row.prompt_id, `tables.collection_prompts[${i}].prompt_id`);
  });
  rows.provider_models.forEach((row, i) => reference(providers, row.provider_id, `tables.provider_models[${i}].provider_id`));

  const unique = <T>(table: Table, entries: T[], key: (row: T) => unknown, field = ""): void => {
    const seen = new Set<string>();
    entries.forEach((row, i) => {
      const value = JSON.stringify(key(row));
      if (seen.has(value)) issue(`tables.${table}[${i}]${field}`, "duplicate_key", "Duplicate incoming natural key or junction");
      seen.add(value);
    });
  };
  unique("tags", rows.tags, (row) => row.name, ".name");
  unique("collections", rows.collections, (row) => row.name, ".name");
  unique("branches", rows.branches, (row) => [row.prompt_id, row.name], ".name");
  unique("settings", rows.settings, (row) => row.key, ".key");
  unique("prompt_tags", rows.prompt_tags, (row) => [row.prompt_id, row.tag_id]);
  unique("collection_prompts", rows.collection_prompts, (row) => [row.collection_id, row.prompt_id]);
  unique("provider_models", rows.provider_models, (row) => [row.provider_id, row.model_id]);
  if (issues.length) return fail();
  return normalized;
}
