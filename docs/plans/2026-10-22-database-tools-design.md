# Database tools — design

## Problem

changologs now has Notion-style databases: a log with `is_database` whose children are
rows, with a typed schema in `log_columns` and saved views in `log_views` (see
`docs/plans/2026-10-20-databases-design.md` in the changologs repo, whose "Later
phases" lists "AI assistant / MCP tools that read and write rows"). The MCP server has
no way to read or write any of that.

## Approach

12 tools in a new `databases.ts`, built like `blocks.ts`: it exports `DATABASE_TOOLS`
and a `callDatabaseTool(name, args, api)` dispatcher that returns `null` for names it
doesn't own. Unlike the block tools these call the API, so the dispatcher takes an
`ApiClient` function. `server.ts` and `worker.ts` each pass their own `apiRequest`,
which keeps the two entry points from growing another 300 duplicated lines each.

No Rails changes. Every tool uses an endpoint the web client already calls:

| Tool | Endpoint(s) |
| --- | --- |
| `list_databases` | `GET /logs/databases?workspace_id=` |
| `get_database` | `GET /l/:id/rows?limit=1` (answers with columns and views) |
| `query_database_rows` | `GET /l/:id/rows?view_id=&cursor=&limit=` |
| `create_database` | `POST /logs` `{is_database: true}`, then `POST /l/:id/columns` per column |
| `convert_log_to_database` | `GET /logs/search`, `POST /l/:id/database` |
| `add/update/delete_database_column` | `POST`/`PATCH`/`DELETE /l/:id/columns[/:column_id]` |
| `add_database_row` | `POST /logs` `{parent_id, emoji}`, then `POST /l/:row/properties` per value |
| `update_database_row` | `PUT /boards/:board/logs/:row` (title, emoji), `PATCH`/`POST /l/:row/properties` |
| `delete_database_row` | `DELETE /l/:row` (trash) |
| `update_database_view` | `PATCH /l/:id/views/:view_id` |

## Decisions

- **Databases are found through `/logs/databases`, not the search.** `POST /logs`
  files a new log on the *current workspace's* default board, so a row must be created
  with the database's workspace. Finding the database in the workspace's list means
  the `workspace_id` used for the lookup is the right one for the row as well.
- **Column names, not ids, in tool params.** Values, filters and sorts are keyed by
  column name (case-insensitive) and mapped to ids in the MCP server.
- **Unknown column names are rejected.** `POST /l/:row/properties` on a row adds a
  column when the name matches none, so a typo would quietly grow the schema. The tool
  fails with the list of columns instead, before creating anything. New columns go
  through `add_database_column`.
- **Rows are found by title or `row_id` (hash id).** Lookup pages through the first
  view (at most 10 pages). A row its filters hide is found through `/logs/search`,
  filtered by `parent_id`, then loaded with `GET /l/:row` for its properties.
- **Filtering is by saved view only.** `GET /rows` has no ad-hoc filter parameters, so
  `update_database_view` changes the saved view, and its description says that
  everyone sees the change.
- **Select choices are generated client-side** (`{id, name, color}`, colors cycling as
  `LogColumn#add_choices!` does), because the columns endpoint stores `options` as sent.
  Replacing a column's choices keeps the id and color of names already present.
- **A row's emoji is its icon, and never its title.** Asked for an icon on a row, a
  model that has no `icon` parameter writes "🍗 Chicken" as the title instead, and the
  row then reads "🍗 🍗 Chicken" once the icon is set too. So `add_database_row` and
  `update_database_row` take `icon` (the log's `emoji`), and `splitIcon` takes a leading
  emoji off the title either way -- setting `icon` on an existing row is also how a row
  already written that way gets cleaned up. A title that is nothing but an emoji is left
  alone, as stripping it would leave the row nameless, and `query_database_rows` shows the
  icon in its own column rather than in Name, so a title read back out carries no emoji.
- **Left out:** turning a database back into a page (`DELETE /l/:id/database`),
  reordering columns, renaming views. Easy to add if wanted.

## Testing

`databases.test.ts` runs the dispatcher against a fake `ApiClient` that records each
request: request paths and bodies, column-name mapping, rejecting unknown columns before
any write, PATCH vs POST for cells, the search fallback for hidden rows, and the table
output.
