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

## Files & media columns, and covers

Added after the `files` property kind shipped in changologs — see
`docs/plans/2026-10-26-files-media-property-design.md` there.

- **A file arrives as a URL, never as bytes.** This server runs as a worker, nowhere
  near the user's disk, and anything inlined in a tool call passes through the model's
  context first — roughly 350k tokens per megabyte of base64. So a files value is
  `[{url, name?, link?}]`, and `POST /l/:row/files` takes a `url` it downloads
  server-side. The URL has to be https and reachable from the internet; a path on the
  caller's own machine cannot be attached at all.
- **The upload comes before the cell.** `LogProperty#files_are_attached` only lets a
  cell name a blob already attached to that row, so `resolveFiles` posts every entry to
  the row's files endpoint and builds the cell from what comes back. A refused upload
  therefore leaves no cell behind.
- **Entries are added, not replaced.** Every other kind's value replaces the cell, but
  a files cell is a drawer and "add this file" is what gets asked for — replacing would
  silently drop what was already in it. `null` empties the cell, and that is the only
  removal offered here; taking one file out of several is the UI's job.
- **`link: true` skips the download** and stores a plain link entry. Without it a
  Google Doc URL downloads its login page and calls that the attachment.
- **A files cell renders by name.** `formatValue` would otherwise hand `String()` an
  array of entry objects and print `[object Object]` into the rows table.
- **`cover` sets the banner on a row's page**, as `icon` sets its emoji. A built-in
  cover (`/covers/cover_N.avif`) is a path of changologs' own and is stored as it is; an
  https URL goes to `log[cover_url]`, which the server downloads and re-hosts so the
  cover cannot rot. It rides along in the same write as the title and icon, so a cover
  the server can't fetch fails the call rather than half-applying it.
- **API refusals are unwrapped.** `apiRequest` turns a 422 into
  `API error 422: {"error":"..."}`; `apiErrorMessage` digs the sentence back out, so a
  tool answers "That file is larger than 15 MB" rather than a status line and some JSON.
- **A failed `add_database_row` takes its row back out.** The cover and the cells can
  only be written once the row exists, so either can fail with the row already created.
  Found while testing the shipped feature: a host that refused the download (an image
  CDN answering 400) reported "Couldn't attach …" and left a titled, empty row behind —
  and since retrying is the obvious next move after a refused download, the retry made a
  second row. `rollBackRowOnFailure` wraps everything after the create and trashes the
  row if any of it throws, so a failed add leaves nothing. The rollback is best-effort:
  if the DELETE fails too, the original failure is the one worth reporting, so that is
  what propagates. `update_database_row` needs none of this — its row was already there.

## Testing

`databases.test.ts` runs the dispatcher against a fake `ApiClient` that records each
request: request paths and bodies, column-name mapping, rejecting unknown columns before
any write, PATCH vs POST for cells, the search fallback for hidden rows, and the table
output. For files and covers it also covers upload-then-cell ordering, adding to an
existing cell, `null` emptying one without uploading, `link: true`, both built-in and
downloaded covers, and the message a refused upload or cell write comes back with.
Rollback has three: a refused upload and a refused cover each trash the new row, and a
rollback that itself fails still reports the original failure.

## Uploading a file from the user's own machine

`prepare_file_upload` — added after the URL-only path turned out not to cover the
commonest ask. See `docs/plans/2026-10-29-local-file-upload-tickets-design.md` in
changologs for the ticket itself.

- **The bytes, the server and the credential are in three different places.** The file
  is on the user's machine; this server is a Worker that never sees it; the OAuth token
  is here, not in the shell that can reach the file. So changologs mints a one-shot
  ticket and the shell spends it: `prepare_file_upload` returns a `curl` that uploads
  the file and writes the cell in one step. Nothing but the command crosses the
  conversation.
- **The column is resolved before the ticket is minted.** A typo then costs nothing,
  and the server is asked for the column's real name rather than the casing the call
  used. A column that isn't a files column is refused here too.
- **The path is single-quoted**, because a file on a desktop so often has a space in
  its name; a literal quote in the name is escaped.
- **The descriptions say a local file *is* uploadable.** The bug being fixed was an AI
  reading "a local path can't be read from here" on the files value and telling the
  user changologs could not do it. Both that text and the new tool's description now
  point at `prepare_file_upload` explicitly.
