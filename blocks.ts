// Pure HTML-fragment renderers for the "add_*" block tools.
//
// Each renderer takes structured params and returns one HTML fragment string
// that matches, byte-for-byte, what the changologs editor's Tiptap node
// schema expects in `parseHTML()` (see
// packages/web/src/components/editor/extensions/*.ts and the underlying
// @tiptap/extension-* packages in the changologs repo). No network calls,
// no state: the calling model concatenates these fragments itself and passes
// the result to create_log/update_log's `text` param, which already accepts
// raw HTML untouched.
//
// See docs/plans/2026-10-19-rich-log-block-tools-design.md for the full
// design and the contract table this file implements.

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Lightweight markdown-ish inline formatting: **bold**, _italic_, `code`,
// [text](url). Not a full markdown parser -- deliberately simple so block
// tool params stay plain strings instead of requiring hand-written HTML.
// Code spans are protected first so their contents aren't re-processed by
// the bold/italic/link passes.
export function renderInline(text: string): string {
  const escaped = escapeHtml(text);

  const codeSpans: string[] = [];
  let working = escaped.replace(/`([^`]+)`/g, (_match, code: string) => {
    codeSpans.push(`<code>${code}</code>`);
    return `\u0000${codeSpans.length - 1}\u0000`;
  });

  working = working.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_match, label: string, url: string) => `<a href="${url}" class="log-link">${label}</a>`,
  );
  working = working.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  working = working.replace(/_([^_]+)_/g, "<em>$1</em>");

  working = working.replace(/\u0000(\d+)\u0000/g, (_match, i: string) => codeSpans[Number(i)]);
  return working;
}

function renderParagraphs(content: string | string[]): string {
  const paragraphs = Array.isArray(content) ? content : [content];
  return paragraphs.map((p) => `<p>${renderInline(p)}</p>`).join("");
}

export function renderParagraph(text: string): string {
  return `<p>${renderInline(text)}</p>`;
}

export function renderHeading(level: number, text: string): string {
  const lvl = Math.min(Math.max(Math.round(level), 1), 3);
  return `<h${lvl}>${renderInline(text)}</h${lvl}>`;
}

export function renderBulletList(items: string[]): string {
  const lis = items.map((item) => `<li><p>${renderInline(item)}</p></li>`).join("");
  return `<ul>${lis}</ul>`;
}

export function renderNumberedList(items: string[]): string {
  const lis = items.map((item) => `<li><p>${renderInline(item)}</p></li>`).join("");
  return `<ol>${lis}</ol>`;
}

export interface TaskListItem {
  text: string;
  checked?: boolean;
}

export function renderTaskList(items: TaskListItem[]): string {
  const lis = items
    .map((item) => {
      const checkedAttr = item.checked ? " checked" : "";
      const dataChecked = item.checked ? "true" : "false";
      return `<li data-type="taskItem" data-checked="${dataChecked}"><label><input type="checkbox"${checkedAttr}></label><div><p>${renderInline(item.text)}</p></div></li>`;
    })
    .join("");
  return `<ul data-type="taskList">${lis}</ul>`;
}

export function renderBlockquote(content: string | string[]): string {
  return `<blockquote>${renderParagraphs(content)}</blockquote>`;
}

export function renderCodeBlock(code: string, language?: string): string {
  const escaped = escapeHtml(code); // never markdown-processed
  const cls = language ? ` class="language-${escapeHtml(language)}"` : "";
  return `<pre><code${cls}>${escaped}</code></pre>`;
}

export function renderDivider(): string {
  return "<hr>";
}

export function renderToggle(summary: string, content: string | string[]): string {
  return `<details><summary>${renderInline(summary)}</summary><div class="toggle-content">${renderParagraphs(content)}</div></details>`;
}

export function renderCallout(content: string | string[], icon: string = "\u{1F4A1}"): string {
  return `<div class="log-callout"><div class="log-callout-icon">${escapeHtml(icon)}</div><div class="log-callout-content">${renderParagraphs(content)}</div></div>`;
}

export function renderTable(rows: string[][], headerRow: boolean = false): string {
  const trs = rows
    .map((row, i) => {
      const tds = row
        .map((cell) => {
          const inline = renderInline(cell);
          const content = headerRow && i === 0 ? `<strong>${inline}</strong>` : inline;
          return `<td>${content}</td>`;
        })
        .join("");
      return `<tr>${tds}</tr>`;
    })
    .join("");
  return `<table>${trs}</table>`;
}

export function renderImage(src: string, altText?: string, caption?: string, linkUrl?: string): string {
  const attrs = [`data-src="${escapeHtml(src)}"`];
  if (altText) attrs.push(`data-alt="${escapeHtml(altText)}"`);
  if (caption) attrs.push(`data-caption="${escapeHtml(caption)}"`);
  if (linkUrl) attrs.push(`data-link="${escapeHtml(linkUrl)}"`);
  return `<div class="log-image" ${attrs.join(" ")}></div>`;
}

// ── Tool schema definitions (for ListToolsRequestSchema) ────────────────────

const TEXT_OR_PARAGRAPHS_SCHEMA = {
  anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
  description: "A single paragraph, or an array of strings for multiple paragraphs.",
};

export const BLOCK_TOOLS = [
  {
    name: "add_paragraph",
    description: "Render a plain paragraph block as an HTML fragment. Supports **bold**, _italic_, `code`, and [text](url) inline formatting. Does not call the changologs API -- concatenate the returned fragment with others and pass the result to create_log/update_log's `text` param.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Paragraph text." },
      },
      required: ["text"],
    },
  },
  {
    name: "add_heading",
    description: "Render a heading block (h1-h3) as an HTML fragment. Does not call the changologs API.",
    inputSchema: {
      type: "object",
      properties: {
        level: { type: "integer", enum: [1, 2, 3], description: "Heading level." },
        text: { type: "string", description: "Heading text." },
      },
      required: ["level", "text"],
    },
  },
  {
    name: "add_bullet_list",
    description: "Render an unordered (bullet) list block as an HTML fragment. Does not call the changologs API.",
    inputSchema: {
      type: "object",
      properties: {
        items: { type: "array", items: { type: "string" }, description: "List items, in order." },
      },
      required: ["items"],
    },
  },
  {
    name: "add_numbered_list",
    description: "Render an ordered (numbered) list block as an HTML fragment. Does not call the changologs API.",
    inputSchema: {
      type: "object",
      properties: {
        items: { type: "array", items: { type: "string" }, description: "List items, in order." },
      },
      required: ["items"],
    },
  },
  {
    name: "add_task_list",
    description: "Render a checkbox task list block as an HTML fragment. Does not call the changologs API. This is an inline checklist inside a log's content -- unrelated to the create_task/list_tasks tools, which manage a separate task list resource.",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              text: { type: "string" },
              checked: { type: "boolean", description: "Defaults to false." },
            },
            required: ["text"],
          },
        },
      },
      required: ["items"],
    },
  },
  {
    name: "add_blockquote",
    description: "Render a blockquote block as an HTML fragment. Does not call the changologs API.",
    inputSchema: {
      type: "object",
      properties: { text: TEXT_OR_PARAGRAPHS_SCHEMA },
      required: ["text"],
    },
  },
  {
    name: "add_code_block",
    description: "Render a fenced code block as an HTML fragment. Content is escaped verbatim -- no inline markdown formatting is applied to code. Does not call the changologs API.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "The code, verbatim." },
        language: { type: "string", description: "Optional language label, e.g. \"typescript\"." },
      },
      required: ["code"],
    },
  },
  {
    name: "add_divider",
    description: "Render a horizontal rule (divider) block as an HTML fragment. Does not call the changologs API.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "add_toggle",
    description: "Render a collapsible toggle block (summary + hidden content) as an HTML fragment. Does not call the changologs API.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Always-visible summary line." },
        content: { ...TEXT_OR_PARAGRAPHS_SCHEMA, description: "Content hidden until the toggle is expanded. " + TEXT_OR_PARAGRAPHS_SCHEMA.description },
      },
      required: ["summary", "content"],
    },
  },
  {
    name: "add_callout",
    description: "Render a callout/admonition block (icon + highlighted box) as an HTML fragment. Use for notes, warnings, or anything that should stand out from surrounding text. Does not call the changologs API.",
    inputSchema: {
      type: "object",
      properties: {
        text: TEXT_OR_PARAGRAPHS_SCHEMA,
        icon: { type: "string", description: "A single emoji. Defaults to \u{1F4A1}." },
      },
      required: ["text"],
    },
  },
  {
    name: "add_table",
    description: "Render a table block as an HTML fragment. This editor's table schema has no header-row tag -- set header_row: true to bold the first row's text instead of using <th>. Does not call the changologs API.",
    inputSchema: {
      type: "object",
      properties: {
        rows: {
          type: "array",
          items: { type: "array", items: { type: "string" } },
          description: "Rows of cell text, e.g. [[\"Name\",\"Status\"],[\"Alice\",\"Done\"]].",
        },
        header_row: { type: "boolean", description: "Bold the first row's cells. Defaults to false." },
      },
      required: ["rows"],
    },
  },
  {
    name: "add_image",
    description: "Render an image block as an HTML fragment, from an already-hosted image URL. There is no file-upload path available to this tool -- src must be a URL the browser can load directly. Does not call the changologs API.",
    inputSchema: {
      type: "object",
      properties: {
        src: { type: "string", description: "Image URL." },
        alt_text: { type: "string", description: "Alt text." },
        caption: { type: "string", description: "Caption shown below the image." },
        link_url: { type: "string", description: "Wrap the image in a link to this URL." },
      },
      required: ["src"],
    },
  },
] as const;

export const BLOCK_TOOL_NAMES = new Set(BLOCK_TOOLS.map((t) => t.name));

// Dispatches a block tool call to its renderer. Returns null if `name` isn't
// a block tool, so callers can fall through to their existing dispatch.
export function renderBlockTool(name: string, args: Record<string, unknown> | undefined): string | null {
  const a = args ?? {};
  switch (name) {
    case "add_paragraph":
      return renderParagraph(a.text as string);
    case "add_heading":
      return renderHeading(a.level as number, a.text as string);
    case "add_bullet_list":
      return renderBulletList(a.items as string[]);
    case "add_numbered_list":
      return renderNumberedList(a.items as string[]);
    case "add_task_list":
      return renderTaskList(a.items as TaskListItem[]);
    case "add_blockquote":
      return renderBlockquote(a.text as string | string[]);
    case "add_code_block":
      return renderCodeBlock(a.code as string, a.language as string | undefined);
    case "add_divider":
      return renderDivider();
    case "add_toggle":
      return renderToggle(a.summary as string, a.content as string | string[]);
    case "add_callout":
      return renderCallout(a.text as string | string[], a.icon as string | undefined);
    case "add_table":
      return renderTable(a.rows as string[][], a.header_row as boolean | undefined);
    case "add_image":
      return renderImage(
        a.src as string,
        a.alt_text as string | undefined,
        a.caption as string | undefined,
        a.link_url as string | undefined,
      );
    default:
      return null;
  }
}
