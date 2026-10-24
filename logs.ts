// create_log: a new standalone log, or an entry appended to today's daily note.
//
// The changologs API (`POST /logs`, LogsController#create_standalone) appends
// anything created by API to the workspace's daily note unless the request
// carries `daily_note: false`; in that mode it ignores the title. So the tool
// has to decide which one the user meant and say so -- otherwise every "create
// a log called X" silently lands in today's note.

import type { ApiClient } from "./databases.js";

export const CREATE_LOG_TOOL = {
  name: "create_log",
  description:
    "Create a log in changologs, either as a new standalone log or as an entry appended to today's daily note. " +
    "Set new_log to true when the user asks for a new log, page, note or document, names one, or the content is a " +
    "self-contained document (a spec, a summary, meeting notes) -- and give it a title. Leave new_log false for quick " +
    "notes, journal entries and \"log that ...\" requests, which belong in today's daily note. " +
    "For anything beyond a single plain paragraph, call the relevant add_* block tools first (add_heading, add_table, " +
    "add_callout, etc.), concatenate their returned HTML fragments in document order, and pass the assembled string as text.",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "Content of the log (plain text or HTML)." },
      new_log: {
        type: "boolean",
        description:
          "true creates a new standalone log; false appends to today's daily note. Defaults to true when a title is given, false otherwise.",
      },
      title: {
        type: "string",
        description: "Title of a new log. Ignored when appending to the daily note. Defaults to today's date if omitted.",
      },
      workspace_id: {
        type: "string",
        description: "Workspace to create the log in. Defaults to the user's default workspace if omitted. Use list_workspaces to find available workspace ids.",
      },
    },
    required: ["text"],
  },
};

/** Whether the call asks for a new standalone log rather than a daily note entry. */
export function wantsNewLog(args: Record<string, unknown> | undefined): boolean {
  if (typeof args?.new_log === "boolean") return args.new_log;
  return typeof args?.title === "string" && args.title.trim() !== "";
}

export async function createLog(args: Record<string, unknown> | undefined, api: ApiClient): Promise<string> {
  const newLog = wantsNewLog(args);
  const workspaceId = args?.workspace_id as string | undefined;
  const path = workspaceId ? `/logs?workspace_id=${encodeURIComponent(workspaceId)}` : "/logs";
  const log: Record<string, unknown> = { text: args?.text as string };
  if (newLog) log.title = (args?.title as string | undefined)?.trim() || new Date().toISOString().slice(0, 10);

  const data = await api(path, { method: "POST", body: JSON.stringify({ log, daily_note: !newLog }) });
  const id = data.log.hash_id ?? data.log.id;
  return data.daily_note
    ? `Added to today's daily note "${data.log.title}" (ID: ${id})`
    : `Created log "${data.log.title}" (ID: ${id})`;
}
