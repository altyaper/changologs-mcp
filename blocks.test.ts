import { describe, expect, it } from "vitest";
import {
  renderInline,
  renderParagraph,
  renderHeading,
  renderBulletList,
  renderNumberedList,
  renderTaskList,
  renderBlockquote,
  renderCodeBlock,
  renderDivider,
  renderToggle,
  renderCallout,
  renderTable,
  renderImage,
  renderBlockTool,
} from "./blocks.js";

describe("renderInline", () => {
  it("escapes HTML special characters", () => {
    expect(renderInline("a < b & c > d \"quote\"")).toBe(
      "a &lt; b &amp; c &gt; d &quot;quote&quot;",
    );
  });

  it("renders bold, italic, code, and links", () => {
    expect(renderInline("**bold**")).toBe("<strong>bold</strong>");
    expect(renderInline("_italic_")).toBe("<em>italic</em>");
    expect(renderInline("`code`")).toBe("<code>code</code>");
    expect(renderInline("[text](https://example.com)")).toBe(
      '<a href="https://example.com" class="log-link">text</a>',
    );
  });

  it("does not reprocess markdown markers inside code spans", () => {
    expect(renderInline("`**not bold**`")).toBe("<code>**not bold**</code>");
  });

  it("combines multiple inline styles in one string", () => {
    expect(renderInline("**bold** and _italic_ and `code`")).toBe(
      "<strong>bold</strong> and <em>italic</em> and <code>code</code>",
    );
  });
});

describe("renderParagraph", () => {
  it("wraps text in a <p> with inline formatting applied", () => {
    expect(renderParagraph("hello **world**")).toBe("<p>hello <strong>world</strong></p>");
  });
});

describe("renderHeading", () => {
  it("renders h1-h3", () => {
    expect(renderHeading(1, "Title")).toBe("<h1>Title</h1>");
    expect(renderHeading(2, "Title")).toBe("<h2>Title</h2>");
    expect(renderHeading(3, "Title")).toBe("<h3>Title</h3>");
  });

  it("clamps out-of-range levels to 1-3", () => {
    expect(renderHeading(0, "x")).toBe("<h1>x</h1>");
    expect(renderHeading(6, "x")).toBe("<h3>x</h3>");
  });
});

describe("renderBulletList / renderNumberedList", () => {
  it("wraps each item in <li><p>...</p></li>", () => {
    expect(renderBulletList(["a", "b"])).toBe("<ul><li><p>a</p></li><li><p>b</p></li></ul>");
    expect(renderNumberedList(["a", "b"])).toBe("<ol><li><p>a</p></li><li><p>b</p></li></ol>");
  });
});

describe("renderTaskList", () => {
  it("renders checked and unchecked items with the taskItem contract", () => {
    expect(renderTaskList([{ text: "done", checked: true }, { text: "todo" }])).toBe(
      '<ul data-type="taskList">' +
        '<li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked></label><div><p>done</p></div></li>' +
        '<li data-type="taskItem" data-checked="false"><label><input type="checkbox"></label><div><p>todo</p></div></li>' +
        "</ul>",
    );
  });
});

describe("renderBlockquote", () => {
  it("accepts a single string or an array of paragraphs", () => {
    expect(renderBlockquote("one")).toBe("<blockquote><p>one</p></blockquote>");
    expect(renderBlockquote(["one", "two"])).toBe(
      "<blockquote><p>one</p><p>two</p></blockquote>",
    );
  });
});

describe("renderCodeBlock", () => {
  it("escapes content and never applies inline markdown formatting", () => {
    expect(renderCodeBlock("const x = a < b && **not bold**")).toBe(
      "<pre><code>const x = a &lt; b &amp;&amp; **not bold**</code></pre>",
    );
  });

  it("adds a language class when given", () => {
    expect(renderCodeBlock("x", "typescript")).toBe(
      '<pre><code class="language-typescript">x</code></pre>',
    );
  });
});

describe("renderDivider", () => {
  it("renders an <hr>", () => {
    expect(renderDivider()).toBe("<hr>");
  });
});

describe("renderToggle", () => {
  it("renders details/summary with a toggle-content div", () => {
    expect(renderToggle("More info", "hidden text")).toBe(
      '<details><summary>More info</summary><div class="toggle-content"><p>hidden text</p></div></details>',
    );
  });
});

describe("renderCallout", () => {
  it("uses the default icon when none is given", () => {
    expect(renderCallout("note")).toBe(
      '<div class="log-callout"><div class="log-callout-icon">\u{1F4A1}</div><div class="log-callout-content"><p>note</p></div></div>',
    );
  });

  it("accepts a custom icon and multiple paragraphs", () => {
    expect(renderCallout(["a", "b"], "⚠️")).toBe(
      '<div class="log-callout"><div class="log-callout-icon">⚠️</div><div class="log-callout-content"><p>a</p><p>b</p></div></div>',
    );
  });
});

describe("renderTable", () => {
  it("renders every cell as <td>, never <th>", () => {
    expect(renderTable([["a", "b"], ["c", "d"]])).toBe(
      "<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>",
    );
  });

  it("bolds the first row's text instead of using <th> when header_row is set", () => {
    expect(renderTable([["Name", "Status"], ["Alice", "Done"]], true)).toBe(
      "<table><tr><td><strong>Name</strong></td><td><strong>Status</strong></td></tr>" +
        "<tr><td>Alice</td><td>Done</td></tr></table>",
    );
  });
});

describe("renderImage", () => {
  it("renders only data-src when optional fields are omitted", () => {
    expect(renderImage("https://example.com/x.png")).toBe(
      '<div class="log-image" data-src="https://example.com/x.png"></div>',
    );
  });

  it("renders all attributes when given", () => {
    expect(renderImage("https://x/y.png", "alt", "cap", "https://link")).toBe(
      '<div class="log-image" data-src="https://x/y.png" data-alt="alt" data-caption="cap" data-link="https://link"></div>',
    );
  });
});

describe("renderBlockTool", () => {
  it("dispatches by tool name", () => {
    expect(renderBlockTool("add_paragraph", { text: "hi" })).toBe("<p>hi</p>");
    expect(renderBlockTool("add_divider", {})).toBe("<hr>");
  });

  it("returns null for unknown tool names", () => {
    expect(renderBlockTool("create_log", { text: "hi" })).toBeNull();
  });
});
