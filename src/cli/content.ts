import fs from "node:fs";
import path from "node:path";

export interface ContentEntry {
  slug: string;
  frontmatter: Record<string, string | string[]>;
  /** markdown source, unrendered (the page renders it, highlight applies) */
  body: string;
  /** rendered html with heading anchors (T20-free: ids for TOC deep links) */
  html: string;
  readingTime: number;
  wordCount: number;
  toc: { level: number; text: string; id: string }[];
  excerpt: string;
}

/** Parse `---`-delimited frontmatter: `key: value` lines, `[a, b]` arrays. */
export function parseFrontmatter(raw: string): {
  frontmatter: Record<string, string | string[]>;
  body: string;
} {
  if (!raw.startsWith("---")) return { frontmatter: {}, body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return { frontmatter: {}, body: raw };
  const head = raw.slice(4, end);
  const body = raw.slice(raw.indexOf("\n", end + 1) + 1).replace(/^\s*\n/, "");
  const frontmatter: Record<string, string | string[]> = {};
  for (const line of head.split("\n")) {
    const m = /^(\w[\w-]*):\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const [, k, v] = m;
    const arr = /^\[(.+)\]$/.exec(v.trim());
    frontmatter[k] = arr
      ? arr[1].split(",").map((x) => x.trim().replace(/^["']|["']$/g, ""))
      : v.trim().replace(/^["']|["']$/g, "");
  }
  return { frontmatter, body };
}

/** Mini-markdown → HTML: headings, fenced code, lists, bold/italic/code,
 *  links, paragraphs. Zero dependencies; ~100 lines cover the blog 90%. */
function interpolate(md: string, vars: Record<string, unknown>): string {
  return md.replace(/{{(\w[\w.]*)}}/g, (_m, k) => {
    const v = k.split(".").reduce((o: any, p) => (o == null ? o : o[p]), vars as any);
    return v === undefined || v === null ? "" : String(v);
  });
}

export function renderMarkdown(md: string, vars?: Record<string, unknown>): string {
  if (vars) md = interpolate(md, vars);
  const blocks: string[] = [];
  let src = md.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    blocks.push(
      `<pre data-lang="${lang}"><code>${code
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")}</code></pre>`,
    );
    return `\u0000CODE${blocks.length - 1}\u0000`;
  });

  const inline = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      .replace(
        /\[([^\]]+)\]\(([^)]+)\)/g,
        '<a href="$2" rel="noopener">$1</a>',
      );

  const out: string[] = [];
  let listOpen: "ul" | "ol" | null = null;
  const closeList = () => {
    if (listOpen) { out.push(`</${listOpen}>`); listOpen = null; }
  };
  for (const line of src.split("\n")) {
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    const oli = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (h) { closeList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); }
    else if (li) {
      if (listOpen !== "ul") { closeList(); out.push("<ul>"); listOpen = "ul"; }
      out.push(`<li>${inline(li[1])}</li>`);
    } else if (oli) {
      if (listOpen !== "ol") { closeList(); out.push("<ol>"); listOpen = "ol"; }
      out.push(`<li>${inline(oli[1])}</li>`);
    } else if (line.trim() === "") { closeList(); }
    else if (line.startsWith("\u0000CODE")) { closeList(); out.push(line); }
    else { closeList(); out.push(`<p>${inline(line)}</p>`); }
  }
  closeList();
  return out
    .join("\n")
    .replace(/\u0000CODE(\d+)\u0000/g, (_m, i) => blocks[Number(i)]);
}

/** Scan src/content/<collection>/*.md into entries (slug = filename). */
export function scanContentDir(contentDir: string): Record<string, ContentEntry[]> {
  const collections: Record<string, ContentEntry[]> = {};
  if (!fs.existsSync(contentDir)) return collections;
  for (const coll of fs.readdirSync(contentDir, { withFileTypes: true })) {
    if (!coll.isDirectory()) continue;
    const entries: ContentEntry[] = [];
    const dir = path.join(contentDir, coll.name);
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      const raw = fs.readFileSync(path.join(dir, f), "utf-8");
            const { frontmatter, body } = parseFrontmatter(raw);
      if (String(frontmatter.draft ?? "").toLowerCase() === "true") continue;
      const slug = f.replace(/\.md$/, "");
      const html = renderMarkdown(body);
      const words = body.replace(/[#*`\[\]()>-]/g, " ").split(/\s+/).filter(Boolean).length;
      const headings: { level: number; text: string; id: string }[] = [];
      const tocHtml = html.replace(/<h([1-4])>([^<]+)<\/h\1>/g, (_m, lvl: string, txt: string) => {
        const id = txt.toLowerCase().replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-");
        headings.push({ level: Number(lvl), text: txt, id });
        return `<h${lvl} id="${id}">${txt}</h${lvl}>`;
      });
      entries.push({
        slug, frontmatter,
        body, html: tocHtml,
        readingTime: Math.max(1, Math.round(words / 200)),
        wordCount: words,
        toc: headings,
        excerpt: String(frontmatter.summary ?? "") || (html.match(/<p>([\s\S]*?)<\/p>/)?.[1] ?? "").replace(/<[^>]+>/g, "").slice(0, 160),
      });
    }
    entries.sort((a, b) =>
      String(b.frontmatter.date ?? "").localeCompare(String(a.frontmatter.date ?? "")),
    );
    collections[coll.name] = entries;
  }
  return collections;
}

/** Prev/next navigation within a collection (date-descending order). */
export function prevNext(
  entries: ContentEntry[],
  slug: string,
): { prev: ContentEntry | null; next: ContentEntry | null } {
  const i = entries.findIndex((e) => e.slug === slug);
  return { prev: i > 0 ? entries[i - 1] : null, next: i >= 0 && i < entries.length - 1 ? entries[i + 1] : null };
}

/** Group a collection by a frontmatter array field (tags/categories). */
export function byTag(
  entries: ContentEntry[],
  field: string,
): Record<string, ContentEntry[]> {
  const out: Record<string, ContentEntry[]> = {};
  for (const e of entries) {
    for (const t of (e.frontmatter[field] as string[] | undefined) ?? []) {
      (out[t] ??= []).push(e);
    }
  }
  return out;
}

globalThis.__rosefnContentMk = renderMarkdown;

/** RSS 2.0 feed from a collection - wire to /feed.xml or /api/feed. */
export function buildRss(
  entries: ContentEntry[],
  opts: { title: string; origin: string; description?: string; pathPrefix?: string },
): string {
  const esc = (v: unknown) =>
    String(v ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const prefix = opts.pathPrefix ?? "/";
  const items = entries
    .map((e) => {
      const url = `${opts.origin}${prefix}${e.slug}`;
      const pub = e.frontmatter.date ? new Date(String(e.frontmatter.date)).toUTCString() : "";
      const excerpt = e.excerpt ? `<description>${esc(e.excerpt)}</description>` : "";
      return `    <item>\n      <title>${esc(e.frontmatter.title)}</title>\n      <link>${esc(url)}</link>\n      <guid isPermaLink="true">${esc(url)}</guid>\n      ${pub ? `<pubDate>${pub}</pubDate>\n      ` : ""}${excerpt}\n    </item>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel>\n<title>${esc(opts.title)}</title>\n<link>${esc(opts.origin)}${prefix}</link>\n<description>${esc(opts.description ?? "")}</description>\n${items}\n</channel></rss>`;
}
