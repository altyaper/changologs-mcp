import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const BASE_URL = (process.env.CHANGOLOGS_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const PORT = parseInt(process.env.PORT ?? "3001", 10);
const REDIRECT_URI = "claude://callback";

let registeredClientId: string | null = null;

// ── Dynamic OAuth Registration (RFC 7591) ───────────────────────────────────

async function registerOAuthClient(): Promise<string> {
  console.log(`Registering MCP with OAuth server at ${BASE_URL}/oauth/register`);
  const res = await fetch(`${BASE_URL}/oauth/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_name: "changologs-mcp",
      redirect_uris: [REDIRECT_URI],
      client_uri: "https://github.com/anthropics/claude-mcp",
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OAuth registration failed ${res.status}: ${body}`);
  }

  const data = await res.json();
  console.log(`OAuth registration successful. Client ID: ${data.client_id}`);
  return data.client_id;
}

// ── Auth ────────────────────────────────────────────────────────────────────

function extractBearerToken(req: IncomingMessage): string | null {
  const header = req.headers["authorization"];
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice(7).trim() || null;
}

function rejectUnauthorized(res: ServerResponse): void {
  res.writeHead(401, {
    "Content-Type": "application/json",
    "WWW-Authenticate": `Bearer realm="changologs", authorization_uri="${BASE_URL}/oauth/authorize"`,
  });
  res.end(
    JSON.stringify({
      error: "unauthorized",
      error_description: "Bearer token required. Authenticate via OAuth.",
    }),
  );
}

// ── changologs API client ───────────────────────────────────────────────────

async function apiRequest(
  token: string,
  path: string,
  options: RequestInit = {},
): Promise<any> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API error ${res.status}: ${body}`);
  }
  return res.json();
}

// ── MCP server factory (one instance per request, token in closure) ─────────

function createMcpServer(token: string): Server {
  const server = new Server(
    { name: "changologs", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "create_log",
        description: "Create a new log entry in changologs on the default board of a workspace.",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string", description: "Content of the log (plain text or HTML)." },
            title: { type: "string", description: "Title. Defaults to today's date if omitted." },
            workspace_id: {
              type: "string",
              description: "Workspace to create the log in. Defaults to the user's default workspace if omitted. Use list_workspaces to find available workspace ids.",
            },
          },
          required: ["text"],
        },
      },
      {
        name: "list_workspaces",
        description: "List the workspaces available to the current user, with the workspace_id to pass to create_log.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "list_recent_logs",
        description: "List the most recently updated logs in changologs.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "search_logs",
        description: "Search logs by text content or title in changologs.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search term." },
          },
          required: ["query"],
        },
      },
      {
        name: "get_log",
        description: "Get the full content of a log by title.",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string", description: "Title of the log to retrieve." },
          },
          required: ["title"],
        },
      },
      {
        name: "delete_log",
        description: "Delete a log by title.",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string", description: "Title of the log to delete." },
          },
          required: ["title"],
        },
      },
      {
        name: "update_log",
        description: "Update an existing log by title. Append or replace content.",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string", description: "Title of the log to update." },
            text: { type: "string", description: "New content." },
            append: { type: "boolean", description: "Append (true) or replace (false). Defaults to true." },
          },
          required: ["title", "text"],
        },
      },
      {
        name: "list_task_lists",
        description: "List the task lists available to the current user, with the task_list_id to pass to create_task.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "create_task",
        description: "Create a new task in a task list in changologs.",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string", description: "Title of the task." },
            task_list_id: {
              type: "number",
              description: "The task list to add it to. Use list_task_lists to find available ids.",
            },
            details: { type: "string", description: "Optional details/notes for the task." },
            date: { type: "string", description: "Optional date (YYYY-MM-DD) for when to do the task." },
            deadline: { type: "string", description: "Optional hard due date (YYYY-MM-DD), independent of date." },
          },
          required: ["title", "task_list_id"],
        },
      },
      {
        name: "get_task",
        description: "Get the details of a task by title.",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string", description: "Title of the task to retrieve." },
          },
          required: ["title"],
        },
      },
      {
        name: "update_task",
        description: "Update an existing task by title: rename it, or change its details, date, or deadline.",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string", description: "Title of the task to update." },
            new_title: { type: "string", description: "New title, if renaming." },
            details: { type: "string", description: "New details/notes." },
            date: { type: "string", description: "New date (YYYY-MM-DD)." },
            deadline: { type: "string", description: "New deadline (YYYY-MM-DD)." },
          },
          required: ["title"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      if (name === "create_log") {
        const title = (args?.title as string) ?? new Date().toISOString().slice(0, 10);
        const workspaceId = args?.workspace_id as string | undefined;
        const path = workspaceId ? `/logs?workspace_id=${encodeURIComponent(workspaceId)}` : "/logs";
        const data = await apiRequest(token, path, {
          method: "POST",
          body: JSON.stringify({ log: { title, text: args?.text as string } }),
        });
        const log = data.log;
        return { content: [{ type: "text", text: `Created log "${log.title}" (ID: ${log.hash_id ?? log.id})` }] };
      }

      if (name === "list_workspaces") {
        const data = await apiRequest(token, "/workspaces");
        const workspaces: Array<{ name: string; hash_id: string }> = data.workspaces ?? [];
        if (!workspaces.length) return { content: [{ type: "text", text: "No workspaces found." }] };
        const lines = workspaces.map((w) => `• ${w.name} (workspace_id: ${w.hash_id})`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      if (name === "list_recent_logs") {
        const data = await apiRequest(token, "/logs/recent");
        const logs: Array<{ title: string; updated_at: string }> = data.logs ?? [];
        if (!logs.length) return { content: [{ type: "text", text: "No logs found." }] };
        const lines = logs.slice(0, 10).map((l) => `• ${l.title} (updated ${new Date(l.updated_at).toLocaleDateString()})`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      if (name === "search_logs") {
        const query = args?.query as string;
        const data = await apiRequest(token, `/logs/search?query=${encodeURIComponent(query)}`);
        const logs: Array<{ title: string; updated_at: string }> = data.logs ?? [];
        if (!logs.length) return { content: [{ type: "text", text: `No logs found for "${query}".` }] };
        const lines = logs.map((l) => `• ${l.title} (updated ${new Date(l.updated_at).toLocaleDateString()})`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      if (name === "get_log") {
        const title = args?.title as string;
        const searchData = await apiRequest(token, `/logs/search?query=${encodeURIComponent(title)}`);
        const logs: Array<{ title: string; hash_id?: string; id?: string; text?: string }> = searchData.logs ?? [];
        if (!logs.length) return { content: [{ type: "text", text: `No log found with title "${title}".` }], isError: true };
        const matched = logs.find((l) => l.title === title) ?? logs[0];
        return { content: [{ type: "text", text: `# ${matched.title}\n\n${matched.text ?? "(empty)"}` }] };
      }

      if (name === "delete_log") {
        const title = args?.title as string;
        const searchData = await apiRequest(token, `/logs/search?query=${encodeURIComponent(title)}`);
        const logs: Array<{ title: string; hash_id?: string; id?: string }> = searchData.logs ?? [];
        if (!logs.length) return { content: [{ type: "text", text: `No log found with title "${title}".` }], isError: true };
        const matched = logs.find((l) => l.title === title) ?? logs[0];
        const res = await fetch(`${BASE_URL}/l/${matched.hash_id ?? matched.id}`, {
          method: "DELETE",
          headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
        return { content: [{ type: "text", text: `Deleted log "${matched.title}".` }] };
      }

      if (name === "update_log") {
        const title = args?.title as string;
        const text = args?.text as string;
        const append = (args?.append as boolean) ?? true;
        const searchData = await apiRequest(token, `/logs/search?query=${encodeURIComponent(title)}`);
        const logs: Array<{ title: string; hash_id?: string; id?: string; board_hash_id?: string; text?: string }> = searchData.logs ?? [];
        if (!logs.length) return { content: [{ type: "text", text: `No log found with title "${title}".` }], isError: true };
        const matched = logs.find((l) => l.title === title) ?? logs[0];
        if (!matched.board_hash_id) throw new Error("Could not determine board for log");
        const finalText = append ? (matched.text ?? "") + text : text;
        const updateData = await apiRequest(token, `/boards/${matched.board_hash_id}/logs/${matched.hash_id ?? matched.id}`, {
          method: "PUT",
          body: JSON.stringify({ log: { text: finalText } }),
        });
        const updated = updateData.log;
        return { content: [{ type: "text", text: `Updated log "${updated.title}" (ID: ${updated.hash_id ?? updated.id})` }] };
      }

      if (name === "list_task_lists") {
        const data = await apiRequest(token, "/api/task-lists");
        const taskLists: Array<{ id: number; name: string }> = data.task_lists ?? [];
        if (!taskLists.length) return { content: [{ type: "text", text: "No task lists found." }] };
        const lines = taskLists.map((l) => `• ${l.name} (task_list_id: ${l.id})`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      if (name === "create_task") {
        const taskListId = args?.task_list_id as number;
        const task = await apiRequest(token, `/api/task-lists/${taskListId}/tasks`, {
          method: "POST",
          body: JSON.stringify({
            task: {
              title: args?.title as string,
              details: args?.details as string | undefined,
              date: args?.date as string | undefined,
              deadline: args?.deadline as string | undefined,
            },
          }),
        });
        return { content: [{ type: "text", text: `Created task "${task.title}" (ID: ${task.id}) in list ${taskListId}` }] };
      }

      // get_task/update_task locate the task via the shared /logs/search
      // endpoint (it returns a `tasks` array alongside logs/boards/secrets)
      // rather than a dedicated tasks search route -- tasks live nested under
      // a task list, so there's no flat "all my tasks" endpoint to hit by title.
      if (name === "get_task") {
        const title = args?.title as string;
        const searchData = await apiRequest(token, `/logs/search?query=${encodeURIComponent(title)}`);
        const tasks: Array<{
          title: string; id: number; task_list_id: number; details?: string | null;
          date?: string | null; deadline?: string | null; completed_at?: string | null; repeat_unit?: string | null;
        }> = searchData.tasks ?? [];
        if (!tasks.length) return { content: [{ type: "text", text: `No task found with title "${title}".` }], isError: true };
        const matched = tasks.find((t) => t.title === title) ?? tasks[0];
        const lines = [
          `# ${matched.title}`,
          matched.details ? matched.details : null,
          `Date: ${matched.date ?? "none"}`,
          `Deadline: ${matched.deadline ?? "none"}`,
          `Completed: ${matched.completed_at ? "yes" : "no"}`,
          matched.repeat_unit ? `Repeats: every ${matched.repeat_unit}` : null,
        ].filter((line): line is string => line !== null);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      if (name === "update_task") {
        const title = args?.title as string;
        const searchData = await apiRequest(token, `/logs/search?query=${encodeURIComponent(title)}`);
        const tasks: Array<{ title: string; id: number; task_list_id: number }> = searchData.tasks ?? [];
        if (!tasks.length) return { content: [{ type: "text", text: `No task found with title "${title}".` }], isError: true };
        const matched = tasks.find((t) => t.title === title) ?? tasks[0];

        const updates: Record<string, unknown> = {};
        if (args?.new_title !== undefined) updates.title = args.new_title;
        if (args?.details !== undefined) updates.details = args.details;
        if (args?.date !== undefined) updates.date = args.date;
        if (args?.deadline !== undefined) updates.deadline = args.deadline;

        const updated = await apiRequest(token, `/api/task-lists/${matched.task_list_id}/tasks/${matched.id}`, {
          method: "PATCH",
          body: JSON.stringify({ task: updates }),
        });
        return { content: [{ type: "text", text: `Updated task "${updated.title}" (ID: ${updated.id})` }] };
      }

      throw new Error(`Unknown tool: ${name}`);
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  });

  return server;
}

// ── HTTP server ─────────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  // OAuth metadata discovery — MCP clients use this to find the auth server
  if (url.pathname === "/.well-known/oauth-authorization-server") {
    if (!registeredClientId) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "MCP server registration in progress" }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      issuer: BASE_URL,
      authorization_endpoint: `${BASE_URL}/oauth/authorize`,
      token_endpoint: `${BASE_URL}/oauth/token`,
      revocation_endpoint: `${BASE_URL}/oauth/revoke`,
      registration_endpoint: `${BASE_URL}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      scopes_supported: ["api"],
      code_challenge_methods_supported: ["S256"],
      // MCP-specific: include the pre-registered client_id
      client_id: registeredClientId,
      client_type: "public",
      redirect_uri: REDIRECT_URI,
    }));
    return;
  }

  if (url.pathname === "/mcp") {
    const token = extractBearerToken(req);
    if (!token) {
      rejectUnauthorized(res);
      return;
    }

    try {
      const body = await readBody(req);
      const parsedBody = body ? JSON.parse(body) : undefined;

      const server = createMcpServer(token);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless — no session tracking needed
      });

      await server.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
    } catch (err) {
      console.error("MCP request error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "internal_error" }));
      }
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

// Start server and register with OAuth
(async () => {
  try {
    registeredClientId = await registerOAuthClient();
  } catch (err) {
    console.error("Failed to register with OAuth server:", err);
    console.error("Continuing anyway — client can still register dynamically.");
  }

  httpServer.listen(PORT, () => {
    console.log(`changologs MCP server listening on http://localhost:${PORT}/mcp`);
    console.log(`OAuth discovery: ${BASE_URL}/.well-known/oauth-authorization-server`);
    if (registeredClientId) {
      console.log(`Registered client ID: ${registeredClientId}`);
    }
  });
})();

process.on("uncaughtException", (err) => { console.error("Uncaught exception:", err); process.exit(1); });
process.on("unhandledRejection", (reason) => { console.error("Unhandled rejection:", reason); process.exit(1); });
