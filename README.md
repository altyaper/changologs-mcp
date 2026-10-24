# changologs-mcp

An [MCP](https://modelcontextprotocol.io) server for [Changologs](https://changologs.com). It lets Claude and other MCP clients create, search and edit your logs, and manage your tasks.

It's a hosted, remote server. You don't install anything: connect your client to the URL below and sign in with your Changologs account.

```
https://mcp.changologs.com/mcp
```

Listed in the [MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.altyaper/changologs-mcp`.

## Connect

### Claude Code

```sh
claude mcp add --transport http changologs https://mcp.changologs.com/mcp
```

Then run `/mcp` inside Claude Code and choose **changologs** to sign in.

### Claude Desktop / claude.ai

Open **Settings → Connectors → Add custom connector**, and enter `https://mcp.changologs.com/mcp` as the URL.

### Other clients

Any client that supports streamable HTTP transport and OAuth can connect to the same URL.

## Authentication

The server uses OAuth 2.0 with PKCE, and Changologs is the authorization server. The client finds the auth server's endpoints at `/.well-known/oauth-authorization-server` and registers itself automatically (RFC 7591 dynamic client registration). It then opens a Changologs sign-in page in your browser. After you approve, every request carries your access token, so the server can see only your own workspaces, logs and tasks.

The server doesn't store anything. Each request goes straight to the Changologs API with your token.

## Tools

### Logs

| Tool | What it does |
| --- | --- |
| `create_log` | Create a new log (`new_log: true`, or whenever a `title` is given), or append to today's daily note (the default for untitled quick notes). |
| `list_workspaces` | List your workspaces and their ids, for `create_log`. |
| `list_recent_logs` | List the most recently updated logs. |
| `search_logs` | Search logs by title or content. |
| `get_log` | Get a log's full content, by title. |
| `update_log` | Append to or replace a log's content, by title. |
| `set_log_icon` | Set or remove the emoji shown next to a log's title. |
| `delete_log` | Delete a log, by title. |

### Rich content blocks

These render an HTML fragment matching the changologs editor's formatting exactly —
they don't call the API. Concatenate the fragments in order and pass the result as
`text` to `create_log`/`update_log` to produce a richly formatted log.

| Tool | What it does |
| --- | --- |
| `add_paragraph` | A paragraph. Supports `**bold**`, `_italic_`, `` `code` ``, `[text](url)`. |
| `add_heading` | A heading, level 1-3. |
| `add_bullet_list` / `add_numbered_list` | A bullet or numbered list. |
| `add_task_list` | A checkbox list (inline content, not a `create_task_list` task list). |
| `add_blockquote` | A blockquote. |
| `add_code_block` | A fenced code block, optionally with a language label. |
| `add_divider` | A horizontal rule. |
| `add_toggle` | A collapsible section with a summary and hidden content. |
| `add_callout` | A highlighted callout box with an icon. |
| `add_table` | A table. No header-row styling exists in this editor, so `header_row: true` bolds the first row's text instead. |
| `add_image` | An image, from an already-hosted URL (no file upload). |

### Tasks

| Tool | What it does |
| --- | --- |
| `list_task_lists` | List your task lists and their ids, for `create_task`. |
| `create_task_list` | Create a task list, optionally in a given workspace. |
| `list_tasks` | List the tasks in a list, in display order. Completed tasks are optional. |
| `create_task` | Create a task, with optional details, date and deadline. |
| `get_task` | Get a task's details, by title. |
| `update_task` | Rename a task, or change its details, date or deadline. |
| `complete_task` | Check off a task, or uncheck it. Checking a repeating task moves it to its next occurrence. |

### Databases

A database is a log whose sub-logs are rows in a table: each row's title is its Name,
and the other columns are typed (text, number, date, select, multi-select, checkbox,
url, email, phone, person). Databases are looked up by title within a workspace;
rows by title or by the `row_id` that `query_database_rows` shows.

| Tool | What it does |
| --- | --- |
| `list_databases` | List the databases in a workspace. |
| `get_database` | Show a database's columns (with select choices) and views (with filters and sorts). |
| `query_database_rows` | List rows as a table, filtered and sorted by a view, 100 per page. |
| `create_database` | Create a database, optionally with its columns. |
| `convert_log_to_database` | Turn a log into a database. Its sub-logs become rows, with columns built from their properties. |
| `add_database_column` / `update_database_column` / `delete_database_column` | Add, rename, retype, re-choice or delete a column. |
| `add_database_row` | Add a row with a title and cell values keyed by column name. |
| `update_database_row` | Change a row's title or some of its cells. |
| `delete_database_row` | Move a row to the trash. |
| `update_database_view` | Replace a view's filters and sorts. This changes the saved view in changologs for everyone. |

## Example prompts

- "Log what we did in this session to Changologs."
- "Write a new log with all this data in a table, add callouts where it makes sense, and use h1/h2/h3 headings and paragraphs."
- "Search my logs for the Postgres migration notes."
- "Add a task to finish the release notes by Friday."
- "What's left on my Work task list?"
- "Add a row to my Reading list database for Dune, status Reading."
- "Show me every row in the Bugs database that isn't Done."

## Development

The hosted server is a Cloudflare Worker (`worker.ts`). `server.ts` is a standalone Node version of the same server, for local development.

```sh
npm install

# Worker, locally
npm run dev:worker

# Node server on http://localhost:3001/mcp, pointing at a local Changologs app
CHANGOLOGS_BASE_URL=http://localhost:3000 npm start

# Type-check
npm run build

# Run tests
npm test
```

The Worker reads `CHANGOLOGS_BASE_URL` from `wrangler.json` (set to `https://changologs.com`). `npm run deploy` deploys it with Wrangler.

To update the registry listing, bump `version` in `server.json` and run `mcp-publisher publish`.
