// Tools that read and write changologs databases.
//
// A database is a log with `is_database`; its children are the rows, each
// row's title is its Name, and the other columns are typed properties bound
// to the database's `log_columns`. The Rails side lives in the changologs
// repo (LogDatabasesController, LogColumnsController, LogViewsController,
// LogPropertiesController; docs/plans/2026-10-20-databases-design.md there).
//
// Unlike blocks.ts these tools call the API, so the handler takes an
// `ApiClient` -- server.ts and worker.ts each pass their own apiRequest.
//
// See docs/plans/2026-10-22-database-tools-design.md.

export type ApiClient = (path: string, options?: RequestInit) => Promise<any>;

export interface Choice { id: string; name: string; color: string }
export interface Column {
  id: number; name: string; kind: string; icon: string | null; position: number;
  options: { choices?: Choice[] };
}
export interface Filter { column_id: number; operator: string; value: string }
export interface Sort { column_id: number; direction: string }
export interface View {
  id: number; name: string | null; layout: string; filters: Filter[]; sorts: Sort[];
}
export interface Property { id: number; name: string; kind: string; value: unknown; column_id: number | null }
export interface Row {
  id: number; hash_id: string; title: string; title_text?: string; parent_id?: number | null;
  emoji?: string | null; properties: Property[];
}
interface DatabaseLog { id: number; hash_id: string; title: string; title_text?: string; board_hash_id: string }

// Mirrors LogProperty::KINDS, LogColumn::COLORS and LogView::OPERATORS.
export const COLUMN_KINDS = ["text", "number", "date", "datetime", "tags", "list", "checkbox", "url", "email", "phone", "person", "files"];
const COLORS = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"];
const OPERATORS = ["is", "is_not", "contains", "does_not_contain", "starts_with", "ends_with", "is_empty", "is_not_empty"];
const ROWS_PAGE_SIZE = 100;
// How far a row lookup by title pages through a database before giving up.
const MAX_ROW_PAGES = 10;

const KIND_LABELS: Record<string, string> = {
  list: "list (select)", tags: "tags (multi-select)", files: "files (File & media)",
};

const VALUE_FORMATS =
  "Values by column kind: text/url/email/phone/list -> string; number -> number; date -> \"YYYY-MM-DD\"; " +
  "datetime -> ISO 8601 with offset; checkbox -> boolean; tags -> array of strings; person -> array of user ids; " +
  "files -> array of {\"url\": \"https://...\", \"name\": \"optional label\"}. " +
  "A list/tags value that isn't one of the column's choices is added as a new choice. null clears a cell.";

// A files column is the one kind whose value isn't just data: each entry has
// to become a file the row owns before a cell may name it. Said here rather
// than left to the model to infer, because the failure is silent otherwise --
// a plausible-looking entry is refused by the server, not written wrong.
const FILES_FORMAT =
  "For a files (File & media) column, each entry is {\"url\": \"https://...\"} with an optional \"name\". " +
  "The server downloads the URL and keeps its own copy, so the file survives the URL going away; the URL must be " +
  "https and reachable from the internet (a local path can't be read from here). Add \"link\": true to store the " +
  "URL as a plain link instead of downloading it -- right for a page rather than a file, such as a Google Doc. " +
  "Entries are ADDED to whatever the cell already holds; pass null for the column to empty it. A cell holds 10 files.";

const databaseParam = {
  type: "string",
  description: "Title (or database_id) of the database. Use list_databases to see them.",
};
const workspaceParam = {
  type: "string",
  description: "Workspace the database is in. Defaults to the user's default workspace if omitted. Use list_workspaces to find available workspace ids.",
};
const valuesParam = {
  type: "object",
  description: `Cell values keyed by column name, e.g. {"Status": "Done", "Due": "2026-11-01"}. ${VALUE_FORMATS} ${FILES_FORMAT}`,
  additionalProperties: true,
};
const iconParam = {
  type: "string",
  description:
    "Emoji shown as the row's icon, e.g. \"🍗\". An emoji always goes here, never at the start of title -- changologs " +
    "renders the icon next to the title itself, so an emoji in both shows up twice. Empty string removes the icon.",
};
const coverParam = {
  type: "string",
  description:
    "Cover image banner across the top of the row's page. Either one of the five built-in covers " +
    "(\"/covers/cover_1.avif\" ... \"/covers/cover_5.avif\") or an https URL to an image, which the server downloads " +
    "and keeps so the cover can't rot. Empty string removes the cover.",
};

export const DATABASE_TOOLS = [
  {
    name: "list_databases",
    description: "List the databases in a workspace. A database is a log whose sub-logs are rows in a table with typed columns.",
    inputSchema: { type: "object", properties: { workspace_id: workspaceParam } },
  },
  {
    name: "get_database",
    description: "Get a database's schema: its columns (name, kind, select choices) and its views (with their filters and sorts).",
    inputSchema: {
      type: "object",
      properties: { database: databaseParam, workspace_id: workspaceParam },
      required: ["database"],
    },
  },
  {
    name: "query_database_rows",
    description: "List a database's rows as a table, narrowed and ordered by one of its views (the first view if omitted). Returns each row's row_id for update_database_row / delete_database_row. To filter or sort differently, change the view with update_database_view.",
    inputSchema: {
      type: "object",
      properties: {
        database: databaseParam,
        view_id: { type: "number", description: "View to apply. Use get_database to find view ids." },
        limit: { type: "number", description: `Rows per page, 1-${ROWS_PAGE_SIZE}. Defaults to ${ROWS_PAGE_SIZE}.` },
        cursor: { type: "number", description: "The cursor a previous call returned, to get the next page." },
        workspace_id: workspaceParam,
      },
      required: ["database"],
    },
  },
  {
    name: "create_database",
    description: "Create a new database, optionally with its columns. Every database also has a Name column, which is each row's title -- don't add it.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Title of the database." },
        columns: {
          type: "array",
          description: "Columns to create, in order.",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Column name, 1-50 characters." },
              kind: { type: "string", enum: COLUMN_KINDS, description: "Column kind. list is a single select, tags a multi-select, files a File & media column holding uploads and links." },
              choices: { type: "array", items: { type: "string" }, description: "Choices for a list/tags column." },
            },
            required: ["name", "kind"],
          },
        },
        workspace_id: { ...workspaceParam, description: "Workspace to create the database in. Defaults to the user's default workspace if omitted." },
      },
      required: ["title"],
    },
  },
  {
    name: "convert_log_to_database",
    description: "Turn an existing log into a database: its sub-logs become rows, and columns are built from the properties they already have. Safe to call again.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Title of the log to convert." },
        workspace_id: workspaceParam,
      },
      required: ["title"],
    },
  },
  {
    name: "add_database_column",
    description: "Add a column to a database. Rows that already have a property of that name fill the new column.",
    inputSchema: {
      type: "object",
      properties: {
        database: databaseParam,
        name: { type: "string", description: "Column name, 1-50 characters." },
        kind: { type: "string", enum: COLUMN_KINDS, description: "Column kind. list is a single select, tags a multi-select, files a File & media column holding uploads and links." },
        choices: { type: "array", items: { type: "string" }, description: "Choices for a list/tags column." },
        icon: { type: "string", description: "Optional emoji shown in the column header instead of the kind's icon." },
        position: { type: "number", description: "Index to insert the column at (0 = first). Defaults to last." },
        workspace_id: workspaceParam,
      },
      required: ["database", "name", "kind"],
    },
  },
  {
    name: "update_database_column",
    description: "Rename a database column, change its kind, icon or select choices. Changing the kind converts every cell, clearing values that don't fit the new kind.",
    inputSchema: {
      type: "object",
      properties: {
        database: databaseParam,
        column: { type: "string", description: "Current name of the column." },
        new_name: { type: "string", description: "New name, if renaming." },
        kind: { type: "string", enum: COLUMN_KINDS, description: "New kind." },
        icon: { type: "string", description: "New header emoji. Empty string goes back to the kind's icon." },
        choices: {
          type: "array", items: { type: "string" },
          description: "The full list of choices for a list/tags column, replacing the current ones (existing choices keep their colors).",
        },
        workspace_id: workspaceParam,
      },
      required: ["database", "column"],
    },
  },
  {
    name: "delete_database_column",
    description: "Delete a database column and every row's value in it.",
    inputSchema: {
      type: "object",
      properties: {
        database: databaseParam,
        column: { type: "string", description: "Name of the column to delete." },
        workspace_id: workspaceParam,
      },
      required: ["database", "column"],
    },
  },
  {
    name: "add_database_row",
    description: "Add a row to a database, with its title (the Name column), an optional emoji icon, an optional cover image and optional cell values.",
    inputSchema: {
      type: "object",
      properties: {
        database: databaseParam,
        title: { type: "string", description: "The row's title, i.e. its Name. Plain text -- any emoji goes in icon." },
        icon: iconParam,
        cover: coverParam,
        values: valuesParam,
        workspace_id: workspaceParam,
      },
      required: ["database", "title"],
    },
  },
  {
    name: "update_database_row",
    description:
      "Change a database row's title, icon, cover and/or cell values. Cells not mentioned are left as they are. " +
      "This is how a row gets an emoji -- set icon rather than writing the emoji into the title; setting icon also " +
      "takes a leftover emoji off the front of the title.",
    inputSchema: {
      type: "object",
      properties: {
        database: databaseParam,
        row: { type: "string", description: "The row's title or row_id (from query_database_rows)." },
        title: { type: "string", description: "New title, if renaming. Plain text -- any emoji goes in icon." },
        icon: iconParam,
        cover: coverParam,
        values: valuesParam,
        workspace_id: workspaceParam,
      },
      required: ["database", "row"],
    },
  },
  {
    name: "delete_database_row",
    description: "Move a database row (and its sub-pages) to the trash.",
    inputSchema: {
      type: "object",
      properties: {
        database: databaseParam,
        row: { type: "string", description: "The row's title or row_id (from query_database_rows)." },
        workspace_id: workspaceParam,
      },
      required: ["database", "row"],
    },
  },
  {
    name: "update_database_view",
    description: "Replace a database view's filters and/or sorts. This changes the saved view everyone sees in changologs, not just this query. Pass an empty array to clear filters or sorts.",
    inputSchema: {
      type: "object",
      properties: {
        database: databaseParam,
        view_id: { type: "number", description: "View to change. Defaults to the first view." },
        filters: {
          type: "array",
          description: "Every filter must match. Matching ignores case and compares text (any element for tags/person). is_not and does_not_contain keep empty cells.",
          items: {
            type: "object",
            properties: {
              column: { type: "string", description: "Column name." },
              operator: { type: "string", enum: OPERATORS },
              value: { type: "string", description: "Value to compare against. Not needed for is_empty / is_not_empty." },
            },
            required: ["column", "operator"],
          },
        },
        sorts: {
          type: "array",
          description: "Applied in order. Numbers sort as numbers, everything else as text; empty cells go last.",
          items: {
            type: "object",
            properties: {
              column: { type: "string", description: "Column name." },
              direction: { type: "string", enum: ["asc", "desc"] },
            },
            required: ["column", "direction"],
          },
        },
        workspace_id: workspaceParam,
      },
      required: ["database"],
    },
  },
];

const DATABASE_TOOL_NAMES = new Set(DATABASE_TOOLS.map((t) => t.name));

// ── Lookups ─────────────────────────────────────────────────────────────────

function workspaceQuery(workspaceId: string | undefined, prefix = "?"): string {
  return workspaceId ? `${prefix}workspace_id=${encodeURIComponent(workspaceId)}` : "";
}

function titleOf(log: { title: string; title_text?: string }): string {
  return log.title_text ?? log.title;
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

// One emoji at the start of a title: a pictograph with its skin tone and ZWJ
// sequence, a flag, or a keycap. A pictograph counts only when it is drawn as
// an emoji -- either by default or through a variation selector -- so a title
// opening with a text symbol such as a trademark or copyright sign keeps it.
const PICTOGRAPH = String.raw`(?:\p{Extended_Pictographic}\uFE0F|\p{Emoji_Presentation})\p{Emoji_Modifier}?`;
const LEADING_EMOJI = new RegExp(
  // A flag is a pair of regional indicators, and each of those is a
  // pictograph on its own, so it has to be tried before PICTOGRAPH.
  String.raw`^(\p{Regional_Indicator}{2}|[0-9#*]\uFE0F?\u20E3|${PICTOGRAPH}(?:\u200D${PICTOGRAPH})*)\s*`,
  "u",
);

// A row's emoji belongs in the log's icon, not in its title. Asked for "a
// chicken on that row" a model tends to write "🍗 Chicken" instead, and since
// changologs renders the icon beside the title the row then reads "🍗 🍗
// Chicken". So the leading emoji is always taken off the title, and becomes
// the icon when the call didn't give one.
export function splitIcon(title: string, icon?: string): { title: string; icon?: string } {
  let rest = title.trim();
  let found: string | undefined;
  for (;;) {
    const match = rest.match(LEADING_EMOJI);
    if (!match) break;
    const stripped = rest.slice(match[0].length).trim();
    // A title that is nothing but emoji stays as it is -- stripping it would
    // leave the row nameless.
    if (!stripped) break;
    found ??= match[1];
    rest = stripped;
  }
  return { title: rest, icon: icon ?? found };
}

// Looks the database up among the workspace's databases (not the global
// search), so the workspace it was found in is the one rows get created in.
async function findDatabase(api: ApiClient, ref: string, workspaceId?: string): Promise<DatabaseLog> {
  const data = await api(`/logs/databases${workspaceQuery(workspaceId)}`);
  const databases: DatabaseLog[] = data.logs ?? [];
  const matched =
    databases.find((d) => d.hash_id === ref) ??
    databases.find((d) => sameName(titleOf(d), ref)) ??
    databases.find((d) => titleOf(d).toLowerCase().includes(ref.trim().toLowerCase()));
  if (matched) return matched;
  const available = databases.map((d) => `"${titleOf(d)}"`).join(", ");
  throw new Error(`No database named "${ref}". ${available ? `Databases in this workspace: ${available}.` : "This workspace has no databases."}`);
}

interface RowsPage { columns: Column[]; views: View[]; rows: Row[]; next_cursor: number | null }

async function fetchRows(
  api: ApiClient, db: DatabaseLog, opts: { viewId?: number; cursor?: number; limit?: number } = {},
): Promise<RowsPage> {
  const query = new URLSearchParams();
  if (opts.viewId !== undefined) query.set("view_id", String(opts.viewId));
  if (opts.cursor !== undefined) query.set("cursor", String(opts.cursor));
  if (opts.limit !== undefined) query.set("limit", String(opts.limit));
  const qs = query.toString();
  return api(`/l/${db.hash_id}/rows${qs ? `?${qs}` : ""}`);
}

// The rows endpoint answers with the schema alongside a page of rows.
async function fetchSchema(api: ApiClient, db: DatabaseLog): Promise<{ columns: Column[]; views: View[] }> {
  const { columns, views } = await fetchRows(api, db, { limit: 1 });
  return { columns, views };
}

function findColumn(columns: Column[], name: string): Column {
  const column = columns.find((c) => sameName(c.name, name));
  if (column) return column;
  const available = columns.map((c) => `"${c.name}"`).join(", ");
  throw new Error(`No column named "${name}". ${available ? `Columns: ${available}.` : "The database has no columns yet."} (A row's title is its Name -- set it with title.)`);
}

// Pages through the first view's rows; a row its filters hide is found
// through the search instead.
async function findRow(api: ApiClient, db: DatabaseLog, ref: string, workspaceId?: string): Promise<Row> {
  const matches = (row: Row) => row.hash_id === ref || sameName(titleOf(row), ref);
  let cursor: number | undefined;
  for (let page = 0; page < MAX_ROW_PAGES; page++) {
    const data = await fetchRows(api, db, { cursor });
    const row = data.rows.find(matches);
    if (row) return row;
    if (data.next_cursor === null) break;
    cursor = data.next_cursor;
  }

  const search = await api(`/logs/search?query=${encodeURIComponent(ref)}${workspaceQuery(workspaceId, "&")}`);
  const hit = (search.logs ?? []).find((l: Row) => l.parent_id === db.id && matches(l));
  if (hit) {
    const { log } = await api(`/l/${hit.hash_id}`);
    return log;
  }
  throw new Error(`No row "${ref}" in database "${titleOf(db)}".`);
}

// ── Formatting ──────────────────────────────────────────────────────────────

// A checkbox without a cell is unchecked, so it reads "no" rather than blank.
export function formatValue(value: unknown, kind?: string): string {
  if (kind === "checkbox") return value === true ? "yes" : "no";
  if (value === null || value === undefined) return "";
  if (kind === "files") return formatFiles(value);
  if (Array.isArray(value)) return value.map(String).join(", ");
  if (typeof value === "boolean") return value ? "yes" : "";
  return String(value);
}

// A files cell is an array of entry objects, which String() would render as
// "[object Object]". Its name is the only part worth a table cell -- a blob
// id means nothing to a reader, and the URL is minted fresh on every read.
function formatFiles(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return String(entry);
      const { name, url } = entry as { name?: string; url?: string };
      return name || url || "file";
    })
    .join(", ");
}

function tableCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function viewLabel(view: View): string {
  return view.name ?? (view.layout === "table" ? "Table" : view.layout);
}

function describeFilters(view: View, columns: Column[]): string {
  const name = (id: number) => columns.find((c) => c.id === id)?.name ?? `(deleted column ${id})`;
  const filters = view.filters.map((f) =>
    `${name(f.column_id)} ${f.operator.replace(/_/g, " ")}${f.value ? ` "${f.value}"` : ""}`);
  const sorts = view.sorts.map((s) => `${name(s.column_id)} ${s.direction}`);
  return `filters: ${filters.length ? filters.join("; ") : "none"}; sorts: ${sorts.length ? sorts.join(", ") : "none"}`;
}

function describeColumns(columns: Column[]): string[] {
  return [
    "• Name — the row's title",
    ...columns.map((c) => {
      const choices = c.options?.choices ?? [];
      const choiceText = choices.length ? `: ${choices.map((ch) => ch.name).join(", ")}` : "";
      return `• ${c.icon ? `${c.icon} ` : ""}${c.name} — ${KIND_LABELS[c.kind] ?? c.kind}${choiceText}`;
    }),
  ];
}

export function renderRowsTable(columns: Column[], rows: Row[]): string {
  // Icon is its own column rather than a prefix on Name, so a title read back
  // out of here never carries the emoji into a rename. It only shows up once
  // a row has an icon, to keep the table narrow.
  const icons = rows.some((row) => row.emoji);
  const header = ["row_id", ...(icons ? ["Icon"] : []), "Name", ...columns.map((c) => c.name)];
  const lines = [
    `| ${header.map(tableCell).join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => {
      const cells = columns.map((c) => formatValue(row.properties.find((p) => p.column_id === c.id)?.value, c.kind));
      return `| ${[row.hash_id, ...(icons ? [row.emoji ?? ""] : []), titleOf(row), ...cells].map(tableCell).join(" | ")} |`;
    }),
  ];
  return lines.join("\n");
}

// ── Writes ──────────────────────────────────────────────────────────────────

// New choices get the next colors, as LogColumn#add_choices! does; existing
// ones keep their id and color.
export function buildChoices(names: string[], existing: Choice[] = []): Choice[] {
  let next = existing.length;
  return names.map((name) => {
    const known = existing.find((c) => sameName(c.name, name));
    if (known) return { ...known, name };
    return { id: crypto.randomUUID().replace(/-/g, "").slice(0, 8), name, color: COLORS[next++ % COLORS.length] };
  });
}

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
}

// The API refuses with {"error": "..."} (or {"errors": [...]}), which
// apiRequest wraps into `API error 422: {"error":"..."}`. Dig the sentence
// back out, so a tool says what is actually wrong instead of quoting a
// status line and a blob of JSON at the model.
export function apiErrorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const body = /^API error \d+: ([\s\S]*)$/.exec(text)?.[1];
  if (!body) return text;
  try {
    const parsed = JSON.parse(body);
    const message = parsed.error ?? (Array.isArray(parsed.errors) ? parsed.errors.join("; ") : undefined);
    return message || body;
  } catch {
    return body;
  }
}

interface FileInput { url?: string; name?: string; link?: boolean }

// Turns what a tool call names into the entries a files cell stores.
//
// A cell can only name a blob attached to its own row (LogProperty's
// files_are_attached), so every upload goes through the row's files endpoint
// first -- which, given a `url` rather than bytes, downloads it server-side.
// The MCP server runs nowhere near the user's disk, so a URL is the only
// thing it can be handed.
//
// Entries are added to what the cell already holds rather than replacing it:
// a files cell is a drawer, and "add this file" is what anyone asks for.
// Emptying it is `null`, which never reaches here.
async function resolveFiles(api: ApiClient, row: Row, current: unknown, value: unknown): Promise<unknown[]> {
  if (!Array.isArray(value)) {
    throw new Error(`A files value is a list of {"url": "https://...", "name": "..."}, not ${JSON.stringify(value)}.`);
  }
  const existing = Array.isArray(current) ? current : [];
  const added: unknown[] = [];
  for (const raw of value) {
    const input: FileInput = typeof raw === "string" ? { url: raw } : (raw as FileInput) ?? {};
    const url = input.url?.trim();
    if (!url) throw new Error(`Every file needs a url; got ${JSON.stringify(raw)}.`);
    added.push(input.link ? { type: "link", url, name: input.name || url } : await uploadFromUrl(api, row, url, input.name));
  }
  return [...existing, ...added];
}

async function uploadFromUrl(api: ApiClient, row: Row, url: string, name?: string): Promise<unknown> {
  let uploaded: { blob_id: string; name: string; content_type: string; size: number };
  try {
    uploaded = await api(`/l/${row.hash_id}/files`, { method: "POST", body: JSON.stringify({ url }) });
  } catch (error) {
    throw new Error(`Couldn't attach ${url}: ${apiErrorMessage(error)}`);
  }
  // The name the call gave wins over the one the download came with -- it is
  // what the caller meant the tile to read.
  return { type: "upload", blob_id: uploaded.blob_id, name: name || uploaded.name,
    content_type: uploaded.content_type, size: uploaded.size };
}

// A cover is either one of the built-in images (a path of ours, stored as
// it is) or a URL the server downloads and re-hosts, so the cover outlives
// the URL. An empty string takes it off.
export function coverBody(cover: string): Record<string, unknown> {
  const value = cover.trim();
  if (!value) return { cover: null };
  return /^https?:\/\//i.test(value) ? { cover_url: value } : { cover: value };
}

// Writes each value into the row's cell for that column: a PATCH when the
// cell exists, else a POST, which the API binds to the column of that name.
// Names that aren't columns are rejected up front rather than letting the
// API add a column for a typo.
async function writeValues(
  api: ApiClient, row: Row, columns: Column[], values: Record<string, unknown>,
): Promise<string[]> {
  const entries = Object.entries(values).map(([name, value]) => ({ column: findColumn(columns, name), value }));
  const written: string[] = [];
  for (const { column, value: raw } of entries) {
    const cell = row.properties.find((p) => p.column_id === column.id) ??
      row.properties.find((p) => sameName(p.name, column.name));
    // A files value is turned into stored entries first, which uploads each
    // one to the row. Done per column rather than up front because it needs
    // the cell that is already there to add to.
    const value = column.kind === "files" && !isEmpty(raw)
      ? await resolveFiles(api, row, cell?.value, raw)
      : raw;
    if (isEmpty(value) && !cell) continue;
    // Wrapped because a cell the server refuses is the common way a write
    // fails -- a value past a cap, a person who isn't a member -- and the
    // model needs the sentence, not "API error 422" and a blob of JSON.
    try {
      if (cell) {
        await api(`/l/${row.hash_id}/properties/${cell.id}`, { method: "PATCH", body: JSON.stringify({ value }) });
      } else {
        await api(`/l/${row.hash_id}/properties`, {
          method: "POST",
          body: JSON.stringify({ name: column.name, kind: column.kind, value }),
        });
      }
    } catch (error) {
      throw new Error(`Couldn't write ${column.name}: ${apiErrorMessage(error)}`);
    }
    written.push(`${column.name}: ${formatValue(value, column.kind) || "(cleared)"}`);
  }
  return written;
}

// Runs the writes that can only happen once a row exists, and trashes the row
// if one of them fails, so a failed add leaves no half-made row behind.
//
// The rollback is best-effort: if it too fails there is nothing further to try,
// and the original failure is the one worth reporting, so it is what propagates.
async function rollBackRowOnFailure<T>(api: ApiClient, row: Row, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    try {
      await api(`/l/${row.hash_id}`, { method: "DELETE" });
    } catch {
      // Keeping the original failure; the stray row is the lesser problem.
    }
    throw error;
  }
}

function filtersFor(columns: Column[], filters: Array<{ column: string; operator: string; value?: string }>): Filter[] {
  return filters.map((f) => {
    if (!OPERATORS.includes(f.operator)) throw new Error(`Unknown operator "${f.operator}". Use one of: ${OPERATORS.join(", ")}.`);
    return { column_id: findColumn(columns, f.column).id, operator: f.operator, value: f.value ?? "" };
  });
}

function sortsFor(columns: Column[], sorts: Array<{ column: string; direction: string }>): Sort[] {
  return sorts.map((s) => ({ column_id: findColumn(columns, s.column).id, direction: s.direction === "desc" ? "desc" : "asc" }));
}

// ── Dispatcher ──────────────────────────────────────────────────────────────

// Returns the tool's text result, or null if `name` isn't a database tool.
export async function callDatabaseTool(
  name: string, args: Record<string, unknown> | undefined, api: ApiClient,
): Promise<string | null> {
  if (!DATABASE_TOOL_NAMES.has(name)) return null;
  const a = args ?? {};
  const workspaceId = a.workspace_id as string | undefined;

  if (name === "list_databases") {
    const data = await api(`/logs/databases${workspaceQuery(workspaceId)}`);
    const databases: DatabaseLog[] = data.logs ?? [];
    if (!databases.length) return "No databases found.";
    return databases.map((d) => `• ${titleOf(d)} (database_id: ${d.hash_id})`).join("\n");
  }

  if (name === "create_database") {
    const data = await api(`/logs${workspaceQuery(workspaceId)}`, {
      method: "POST",
      body: JSON.stringify({ log: { title: a.title as string, text: "", is_database: true }, daily_note: false }),
    });
    const db = data.log as DatabaseLog;
    const columns = (a.columns as Array<{ name: string; kind: string; choices?: string[] }> | undefined) ?? [];
    let created: Column[] = [];
    for (const column of columns) {
      const body: Record<string, unknown> = { name: column.name, kind: column.kind };
      if (column.choices?.length) body.options = { choices: buildChoices(column.choices) };
      created = (await api(`/l/${db.hash_id}/columns`, { method: "POST", body: JSON.stringify(body) })).columns;
    }
    return [`Created database "${titleOf(db)}" (database_id: ${db.hash_id}). Columns:`, ...describeColumns(created)].join("\n");
  }

  if (name === "convert_log_to_database") {
    const title = a.title as string;
    const search = await api(`/logs/search?query=${encodeURIComponent(title)}${workspaceQuery(workspaceId, "&")}`);
    const logs: DatabaseLog[] = search.logs ?? [];
    if (!logs.length) throw new Error(`No log found with title "${title}".`);
    const log = logs.find((l) => sameName(titleOf(l), title)) ?? logs[0];
    const { columns } = await api(`/l/${log.hash_id}/database`, { method: "POST" });
    return [`"${titleOf(log)}" is now a database (database_id: ${log.hash_id}). Columns:`, ...describeColumns(columns)].join("\n");
  }

  const db = await findDatabase(api, a.database as string, workspaceId);

  if (name === "get_database") {
    const { columns, views } = await fetchSchema(api, db);
    return [
      `Database "${titleOf(db)}" (database_id: ${db.hash_id})`,
      "Columns:",
      ...describeColumns(columns),
      "Views:",
      ...views.map((v) => `• ${viewLabel(v)} (view_id: ${v.id}) — ${describeFilters(v, columns)}`),
    ].join("\n");
  }

  if (name === "query_database_rows") {
    const data = await fetchRows(api, db, {
      viewId: a.view_id as number | undefined,
      cursor: a.cursor as number | undefined,
      limit: a.limit as number | undefined,
    });
    const view = data.views.find((v) => v.id === a.view_id) ?? data.views[0];
    const heading = `Database "${titleOf(db)}"${view ? ` — view "${viewLabel(view)}" (${describeFilters(view, data.columns)})` : ""}`;
    if (!data.rows.length) return `${heading}\nNo rows.`;
    const more = data.next_cursor !== null ? `\nMore rows: call again with cursor ${data.next_cursor}.` : "";
    return `${heading}\n${renderRowsTable(data.columns, data.rows)}${more}`;
  }

  if (name === "add_database_column") {
    const body: Record<string, unknown> = { name: a.name, kind: a.kind };
    const choices = a.choices as string[] | undefined;
    if (choices?.length) body.options = { choices: buildChoices(choices) };
    if (a.icon) body.icon = a.icon;
    if (a.position !== undefined) body.position = a.position;
    const { columns } = await api(`/l/${db.hash_id}/columns`, { method: "POST", body: JSON.stringify(body) });
    return [`Added column "${a.name}" to "${titleOf(db)}". Columns:`, ...describeColumns(columns)].join("\n");
  }

  if (name === "update_database_column") {
    const { columns: current } = await fetchSchema(api, db);
    const column = findColumn(current, a.column as string);
    const body: Record<string, unknown> = {};
    if (a.new_name !== undefined) body.name = a.new_name;
    if (a.kind !== undefined) body.kind = a.kind;
    if (a.icon !== undefined) body.icon = (a.icon as string) || null;
    if (a.choices !== undefined) {
      body.options = { ...column.options, choices: buildChoices(a.choices as string[], column.options?.choices) };
    }
    const { columns } = await api(`/l/${db.hash_id}/columns/${column.id}`, { method: "PATCH", body: JSON.stringify(body) });
    return [`Updated column "${column.name}" in "${titleOf(db)}". Columns:`, ...describeColumns(columns)].join("\n");
  }

  if (name === "delete_database_column") {
    const { columns: current } = await fetchSchema(api, db);
    const column = findColumn(current, a.column as string);
    await api(`/l/${db.hash_id}/columns/${column.id}`, { method: "DELETE" });
    return `Deleted column "${column.name}" from "${titleOf(db)}".`;
  }

  if (name === "add_database_row") {
    const { columns } = await fetchSchema(api, db);
    const values = (a.values as Record<string, unknown> | undefined) ?? {};
    // Checked before the row exists, so a bad column name leaves nothing behind.
    Object.keys(values).forEach((key) => findColumn(columns, key));
    const { title, icon } = splitIcon(a.title as string, a.icon as string | undefined);
    const log: Record<string, unknown> = { title, text: "", parent_id: db.id };
    if (icon) log.emoji = icon;
    const data = await api(`/logs${workspaceQuery(workspaceId)}`, { method: "POST", body: JSON.stringify({ log }) });
    const row: Row = { ...data.log, properties: [] };
    // The cover and the cells can only be written once the row exists, so
    // either can fail with the row already created. An add that reports a
    // failure has to leave nothing behind -- otherwise a retry of the same
    // call, which is what a refused download invites, adds the row twice.
    const written = await rollBackRowOnFailure(api, row, async () => {
      // A cover URL is downloaded onto the row, which has to be there to
      // hang it on.
      if (a.cover !== undefined) {
        await api(`/boards/${db.board_hash_id}/logs/${row.hash_id}`, {
          method: "PUT", body: JSON.stringify({ log: coverBody(a.cover as string) }),
        });
      }
      return writeValues(api, row, columns, values);
    });
    const named = `"${titleOf(row)}"${icon ? ` with the icon ${icon}` : ""}`;
    const cover = a.cover ? ` with a cover` : "";
    return `Added row ${named}${cover} (row_id: ${row.hash_id}) to "${titleOf(db)}"${written.length ? ` — ${written.join("; ")}` : ""}.`;
  }

  if (name === "update_database_row") {
    const [{ columns }, row] = await Promise.all([fetchSchema(api, db), findRow(api, db, a.row as string, workspaceId)]);
    const values = (a.values as Record<string, unknown> | undefined) ?? {};
    Object.keys(values).forEach((key) => findColumn(columns, key));
    const changes: string[] = [];
    // Title and icon are one write. Setting the icon also cleans an emoji off
    // the front of the title, which is how a row an earlier call wrote as
    // "🍗 Chicken" stops showing the emoji twice.
    // The cover rides along: it is the same endpoint, and a cover URL the
    // server can't fetch should fail the call rather than half-apply it.
    if (a.title !== undefined || a.icon !== undefined || a.cover !== undefined) {
      const split = splitIcon((a.title as string | undefined) ?? titleOf(row), a.icon as string | undefined);
      const log: Record<string, unknown> = {};
      if (a.title !== undefined || split.title !== titleOf(row)) log.title = split.title;
      if (a.icon !== undefined) log.emoji = (a.icon as string) || null;
      else if (split.icon) log.emoji = split.icon;
      if (a.cover !== undefined) Object.assign(log, coverBody(a.cover as string));
      if (Object.keys(log).length) {
        try {
          await api(`/boards/${db.board_hash_id}/logs/${row.hash_id}`, { method: "PUT", body: JSON.stringify({ log }) });
        } catch (error) {
          throw new Error(apiErrorMessage(error));
        }
        if (log.title !== undefined) changes.push(`title: ${log.title}`);
        if (log.emoji !== undefined) changes.push(log.emoji ? `icon: ${log.emoji}` : "icon: removed");
        if (a.cover !== undefined) changes.push(a.cover ? `cover: ${a.cover}` : "cover: removed");
      }
    }
    changes.push(...await writeValues(api, row, columns, values));
    if (!changes.length) return `Nothing to change on "${titleOf(row)}".`;
    return `Updated row "${titleOf(row)}" (row_id: ${row.hash_id}) — ${changes.join("; ")}.`;
  }

  if (name === "delete_database_row") {
    const row = await findRow(api, db, a.row as string, workspaceId);
    await api(`/l/${row.hash_id}`, { method: "DELETE" });
    return `Moved row "${titleOf(row)}" to the trash.`;
  }

  if (name === "update_database_view") {
    const { columns, views } = await fetchSchema(api, db);
    const view = a.view_id !== undefined ? views.find((v) => v.id === a.view_id) : views[0];
    if (!view) throw new Error(`No view ${a.view_id ?? ""} in database "${titleOf(db)}".`);
    const body: Record<string, unknown> = {};
    if (a.filters !== undefined) body.filters = filtersFor(columns, a.filters as Array<{ column: string; operator: string; value?: string }>);
    if (a.sorts !== undefined) body.sorts = sortsFor(columns, a.sorts as Array<{ column: string; direction: string }>);
    const data = await api(`/l/${db.hash_id}/views/${view.id}`, { method: "PATCH", body: JSON.stringify(body) });
    const updated: View = (data.views as View[]).find((v) => v.id === view.id) ?? view;
    return `Updated view "${viewLabel(updated)}" of "${titleOf(db)}" — ${describeFilters(updated, columns)}.`;
  }

  throw new Error(`Unknown tool: ${name}`);
}
