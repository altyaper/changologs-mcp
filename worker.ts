import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { BLOCK_TOOLS, renderBlockTool } from "./blocks.js";

interface Env {
  CHANGOLOGS_BASE_URL: string;
  CHANGOLOGS_CLIENT_ID?: string; // Optional: pre-registered OAuth client ID
}

// ── changologs API client ───────────────────────────────────────────────────

async function apiRequest(
  token: string,
  baseUrl: string,
  path: string,
  options: RequestInit = {},
): Promise<any> {
  const res = await fetch(`${baseUrl}${path}`, {
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

// ── MCP server factory (one per request, token + baseUrl in closure) ────────

function createMcpServer(token: string, baseUrl: string): Server {
  const server = new Server(
    { name: "changologs", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "create_log",
        description: "Create a new log entry in changologs on the default board of a workspace. For anything beyond a single plain paragraph, call the relevant add_* block tools first (add_heading, add_table, add_callout, etc.), concatenate their returned HTML fragments in document order, and pass the assembled string as text.",
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
      ...BLOCK_TOOLS,
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
        description: "Update an existing log by title. Append or replace content. For anything beyond a single plain paragraph, call the relevant add_* block tools first, concatenate their returned HTML fragments in document order, and pass the assembled string as text.",
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
        name: "set_log_icon",
        description: "Set the icon of a log by title. The icon is an emoji shown next to the log's title. Pass an empty string to remove it.",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string", description: "Title of the log." },
            emoji: { type: "string", description: "A single emoji, e.g. \"🚀\". Empty string removes the icon." },
          },
          required: ["title", "emoji"],
        },
      },
      {
        name: "list_task_lists",
        description: "List the task lists available to the current user, with the task_list_id to pass to create_task.",
        inputSchema: {
          type: "object",
          properties: {
            workspace_id: {
              type: "string",
              description: "Workspace whose lists to show. Defaults to the user's default workspace if omitted. Use list_workspaces to find available workspace ids.",
            },
          },
        },
      },
      {
        name: "create_task_list",
        description: "Create a new task list in changologs. Returns the task_list_id to pass to create_task.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Name of the list." },
            workspace_id: {
              type: "string",
              description: "Workspace to create the list in. Defaults to the user's default workspace if omitted. Use list_workspaces to find available workspace ids.",
            },
          },
          required: ["name"],
        },
      },
      {
        name: "list_tasks",
        description: "List the tasks in a task list, in their display order. Completed tasks are omitted unless include_completed is true.",
        inputSchema: {
          type: "object",
          properties: {
            task_list_id: {
              type: "number",
              description: "The task list to read. Use list_task_lists to find available ids.",
            },
            include_completed: { type: "boolean", description: "Also list completed tasks. Defaults to false." },
          },
          required: ["task_list_id"],
        },
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
      {
        name: "complete_task",
        description: "Check off a task by title, or uncheck it. Checking a repeating task moves it to its next occurrence instead of marking it done.",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string", description: "Title of the task to check off." },
            completed: { type: "boolean", description: "Check (true) or uncheck (false). Defaults to true." },
          },
          required: ["title"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      const blockFragment = renderBlockTool(name, args as Record<string, unknown> | undefined);
      if (blockFragment !== null) {
        return { content: [{ type: "text", text: blockFragment }] };
      }

      if (name === "create_log") {
        const title = (args?.title as string) ?? new Date().toISOString().slice(0, 10);
        const workspaceId = args?.workspace_id as string | undefined;
        const path = workspaceId ? `/logs?workspace_id=${encodeURIComponent(workspaceId)}` : "/logs";
        const data = await apiRequest(token, baseUrl, path, {
          method: "POST",
          body: JSON.stringify({ log: { title, text: args?.text as string } }),
        });
        const log = data.log;
        return { content: [{ type: "text", text: `Created log "${log.title}" (ID: ${log.hash_id ?? log.id})` }] };
      }

      if (name === "list_workspaces") {
        const data = await apiRequest(token, baseUrl, "/workspaces");
        const workspaces: Array<{ name: string; hash_id: string }> = data.workspaces ?? [];
        if (!workspaces.length) return { content: [{ type: "text", text: "No workspaces found." }] };
        const lines = workspaces.map((w) => `• ${w.name} (workspace_id: ${w.hash_id})`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      if (name === "list_recent_logs") {
        const data = await apiRequest(token, baseUrl, "/logs/recent");
        const logs: Array<{ title: string; updated_at: string }> = data.logs ?? [];
        if (!logs.length) return { content: [{ type: "text", text: "No logs found." }] };
        const lines = logs.slice(0, 10).map((l) => `• ${l.title} (updated ${new Date(l.updated_at).toLocaleDateString()})`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      if (name === "search_logs") {
        const query = args?.query as string;
        const data = await apiRequest(token, baseUrl, `/logs/search?query=${encodeURIComponent(query)}`);
        const logs: Array<{ title: string; updated_at: string }> = data.logs ?? [];
        if (!logs.length) return { content: [{ type: "text", text: `No logs found for "${query}".` }] };
        const lines = logs.map((l) => `• ${l.title} (updated ${new Date(l.updated_at).toLocaleDateString()})`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      if (name === "get_log") {
        const title = args?.title as string;
        const searchData = await apiRequest(token, baseUrl, `/logs/search?query=${encodeURIComponent(title)}`);
        const logs: Array<{ title: string; hash_id?: string; id?: string; text?: string }> = searchData.logs ?? [];
        if (!logs.length) return { content: [{ type: "text", text: `No log found with title "${title}".` }], isError: true };
        const matched = logs.find((l) => l.title === title) ?? logs[0];
        return { content: [{ type: "text", text: `# ${matched.title}\n\n${matched.text ?? "(empty)"}` }] };
      }

      if (name === "delete_log") {
        const title = args?.title as string;
        const searchData = await apiRequest(token, baseUrl, `/logs/search?query=${encodeURIComponent(title)}`);
        const logs: Array<{ title: string; hash_id?: string; id?: string }> = searchData.logs ?? [];
        if (!logs.length) return { content: [{ type: "text", text: `No log found with title "${title}".` }], isError: true };
        const matched = logs.find((l) => l.title === title) ?? logs[0];
        const res = await fetch(`${baseUrl}/l/${matched.hash_id ?? matched.id}`, {
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
        const searchData = await apiRequest(token, baseUrl, `/logs/search?query=${encodeURIComponent(title)}`);
        const logs: Array<{ title: string; hash_id?: string; id?: string; board_hash_id?: string; text?: string }> = searchData.logs ?? [];
        if (!logs.length) return { content: [{ type: "text", text: `No log found with title "${title}".` }], isError: true };
        const matched = logs.find((l) => l.title === title) ?? logs[0];
        if (!matched.board_hash_id) throw new Error("Could not determine board for log");
        const finalText = append ? (matched.text ?? "") + text : text;
        const updateData = await apiRequest(token, baseUrl, `/boards/${matched.board_hash_id}/logs/${matched.hash_id ?? matched.id}`, {
          method: "PUT",
          body: JSON.stringify({ log: { text: finalText } }),
        });
        const updated = updateData.log;
        return { content: [{ type: "text", text: `Updated log "${updated.title}" (ID: ${updated.hash_id ?? updated.id})` }] };
      }

      if (name === "set_log_icon") {
        const title = args?.title as string;
        const emoji = (args?.emoji as string).trim();
        const searchData = await apiRequest(token, baseUrl, `/logs/search?query=${encodeURIComponent(title)}`);
        const logs: Array<{ title: string; hash_id?: string; id?: string; board_hash_id?: string }> = searchData.logs ?? [];
        if (!logs.length) return { content: [{ type: "text", text: `No log found with title "${title}".` }], isError: true };
        const matched = logs.find((l) => l.title === title) ?? logs[0];
        if (!matched.board_hash_id) throw new Error("Could not determine board for log");
        const updateData = await apiRequest(token, baseUrl, `/boards/${matched.board_hash_id}/logs/${matched.hash_id ?? matched.id}`, {
          method: "PUT",
          body: JSON.stringify({ log: { emoji: emoji || null } }),
        });
        const updated = updateData.log;
        if (!emoji) return { content: [{ type: "text", text: `Removed the icon from "${updated.title}".` }] };
        return { content: [{ type: "text", text: `Set the icon of "${updated.title}" to ${emoji}.` }] };
      }

      if (name === "list_task_lists") {
        const workspaceId = args?.workspace_id as string | undefined;
        const path = workspaceId ? `/api/task-lists?workspace_id=${encodeURIComponent(workspaceId)}` : "/api/task-lists";
        const data = await apiRequest(token, baseUrl, path);
        const taskLists: Array<{ id: number; name: string }> = data.task_lists ?? [];
        if (!taskLists.length) return { content: [{ type: "text", text: "No task lists found." }] };
        const lines = taskLists.map((l) => `• ${l.name} (task_list_id: ${l.id})`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      if (name === "create_task_list") {
        const workspaceId = args?.workspace_id as string | undefined;
        const path = workspaceId ? `/api/task-lists?workspace_id=${encodeURIComponent(workspaceId)}` : "/api/task-lists";
        const taskList = await apiRequest(token, baseUrl, path, {
          method: "POST",
          body: JSON.stringify({ task_list: { name: args?.name as string } }),
        });
        return { content: [{ type: "text", text: `Created task list "${taskList.name}" (task_list_id: ${taskList.id})` }] };
      }

      if (name === "list_tasks") {
        const taskListId = args?.task_list_id as number;
        const includeCompleted = (args?.include_completed as boolean) ?? false;
        const data = await apiRequest(token, baseUrl, `/api/task-lists/${taskListId}/tasks`);
        const allTasks: Array<{
          title: string; id: number; date?: string | null; deadline?: string | null; completed_at?: string | null;
        }> = data.tasks ?? [];
        const tasks = includeCompleted ? allTasks : allTasks.filter((t) => !t.completed_at);
        if (!tasks.length) return { content: [{ type: "text", text: `No tasks found in list ${taskListId}.` }] };
        const lines = tasks.map((t) => {
          const extras = [
            t.date ? `date ${t.date}` : null,
            t.deadline ? `deadline ${t.deadline}` : null,
            t.completed_at ? "completed" : null,
          ].filter(Boolean);
          return `• ${t.title} (ID: ${t.id}${extras.length ? `, ${extras.join(", ")}` : ""})`;
        });
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      if (name === "create_task") {
        const taskListId = args?.task_list_id as number;
        const task = await apiRequest(token, baseUrl, `/api/task-lists/${taskListId}/tasks`, {
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
        const searchData = await apiRequest(token, baseUrl, `/logs/search?query=${encodeURIComponent(title)}`);
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
        const searchData = await apiRequest(token, baseUrl, `/logs/search?query=${encodeURIComponent(title)}`);
        const tasks: Array<{ title: string; id: number; task_list_id: number }> = searchData.tasks ?? [];
        if (!tasks.length) return { content: [{ type: "text", text: `No task found with title "${title}".` }], isError: true };
        const matched = tasks.find((t) => t.title === title) ?? tasks[0];

        const updates: Record<string, unknown> = {};
        if (args?.new_title !== undefined) updates.title = args.new_title;
        if (args?.details !== undefined) updates.details = args.details;
        if (args?.date !== undefined) updates.date = args.date;
        if (args?.deadline !== undefined) updates.deadline = args.deadline;

        const updated = await apiRequest(token, baseUrl, `/api/task-lists/${matched.task_list_id}/tasks/${matched.id}`, {
          method: "PATCH",
          body: JSON.stringify({ task: updates }),
        });
        return { content: [{ type: "text", text: `Updated task "${updated.title}" (ID: ${updated.id})` }] };
      }

      if (name === "complete_task") {
        const title = args?.title as string;
        const completed = (args?.completed as boolean) ?? true;
        const searchData = await apiRequest(token, baseUrl, `/logs/search?query=${encodeURIComponent(title)}`);
        const tasks: Array<{ title: string; id: number; task_list_id: number }> = searchData.tasks ?? [];
        if (!tasks.length) return { content: [{ type: "text", text: `No task found with title "${title}".` }], isError: true };
        const matched = tasks.find((t) => t.title === title) ?? tasks[0];

        const action = completed ? "complete" : "uncomplete";
        const updated = await apiRequest(token, baseUrl, `/api/task-lists/${matched.task_list_id}/tasks/${matched.id}/${action}`, {
          method: "POST",
        });
        if (!completed) return { content: [{ type: "text", text: `Unchecked task "${updated.title}".` }] };
        // A repeating task mid-series isn't marked done -- its date rolls forward.
        if (!updated.completed_at) {
          return { content: [{ type: "text", text: `Checked off "${updated.title}". Next occurrence: ${updated.date ?? "none"}.` }] };
        }
        return { content: [{ type: "text", text: `Checked off "${updated.title}".` }] };
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

// ── Cloudflare Workers fetch handler ───────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const baseUrl = env.CHANGOLOGS_BASE_URL;

    // OAuth metadata — MCP clients discover the auth server from here
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return Response.json({
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}/oauth/authorize`,
        token_endpoint: `${baseUrl}/oauth/token`,
        revocation_endpoint: `${baseUrl}/oauth/revoke`,
        registration_endpoint: `${baseUrl}/oauth/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        scopes_supported: ["api"],
        code_challenge_methods_supported: ["S256"],
      });
    }

    if (url.pathname === "/mcp") {
      const authHeader = request.headers.get("Authorization");
      const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;

      if (!token) {
        return new Response(
          JSON.stringify({ error: "unauthorized", error_description: "Bearer token required" }),
          {
            status: 401,
            headers: {
              "Content-Type": "application/json",
              "WWW-Authenticate": `Bearer realm="changologs", authorization_uri="${baseUrl}/oauth/authorize"`,
            },
          },
        );
      }

      const server = createMcpServer(token, baseUrl);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
        enableJsonResponse: true,
      });

      await server.connect(transport);
      return transport.handleRequest(request);
    }

    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  },
};
