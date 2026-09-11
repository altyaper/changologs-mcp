import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

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
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
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
