import { describe, expect, it } from "vitest";
import { buildChoices, callDatabaseTool, formatValue, renderRowsTable, splitIcon, type Column, type Row } from "./databases.js";

const DB = { id: 7, hash_id: "dbhash", title: "Tasks", title_text: "Tasks", board_hash_id: "board1" };
const COLUMNS: Column[] = [
  { id: 1, name: "Status", kind: "list", icon: null, position: 0, options: { choices: [{ id: "a1", name: "Todo", color: "gray" }] } },
  { id: 2, name: "Done", kind: "checkbox", icon: null, position: 1, options: {} },
  { id: 3, name: "Tags", kind: "tags", icon: null, position: 2, options: {} },
];
const VIEWS = [{ id: 11, name: null, layout: "table", filters: [], sorts: [] }];
const ROW: Row = {
  id: 20, hash_id: "row1", title: "Write docs", title_text: "Write docs",
  properties: [{ id: 100, name: "Status", kind: "list", value: "Todo", column_id: 1 }],
};

interface Call { path: string; method: string; body?: any }

// A fake API: records every call and answers by method + path prefix.
function fakeApi(routes: Record<string, (body: any, path: string) => any>) {
  const calls: Call[] = [];
  const api = async (path: string, options: RequestInit = {}) => {
    const method = options.method ?? "GET";
    const body = options.body ? JSON.parse(options.body as string) : undefined;
    calls.push({ path, method, body });
    const key = Object.keys(routes)
      .filter((k) => `${method} ${path}`.startsWith(k))
      .sort((x, y) => y.length - x.length)[0];
    if (!key) throw new Error(`Unexpected ${method} ${path}`);
    return routes[key](body, path);
  };
  return { api, calls };
}

const baseRoutes = {
  "GET /logs/databases": () => ({ logs: [DB] }),
  "GET /l/dbhash/rows": () => ({ columns: COLUMNS, views: VIEWS, rows: [ROW], next_cursor: null }),
};

describe("callDatabaseTool", () => {
  it("returns null for tools it doesn't own", async () => {
    const { api, calls } = fakeApi({});
    expect(await callDatabaseTool("create_log", {}, api)).toBeNull();
    expect(calls).toEqual([]);
  });

  it("lists databases in the given workspace", async () => {
    const { api, calls } = fakeApi(baseRoutes);
    const text = await callDatabaseTool("list_databases", { workspace_id: "ws 1" }, api);
    expect(calls[0].path).toBe("/logs/databases?workspace_id=ws%201");
    expect(text).toBe("• Tasks (database_id: dbhash)");
  });

  it("names the available databases when one isn't found", async () => {
    const { api } = fakeApi(baseRoutes);
    await expect(callDatabaseTool("get_database", { database: "Nope" }, api)).rejects.toThrow(
      'No database named "Nope". Databases in this workspace: "Tasks".',
    );
  });

  it("describes the schema", async () => {
    const { api } = fakeApi(baseRoutes);
    const text = await callDatabaseTool("get_database", { database: "tasks" }, api);
    expect(text).toContain("• Status — list (select): Todo");
    expect(text).toContain("• Table (view_id: 11) — filters: none; sorts: none");
  });

  it("renders rows as a table with the next cursor", async () => {
    const { api, calls } = fakeApi({
      ...baseRoutes,
      "GET /l/dbhash/rows": () => ({ columns: COLUMNS, views: VIEWS, rows: [ROW], next_cursor: 1 }),
    });
    const text = await callDatabaseTool("query_database_rows", { database: "Tasks", limit: 1, view_id: 11 }, api);
    expect(calls[1].path).toBe("/l/dbhash/rows?view_id=11&limit=1");
    expect(text).toContain("| row1 | Write docs | Todo | no |  |");
    expect(text).toContain("call again with cursor 1");
  });

  it("adds a row in the database's workspace and fills its cells", async () => {
    const { api, calls } = fakeApi({
      ...baseRoutes,
      "POST /logs": () => ({ log: { id: 21, hash_id: "row2", title: "New", title_text: "New" } }),
      "POST /l/row2/properties": () => ({ properties: [] }),
    });
    const text = await callDatabaseTool(
      "add_database_row",
      { database: "Tasks", title: "New", values: { status: "Doing", Tags: [] }, workspace_id: "ws" },
      api,
    );
    const create = calls.find((c) => c.method === "POST" && c.path.startsWith("/logs"))!;
    expect(create.path).toBe("/logs?workspace_id=ws");
    expect(create.body).toEqual({ log: { title: "New", text: "", parent_id: 7 } });
    // The empty Tags value creates no cell.
    const cells = calls.filter((c) => c.path === "/l/row2/properties");
    expect(cells.map((c) => c.body)).toEqual([{ name: "Status", kind: "list", value: "Doing" }]);
    expect(text).toBe('Added row "New" (row_id: row2) to "Tasks" — Status: Doing.');
  });

  it("rejects an unknown column before creating the row", async () => {
    const { api, calls } = fakeApi(baseRoutes);
    await expect(
      callDatabaseTool("add_database_row", { database: "Tasks", title: "New", values: { Priority: "High" } }, api),
    ).rejects.toThrow('No column named "Priority"');
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("updates existing cells in place and creates missing ones", async () => {
    const { api, calls } = fakeApi({
      ...baseRoutes,
      "PUT /boards/board1/logs/row1": () => ({ log: {} }),
      "PATCH /l/row1/properties/100": () => ({ properties: [] }),
      "POST /l/row1/properties": () => ({ properties: [] }),
    });
    await callDatabaseTool(
      "update_database_row",
      { database: "Tasks", row: "write docs", title: "Write the docs", values: { Status: null, Done: true } },
      api,
    );
    const writes = calls.filter((c) => c.method !== "GET");
    expect(writes).toEqual([
      { path: "/boards/board1/logs/row1", method: "PUT", body: { log: { title: "Write the docs" } } },
      { path: "/l/row1/properties/100", method: "PATCH", body: { value: null } },
      { path: "/l/row1/properties", method: "POST", body: { name: "Done", kind: "checkbox", value: true } },
    ]);
  });

  it("adds a row's emoji as its icon, not as part of its title", async () => {
    const { api, calls } = fakeApi({
      ...baseRoutes,
      "POST /logs": (body) => ({ log: { id: 21, hash_id: "row2", title: body.log.title, title_text: body.log.title } }),
    });
    const text = await callDatabaseTool("add_database_row", { database: "Tasks", title: "Chicken", icon: "🍗" }, api);
    const create = calls.find((c) => c.method === "POST")!;
    expect(create.body).toEqual({ log: { title: "Chicken", text: "", parent_id: 7, emoji: "🍗" } });
    expect(text).toBe('Added row "Chicken" with the icon 🍗 (row_id: row2) to "Tasks".');
  });

  it("moves an emoji written into a new row's title over to its icon", async () => {
    const { api, calls } = fakeApi({
      ...baseRoutes,
      "POST /logs": (body) => ({ log: { id: 21, hash_id: "row2", title: body.log.title, title_text: body.log.title } }),
    });
    await callDatabaseTool("add_database_row", { database: "Tasks", title: "🍗 🍗 Chicken" }, api);
    expect(calls.find((c) => c.method === "POST")!.body).toEqual(
      { log: { title: "Chicken", text: "", parent_id: 7, emoji: "🍗" } },
    );
  });

  it("sets a row's icon and takes the emoji back off its title", async () => {
    const titled: Row = { ...ROW, title: "🍗 Chicken", title_text: "🍗 Chicken" };
    const { api, calls } = fakeApi({
      ...baseRoutes,
      "GET /l/dbhash/rows": () => ({ columns: COLUMNS, views: VIEWS, rows: [titled], next_cursor: null }),
      "PUT /boards/board1/logs/row1": () => ({ log: {} }),
    });
    const text = await callDatabaseTool("update_database_row", { database: "Tasks", row: "row1", icon: "🍗" }, api);
    expect(calls.filter((c) => c.method !== "GET")).toEqual([
      { path: "/boards/board1/logs/row1", method: "PUT", body: { log: { title: "Chicken", emoji: "🍗" } } },
    ]);
    expect(text).toContain("title: Chicken; icon: 🍗");
  });

  it("removes a row's icon on an empty icon", async () => {
    const { api, calls } = fakeApi({ ...baseRoutes, "PUT /boards/board1/logs/row1": () => ({ log: {} }) });
    const text = await callDatabaseTool("update_database_row", { database: "Tasks", row: "row1", icon: "" }, api);
    expect(calls.at(-1)!.body).toEqual({ log: { emoji: null } });
    expect(text).toContain("icon: removed");
  });

  it("leaves the title alone when only cells change", async () => {
    const titled: Row = { ...ROW, title: "🍗 Chicken", title_text: "🍗 Chicken" };
    const { api, calls } = fakeApi({
      ...baseRoutes,
      "GET /l/dbhash/rows": () => ({ columns: COLUMNS, views: VIEWS, rows: [titled], next_cursor: null }),
      "PATCH /l/row1/properties/100": () => ({ properties: [] }),
    });
    await callDatabaseTool("update_database_row", { database: "Tasks", row: "row1", values: { Status: "Todo" } }, api);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("finds a row hidden by the view through the search", async () => {
    const { api, calls } = fakeApi({
      ...baseRoutes,
      "GET /l/dbhash/rows": () => ({ columns: COLUMNS, views: VIEWS, rows: [], next_cursor: null }),
      "GET /logs/search": () => ({ logs: [{ ...ROW, properties: undefined, parent_id: 7 }] }),
      "GET /l/row1": () => ({ log: ROW }),
      "DELETE /l/row1": () => ({}),
    });
    const text = await callDatabaseTool("delete_database_row", { database: "Tasks", row: "Write docs" }, api);
    expect(calls.at(-1)).toEqual({ path: "/l/row1", method: "DELETE", body: undefined });
    expect(text).toBe('Moved row "Write docs" to the trash.');
  });

  it("maps view filters and sorts from column names to ids", async () => {
    const { api, calls } = fakeApi({
      ...baseRoutes,
      "PATCH /l/dbhash/views/11": (body) => ({ views: [{ ...VIEWS[0], ...body }] }),
    });
    const text = await callDatabaseTool(
      "update_database_view",
      {
        database: "Tasks",
        filters: [{ column: "Status", operator: "is", value: "Todo" }, { column: "Done", operator: "is_empty" }],
        sorts: [{ column: "Status", direction: "desc" }],
      },
      api,
    );
    expect(calls.at(-1)!.body).toEqual({
      filters: [
        { column_id: 1, operator: "is", value: "Todo" },
        { column_id: 2, operator: "is_empty", value: "" },
      ],
      sorts: [{ column_id: 1, direction: "desc" }],
    });
    expect(text).toContain('filters: Status is "Todo"; Done is empty; sorts: Status desc');
  });

  it("keeps existing choices' colors when replacing a column's choices", async () => {
    const { api, calls } = fakeApi({
      ...baseRoutes,
      "PATCH /l/dbhash/columns/1": () => ({ columns: COLUMNS }),
    });
    await callDatabaseTool("update_database_column", { database: "Tasks", column: "status", choices: ["todo", "Done"] }, api);
    const choices = calls.at(-1)!.body.options.choices;
    expect(choices[0]).toEqual({ id: "a1", name: "todo", color: "gray" });
    expect(choices[1]).toMatchObject({ name: "Done", color: "brown" });
  });

  it("creates a database with its columns", async () => {
    const { api, calls } = fakeApi({
      "POST /logs": () => ({ log: DB }),
      "POST /l/dbhash/columns": () => ({ columns: COLUMNS.slice(0, 1) }),
    });
    const text = await callDatabaseTool(
      "create_database",
      { title: "Tasks", columns: [{ name: "Status", kind: "list", choices: ["Todo"] }] },
      api,
    );
    // Without daily_note: false the API appends to the daily note instead.
    expect(calls[0].body).toEqual({ log: { title: "Tasks", text: "", is_database: true }, daily_note: false });
    expect(calls[1].body).toMatchObject({ name: "Status", kind: "list", options: { choices: [{ name: "Todo", color: "gray" }] } });
    expect(text).toContain('Created database "Tasks" (database_id: dbhash)');
  });
});

describe("formatting", () => {
  it("formats values by kind", () => {
    expect(formatValue(["a", "b"])).toBe("a, b");
    expect(formatValue(false, "checkbox")).toBe("no");
    expect(formatValue(null)).toBe("");
    expect(formatValue(3.5)).toBe("3.5");
  });

  it("escapes pipes and newlines in table cells", () => {
    const row: Row = { ...ROW, title_text: "a|b\nc", properties: [] };
    expect(renderRowsTable([], [row]).split("\n")[2]).toBe("| row1 | a\\|b c |");
  });

  it("shows an Icon column only once a row has one", () => {
    const plain: Row = { ...ROW, properties: [] };
    expect(renderRowsTable([], [plain]).split("\n")[0]).toBe("| row_id | Name |");
    const withIcon: Row = { ...plain, emoji: "🍗" };
    const lines = renderRowsTable([], [withIcon, plain]).split("\n");
    expect(lines[0]).toBe("| row_id | Icon | Name |");
    expect(lines[2]).toBe("| row1 | 🍗 | Write docs |");
    expect(lines[3]).toBe("| row1 |  | Write docs |");
  });

  it("gives new choices the next colors", () => {
    expect(buildChoices(["x", "y"]).map((c) => c.color)).toEqual(["gray", "brown"]);
  });
});

describe("splitIcon", () => {
  it("takes a leading emoji off the title", () => {
    expect(splitIcon("🍗 Chicken")).toEqual({ title: "Chicken", icon: "🍗" });
    expect(splitIcon("❤️ Loved")).toEqual({ title: "Loved", icon: "❤️" });
    expect(splitIcon("👨‍👩‍👧 Family")).toEqual({ title: "Family", icon: "👨‍👩‍👧" });
    expect(splitIcon("🇪🇸 Spain")).toEqual({ title: "Spain", icon: "🇪🇸" });
  });

  it("keeps an explicitly given icon and still cleans the title", () => {
    expect(splitIcon("🐔 Chicken", "🍗")).toEqual({ title: "Chicken", icon: "🍗" });
  });

  it("leaves titles that are only an emoji, or start with a text symbol", () => {
    expect(splitIcon("🍗")).toEqual({ title: "🍗", icon: undefined });
    expect(splitIcon("™ Brand")).toEqual({ title: "™ Brand", icon: undefined });
    expect(splitIcon("Chicken 🍗")).toEqual({ title: "Chicken 🍗", icon: undefined });
  });
});
