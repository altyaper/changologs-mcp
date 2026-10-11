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
| `create_log` | Create a log on a workspace's default board. The title defaults to today's date. |
| `list_workspaces` | List your workspaces and their ids, for `create_log`. |
| `list_recent_logs` | List the most recently updated logs. |
| `search_logs` | Search logs by title or content. |
| `get_log` | Get a log's full content, by title. |
| `update_log` | Append to or replace a log's content, by title. |
| `set_log_icon` | Set or remove the emoji shown next to a log's title. |
| `delete_log` | Delete a log, by title. |

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

## Example prompts

- "Log what we did in this session to Changologs."
- "Search my logs for the Postgres migration notes."
- "Add a task to finish the release notes by Friday."
- "What's left on my Work task list?"

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
```

The Worker reads `CHANGOLOGS_BASE_URL` from `wrangler.json` (set to `https://changologs.com`). `npm run deploy` deploys it with Wrangler.

To update the registry listing, bump `version` in `server.json` and run `mcp-publisher publish`.
