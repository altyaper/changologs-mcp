# Rich log block tools — design

## Problem

`create_log`/`update_log` take a single `text` field (plain text or HTML). Today, when
asked for a "rich" log (tables, callouts, headings, etc.), the model just writes plain
paragraphs — there's no tool-level nudge toward structure, and no guarantee that
hand-written HTML matches the exact markup the changologs editor (Tiptap) expects for
custom nodes like callouts.

Confirmed via code inspection:
- `POST /logs` and `PUT /boards/:id/logs/:id` (the API paths `create_log`/`update_log`
  hit) apply **no HTML sanitization** — `Log#text` is saved verbatim if it already looks
  like HTML (`app/models/log.rb` `normalize_text_to_html`, only runs Kramdown on text
  with no tags at all). So any correctly-formed HTML already works end-to-end today; the
  gap is generation, not transport.
- The editor (`packages/web/src/components/editor/hooks/useEditorExtensions.tsx`) is
  Tiptap-based. Several node types (callout, image, toggle list, table) have
  non-obvious, exact HTML contracts enforced by their `parseHTML()` rules.

## Approach: pure local renderer tools

Add 12 new tools to `changologs-mcp/server.ts` and `worker.ts`. Each is a **pure
function — no network call, no auth, no state**: structured params in, one HTML
fragment string out, matching the target Tiptap node's `parseHTML()` contract
byte-for-byte.

The model calls several of these in a turn, concatenates the fragment strings itself,
then calls `create_log`/`update_log` exactly once with the assembled HTML as `text`.
No backend changes in the changologs Rails app are needed — everything lives in this
repo. No draft/session state is needed because nothing persists between calls; the
growing document lives in the calling model's own context, not on the server.

### Why not a stateful draft?

The MCP server is stateless by design (`sessionIdGenerator: undefined`, a fresh
`Server` instance per HTTP request — see `server.ts`). A true incremental builder
(`start_log_draft` → `add_*(draft_id)` → `finalize`) would require a new `log_drafts`
table, controller, and routes in the changologs Rails app — a real backend project, not
an MCP change — for no real benefit over the model just carrying the HTML string
itself across tool calls within one turn.

## Shared inline-text helper

`renderInline(text: string): string` — escapes HTML special characters, then applies a
small markdown-lite syntax so the model doesn't have to hand-write inline tags:
- `**bold**` → `<strong>`
- `_italic_` → `<em>`
- `` `code` `` → `<code>`
- `[text](url)` → `<a href="url" class="log-link">text</a>`

Used inside every text-bearing param: paragraph text, heading text, list items, table
cells, callout/toggle/blockquote content.

Multi-paragraph content (callout, toggle, blockquote) accepts either a single string
(one paragraph) or a string array (one `<p>` per entry).

## Tool catalog and HTML contracts

| Tool | Params | Output contract |
| --- | --- | --- |
| `add_paragraph` | `text` | `<p>{inline}</p>` |
| `add_heading` | `level` (1-3), `text` | `<h{level}>{inline}</h{level}>` |
| `add_bullet_list` | `items: string[]` | `<ul><li><p>{inline}</p></li>...</ul>` |
| `add_numbered_list` | `items: string[]` | `<ol><li><p>{inline}</p></li>...</ol>` |
| `add_task_list` | `items: {text, checked?}[]` | `<ul data-type="taskList"><li data-type="taskItem" data-checked="{bool}"><label><input type="checkbox" {checked}></label><div><p>{inline}</p></div></li>...</ul>` |
| `add_blockquote` | `text \| text[]` | `<blockquote><p>{inline}</p>...</blockquote>` |
| `add_code_block` | `code`, `language?` | `<pre><code class="language-{language}">{escaped code, no markdown-lite}</code></pre>` |
| `add_divider` | — | `<hr>` |
| `add_toggle` | `summary`, `content: string \| string[]` | `<details><summary>{inline}</summary><div class="toggle-content"><p>{inline}</p>...</div></details>` |
| `add_callout` | `text \| text[]`, `icon?` (default 💡) | `<div class="log-callout"><div class="log-callout-icon">{icon}</div><div class="log-callout-content"><p>{inline}</p>...</div></div>` |
| `add_table` | `rows: string[][]`, `headerRow?: boolean` | `<table><tr><td>{inline}</td>...</tr>...</table>` — **no `<th>`**: this schema never registered `TableHeader` (`PlainTableRow` content is `tableCell*`), so `headerRow: true` bolds the first row's cell text instead of changing the tag |
| `add_image` | `src` (URL), `altText?`, `caption?`, `linkUrl?` | `<div class="log-image" data-src="{src}" data-alt="{altText}" data-caption="{caption}" data-link="{linkUrl}"></div>` — atom node, no children. Requires an already-hosted image URL; there is no file-upload path available to the MCP. |

Code block content is NOT run through `renderInline` — code must be escaped only, never
markdown-processed.

## `create_log` / `update_log` description change

Add guidance: *"For anything beyond a single plain paragraph, call the relevant `add_*`
block tools first, concatenate their returned HTML fragments in document order, then
pass the assembled string as `text`."* This is what actually closes the original gap —
naming 12 tools helps the model's planning, but the explicit instruction on the
finalizing tool is what turns "write a rich log" into "call add_heading, add_table,
add_callout, then create_log."

## Testing

1. **Unit tests per renderer** — assert the exact fragment string for representative
   inputs (including escaping of `<`, `>`, `&` and markdown-lite edge cases).
2. **Schema round-trip check** — parse each fragment using the actual extension set
   (Callout, Image, ToggleList, PlainTableRow, TaskList/TaskItem, plus StarterKit
   defaults) via Tiptap's `generateJSON`, and assert it produces the expected node
   type/attrs. Catches contract drift if the editor's extensions change later, not just
   typos in the fragment templates.
3. **One manual check** in the running editor — create a log via the local Node server
   (`CHANGOLOGS_BASE_URL=http://localhost:3000 npm start`) against a local changologs
   dev instance, open it in the browser, confirm every block renders as its real node
   (not inert HTML) before calling this done. Node-view-only behavior (callout icon
   click, image toolbar) can't be verified by the round-trip check alone.

## Out of scope (phase 2)

`bookmark`, `mermaidDiagram`, `calendarViewEmbed`, `taskListEmbed`, `logEmbed`/
`logMention` — these need a live URL-preview fetch, a real task-list/log id created via
the existing API tools, or diagram syntax validation, so they don't fit the "pure
renderer, no network call" shape as cleanly. Worth a separate design pass once v1 ships
and more block types are added to the editor.
