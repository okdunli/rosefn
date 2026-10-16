// compiler/index.ts
import * as fs4 from "fs";
import * as path3 from "path";
import * as os from "os";
import { pathToFileURL, fileURLToPath } from "url";
import * as esbuild from "esbuild";

// compiler/errors.ts
var RoseError = class extends Error {
  code;
  file;
  line;
  hint;
  constructor(code, message, opts = {}) {
    super(message);
    this.name = "RoseError";
    this.code = code;
    this.file = opts.file;
    this.line = opts.line;
    this.hint = opts.hint;
  }
  info() {
    const info = { code: this.code };
    if (this.file !== void 0) info.file = this.file;
    if (this.line !== void 0) info.line = this.line;
    info.message = this.message;
    if (this.hint !== void 0) info.hint = this.hint;
    return info;
  }
};
function lineOf(src, index) {
  let line = 1;
  const end = Math.min(index, src.length);
  for (let i = 0; i < end; i++) {
    if (src[i] === "\n") line++;
  }
  return line;
}
function lineAt(src, match) {
  return match && match.index !== void 0 ? lineOf(src, match.index) : void 0;
}
function errorInfo(err) {
  if (err instanceof RoseError) return err.info();
  return { code: "E-UNKNOWN", message: err instanceof Error ? err.message : String(err) };
}
function codeFrame(src, line, opts = {}) {
  const radius = Math.max(0, opts.radius ?? 1);
  const lines = src.split("\n");
  const from = Math.max(1, line - radius);
  const to = Math.min(lines.length, line + radius);
  const gutter = String(to).length;
  const out = [];
  for (let n = from; n <= to; n++) {
    const text = lines[n - 1] ?? "";
    out.push(`  ${String(n).padStart(gutter)} | ${text}`);
    if (n === line && opts.column !== void 0) {
      out.push(`  ${" ".repeat(gutter)} | ${" ".repeat(Math.max(0, opts.column - 1))}^`);
    }
  }
  return out.join("\n");
}

// compiler/rm-fast.ts
import fs from "node:fs";
import path from "node:path";
var PARALLEL = 64;
var STALE_BUILD_MS = 30 * 60 * 1e3;
async function rmRetry(p) {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.promises.rm(p, { force: true });
      return;
    } catch (err) {
      if (attempt >= 2 || !/EPERM|EBUSY|EACCES/.test(String(err))) throw err;
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
    }
  }
}
async function chunked(items) {
  for (let c = 0; c < items.length; c += PARALLEL) {
    await Promise.all(items.slice(c, c + PARALLEL).map(rmRetry));
  }
}
async function entriesOf(dir) {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
async function rmTreeParallel(dir) {
  const entries = await entriesOf(dir);
  const files = [];
  const dirs = [];
  for (const e of entries) {
    if (e.isDirectory()) dirs.push(path.join(dir, e.name));
    else files.push(path.join(dir, e.name));
  }
  await chunked(files);
  await Promise.all(dirs.map((d) => rmTreeParallel(d)));
  await fs.promises.rmdir(dir).catch(() => {
  });
}
function sweepStaleBuildDirs(parent) {
  fs.promises.readdir(parent).then((names) => {
    const now = Date.now();
    for (const n of names) {
      const p = path.join(parent, n);
      fs.promises.stat(p).then((st) => {
        if (st.isDirectory() && now - st.mtimeMs > STALE_BUILD_MS) {
          rmTreeParallel(p).catch(() => {
          });
        }
      }).catch(() => {
      });
    }
  }).catch(() => {
  });
}

// hash.ts
function fnv1a32(input) {
  let h = 2166136261;
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

// cli/image-size.ts
import fs2 from "node:fs";
function readImageSize(filePath2) {
  try {
    const fd = fs2.openSync(filePath2, "r");
    const buf = Buffer.alloc(64);
    const read = fs2.readSync(fd, buf, 0, 64, 0);
    fs2.closeSync(fd);
    if (read < 24) return null;
    if (buf[0] === 137 && buf[1] === 80 && buf[2] === 78 && buf[3] === 71) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (buf.slice(0, 3).toString("latin1") === "GIF") {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (buf.slice(0, 4).toString("latin1") === "RIFF" && buf.slice(8, 12).toString("latin1") === "WEBP") {
      return parseWebP(buf);
    }
    if (buf[0] === 255 && buf[1] === 216) {
      return parseJpeg(filePath2);
    }
    return null;
  } catch {
    return null;
  }
}
function parseWebP(buf) {
  const format = buf.slice(12, 16).toString("latin1");
  if (format === "VP8 ") {
    return { width: buf.readUInt16LE(26) & 16383, height: buf.readUInt16LE(28) & 16383 };
  }
  if (format === "VP8L") {
    const b = buf.readUInt32LE(21);
    return { width: (b & 16383) + 1, height: (b >> 14 & 16383) + 1 };
  }
  if (format === "VP8X") {
    const w = buf.readUIntLE(24, 3) + 1;
    const h = buf.readUIntLE(27, 3) + 1;
    return { width: w, height: h };
  }
  return null;
}
function parseJpeg(filePath2) {
  const fd = fs2.openSync(filePath2, "r");
  try {
    const buf = Buffer.alloc(4);
    let pos = 2;
    for (let guard = 0; guard < 64; guard++) {
      if (fs2.readSync(fd, buf, 0, 4, pos) < 4) return null;
      if (buf[0] !== 255) {
        pos += 1;
        continue;
      }
      const marker = buf[1];
      if (marker === 216 || marker === 1 || marker >= 208 && marker <= 215) {
        pos += 2;
        continue;
      }
      const len = fs2.readSync(fd, buf, 0, 2, pos + 2) < 2 ? 0 : buf.readUInt16BE(2);
      if (marker >= 192 && marker <= 207 && marker !== 196 && marker !== 200 && marker !== 204) {
        const seg = Buffer.alloc(8);
        fs2.readSync(fd, seg, 0, 8, pos + 4);
        return { width: seg.readUInt16BE(3), height: seg.readUInt16BE(1) };
      }
      pos += 2 + len;
    }
    return null;
  } finally {
    fs2.closeSync(fd);
  }
}

// cli/content.ts
import fs3 from "node:fs";
import path2 from "node:path";
function parseFrontmatter(raw) {
  if (!raw.startsWith("---")) return { frontmatter: {}, body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return { frontmatter: {}, body: raw };
  const head = raw.slice(4, end);
  const body = raw.slice(raw.indexOf("\n", end + 1) + 1).replace(/^\s*\n/, "");
  const frontmatter = {};
  for (const line of head.split("\n")) {
    const m = /^(\w[\w-]*):\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const [, k, v] = m;
    const arr = /^\[(.+)\]$/.exec(v.trim());
    frontmatter[k] = arr ? arr[1].split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")) : v.trim().replace(/^["']|["']$/g, "");
  }
  return { frontmatter, body };
}
function interpolate(md, vars) {
  return md.replace(/{{(\w[\w.]*)}}/g, (_m, k) => {
    const v = k.split(".").reduce((o, p) => o == null ? o : o[p], vars);
    return v === void 0 || v === null ? "" : String(v);
  });
}
function renderMarkdown(md, vars) {
  if (vars) md = interpolate(md, vars);
  const blocks = [];
  let src = md.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    blocks.push(
      `<pre data-lang="${lang}"><code>${code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</code></pre>`
    );
    return `\0CODE${blocks.length - 1}\0`;
  });
  const inline = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/\*([^*]+)\*/g, "<em>$1</em>").replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" rel="noopener">$1</a>'
  );
  const out = [];
  let listOpen = null;
  const closeList = () => {
    if (listOpen) {
      out.push(`</${listOpen}>`);
      listOpen = null;
    }
  };
  for (const line of src.split("\n")) {
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    const oli = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (h) {
      closeList();
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
    } else if (li) {
      if (listOpen !== "ul") {
        closeList();
        out.push("<ul>");
        listOpen = "ul";
      }
      out.push(`<li>${inline(li[1])}</li>`);
    } else if (oli) {
      if (listOpen !== "ol") {
        closeList();
        out.push("<ol>");
        listOpen = "ol";
      }
      out.push(`<li>${inline(oli[1])}</li>`);
    } else if (line.trim() === "") {
      closeList();
    } else if (line.startsWith("\0CODE")) {
      closeList();
      out.push(line);
    } else {
      closeList();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  closeList();
  return out.join("\n").replace(/\u0000CODE(\d+)\u0000/g, (_m, i) => blocks[Number(i)]);
}
function scanContentDir(contentDir) {
  const collections = {};
  if (!fs3.existsSync(contentDir)) return collections;
  for (const coll of fs3.readdirSync(contentDir, { withFileTypes: true })) {
    if (!coll.isDirectory()) continue;
    const entries = [];
    const dir = path2.join(contentDir, coll.name);
    for (const f of fs3.readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      const raw = fs3.readFileSync(path2.join(dir, f), "utf-8");
      const { frontmatter, body } = parseFrontmatter(raw);
      if (String(frontmatter.draft ?? "").toLowerCase() === "true") continue;
      const slug = f.replace(/\.md$/, "");
      const html = renderMarkdown(body);
      const words = body.replace(/[#*`\[\]()>-]/g, " ").split(/\s+/).filter(Boolean).length;
      const headings = [];
      const tocHtml = html.replace(/<h([1-4])>([^<]+)<\/h\1>/g, (_m, lvl, txt) => {
        const id = txt.toLowerCase().replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-");
        headings.push({ level: Number(lvl), text: txt, id });
        return `<h${lvl} id="${id}">${txt}</h${lvl}>`;
      });
      entries.push({
        slug,
        frontmatter,
        body,
        html: tocHtml,
        readingTime: Math.max(1, Math.round(words / 200)),
        wordCount: words,
        toc: headings,
        excerpt: String(frontmatter.summary ?? "") || (html.match(/<p>([\s\S]*?)<\/p>/)?.[1] ?? "").replace(/<[^>]+>/g, "").slice(0, 160)
      });
    }
    entries.sort(
      (a, b) => String(b.frontmatter.date ?? "").localeCompare(String(a.frontmatter.date ?? ""))
    );
    collections[coll.name] = entries;
  }
  return collections;
}
globalThis.__rosespanContentMk = renderMarkdown;

// compiler/index.ts
var __esbuildCache = /* @__PURE__ */ new Map();
function runEsbuild(key, opts, incremental) {
  if (!incremental || opts.splitting) return esbuild.build(opts);
  const ex = __esbuildCache.get(key);
  if (ex) return ex.rebuild().catch((e) => {
    __esbuildCache.delete(key);
    throw e;
  });
  return esbuild.context(opts).then((c) => {
    __esbuildCache.set(key, c);
    return c.rebuild();
  });
}
var COMPONENT_RE = /<script>([\s\S]*?)<\/script>/;
var TEMPLATE_RE = /<template>([\s\S]*?)<\/template>/;
var HEAD_RE = /<head>([\s\S]*?)<\/head>/;
var STYLE_RE = /<style>([\s\S]*?)<\/style>/;
var DECL_RE = /(?:let|const|var)\s+(\w+)[^=]*=\s*\$(state|data|kv|persist|derived)\b/g;
var DECL_CAST_RE = /^\s+as\s+[^;\n]+/;
var SETSTATE_RE = /\$setState\(([^,]+),\s*([^)]+)\)/g;
var SLOT_RE = /<slot\s*\/>|<slot>([\s\S]*?)<\/slot>/g;
var SLOT_NAMED_RE = /<slot\s+((?=[^>]*\bname\s*=)[^>]*?)(?:\/>|>([\s\S]*?)<\/slot>)/g;
function encodeSlotCall(attrs) {
  const name = /\bname\s*=\s*["'](\w+)["']/.exec(attrs)?.[1];
  if (!name) throw new RoseError("E-TEMPLATE", '<slot> with attributes must declare a name: <slot name="row" ... />', { hint: 'a slot carrying attributes is a NAMED slot - it must declare which one: <slot name="row" item={post} />' });
  const pairs = [...attrs.matchAll(/\b(\w+)\s*=\s*\{([^}]*)\}/g)].filter((m) => m[1] !== "name").map((m) => `['${m[1]}', (${m[2].trim()})]`);
  return `${JSON.stringify(name)}, [${pairs.join(", ")}]`;
}
var BOUNDARY_FALLBACK = "<p>This section failed to render.</p>";
var HTTP_METHODS = /* @__PURE__ */ new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
var TS_LOADER = { loader: { ".js": "ts" } };
function callifyStateReads(script, names) {
  if (names.length === 0) return script;
  const scan = (src) => {
    let out = "";
    let i = 0;
    while (i < src.length) {
      const ch = src[i];
      if (ch === "'" || ch === '"') {
        let j = i + 1;
        while (j < src.length && src[j] !== ch) {
          if (src[j] === "\\") j++;
          j++;
        }
        out += src.slice(i, Math.min(j + 1, src.length));
        i = j + 1;
        continue;
      }
      if (ch === "`") {
        out += ch;
        i++;
        while (i < src.length && src[i] !== "`") {
          if (src[i] === "\\") {
            out += src.slice(i, i + 2);
            i += 2;
            continue;
          }
          if (src[i] === "$" && src[i + 1] === "{") {
            let depth = 1;
            let j = i + 2;
            while (j < src.length && depth > 0) {
              if (src[j] === "{") depth++;
              else if (src[j] === "}") depth--;
              if (depth === 0) break;
              j++;
            }
            out += "${" + scan(src.slice(i + 2, j)) + "}";
            i = j + 1;
            continue;
          }
          out += src[i];
          i++;
        }
        out += "`";
        i++;
        continue;
      }
      if (ch === "/" && src[i + 1] === "/") {
        const nl = src.indexOf("\n", i);
        const end = nl === -1 ? src.length : nl;
        out += src.slice(i, end);
        i = end;
        continue;
      }
      if (ch === "/" && src[i + 1] === "*") {
        const close = src.indexOf("*/", i + 2);
        const end = close === -1 ? src.length : close + 2;
        out += src.slice(i, end);
        i = end;
        continue;
      }
      if (/[A-Za-z_$]/.test(ch)) {
        let j = i;
        while (j < src.length && /[\w$]/.test(src[j])) j++;
        const word = src.slice(i, j);
        const prev = out.length ? out[out.length - 1] : "";
        const next = src[j] ?? "";
        const rewrite = names.includes(word) && !/[\w$.]/.test(prev) && !/[\w$:(]/.test(next);
        out += rewrite ? `${word}()` : word;
        i = j;
        continue;
      }
      out += ch;
      i++;
    }
    return out;
  };
  return scan(script);
}
function callifyTemplateExprs(template, names) {
  if (names.length === 0) return template;
  let out = "";
  let last = 0;
  for (const s of templateExprSpans(template)) {
    out += template.slice(last, s.start) + "{" + callifyStateReads(s.expr, names) + "}";
    last = s.end + 1;
  }
  return out + template.slice(last);
}
function templateExprSpans(src) {
  const spans = [];
  let i = 0;
  while (i < src.length) {
    if (src[i] === "{") {
      const end = scanExprEnd(src, i);
      if (end > i + 1) {
        spans.push({ start: i, end, expr: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    i++;
  }
  return spans;
}
function scanExprEnd(src, open) {
  let depth = 0;
  let i = open;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "'" || ch === '"') {
      i = skipQuoted(src, i);
      continue;
    }
    if (ch === "`") {
      i = skipTemplate(src, i);
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i;
    i++;
  }
  return -1;
}
function skipQuoted(src, i) {
  const q = src[i];
  let j = i + 1;
  while (j < src.length) {
    if (src[j] === "\\") {
      j += 2;
      continue;
    }
    if (src[j] === q) return j + 1;
    j++;
  }
  return j;
}
function skipTemplate(src, i) {
  let j = i + 1;
  while (j < src.length) {
    const ch = src[j];
    if (ch === "\\") {
      j += 2;
      continue;
    }
    if (ch === "`") return j + 1;
    if (ch === "$" && src[j + 1] === "{") {
      const end = scanExprEnd(src, j + 1);
      j = end < 0 ? src.length : end + 1;
      continue;
    }
    j++;
  }
  return j;
}
function skipLiteral(src, i) {
  const q = src[i];
  if (q === '"' || q === "'") return skipQuoted(src, i);
  if (q === "`") return skipTemplate(src, i);
  if (q !== "/") return null;
  if (src[i + 1] === "/" || src[i + 1] === "*") return null;
  let b = i - 1;
  while (b >= 0 && /\s/.test(src[b])) b--;
  if (b >= 0) {
    if (!"(,=:[!&|?{};+-*%~^".includes(src[b])) {
      const word = /(\w+)$/.exec(src.slice(0, b + 1))?.[1] ?? "";
      if (!["return", "typeof", "case", "in", "of", "new", "delete", "void", "do", "else", "instanceof", "yield", "await"].includes(word)) return null;
    }
  }
  let j = i + 1;
  let inClass = false;
  while (j < src.length) {
    const c = src[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === "\n") return null;
    if (inClass) {
      if (c === "]") inClass = false;
    } else if (c === "[") inClass = true;
    else if (c === "/") {
      j++;
      break;
    }
    j++;
  }
  if (j > src.length) return null;
  while (j < src.length && /[dgimsuvy]/.test(src[j])) j++;
  return j;
}
function stripComments(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const lit = skipLiteral(src, i);
    if (lit !== null) {
      out += src.slice(i, lit);
      i = lit;
      continue;
    }
    if (src.startsWith("//", i)) {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (src.startsWith("/*", i)) {
      i += 2;
      while (i < src.length && !src.startsWith("*/", i)) i++;
      i = Math.min(i + 2, src.length);
      continue;
    }
    if (src.startsWith("<!--", i)) {
      i += 4;
      while (i < src.length && !src.startsWith("-->", i)) i++;
      i = Math.min(i + 3, src.length);
      continue;
    }
    out += src[i++];
  }
  return out;
}
function stripGuardedBranches(src) {
  const GUARD = /typeof\s+(?:window|document|navigator|location|localStorage|sessionStorage)\s*(!==|===)\s*["']undefined["']/y;
  const ws = (i2) => {
    while (i2 < src.length && /\s/.test(src[i2])) i2++;
    return i2;
  };
  const ternaryColon = (q) => {
    let depth = 0;
    let i2 = q + 1;
    while (i2 < src.length) {
      const c = src[i2];
      const lit = skipLiteral(src, i2);
      if (lit !== null) {
        i2 = lit;
        continue;
      }
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") {
        depth--;
        if (depth < 0) return -1;
      } else if (depth === 0 && c === ":") return i2;
      else if (depth === 0 && c === "?") {
        const inner = ternaryColon(i2);
        if (inner < 0) return -1;
        i2 = inner + 1;
        continue;
      }
      i2++;
    }
    return -1;
  };
  const exprEnd = (i2) => {
    let depth = 0;
    while (i2 < src.length) {
      const c = src[i2];
      const lit = skipLiteral(src, i2);
      if (lit !== null) {
        i2 = lit;
        continue;
      }
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") {
        if (depth === 0) return i2;
        depth--;
      } else if (depth === 0 && (c === "," || c === ";")) return i2;
      else if (depth === 0 && c === "?") {
        const inner = ternaryColon(i2);
        if (inner < 0) return src.length;
        i2 = inner + 1;
        continue;
      }
      i2++;
    }
    return src.length;
  };
  const braceEnd = (b) => {
    let depth = 0;
    let i2 = b;
    while (i2 < src.length) {
      const c = src[i2];
      const lit = skipLiteral(src, i2);
      if (lit !== null) {
        i2 = lit;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) return i2;
      }
      i2++;
    }
    return src.length;
  };
  const stmtEnd = (i2) => {
    let depth = 0;
    while (i2 < src.length) {
      const c = src[i2];
      const lit = skipLiteral(src, i2);
      if (lit !== null) {
        i2 = lit;
        continue;
      }
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") {
        if (depth === 0) return i2;
        depth--;
      } else if (depth === 0 && (c === ";" || c === "\n")) return i2;
      i2++;
    }
    return src.length;
  };
  const isIfGuard = (src2, at) => {
    let b = at - 1;
    while (b >= 0 && /\s/.test(src2[b])) b--;
    if (b < 0 || src2[b] !== "(") return false;
    b--;
    while (b >= 0 && /\s/.test(src2[b])) b--;
    return b >= 1 && src2[b] === "f" && src2[b - 1] === "i" && (b < 2 || !/[\w$]/.test(src2[b - 2]));
  };
  const blanks = [];
  let i = 0;
  while (i < src.length) {
    const lit = skipLiteral(src, i);
    if (lit !== null) {
      i = lit;
      continue;
    }
    GUARD.lastIndex = i;
    const m = GUARD.exec(src);
    if (!m) {
      i++;
      continue;
    }
    const browserAfter = m[1] === "!==";
    const j = ws(i + m[0].length);
    const two = src.slice(j, j + 2);
    if (two === "&&" && browserAfter) {
      blanks.push([j + 2, exprEnd(j + 2)]);
    } else if (two === "||" && !browserAfter) {
      blanks.push([j + 2, exprEnd(j + 2)]);
    } else if (src[j] === "?") {
      const colon = ternaryColon(j);
      if (colon < 0) {
        if (browserAfter) blanks.push([j + 1, src.length]);
      } else if (browserAfter) {
        blanks.push([j + 1, colon]);
      } else {
        blanks.push([colon + 1, exprEnd(colon + 1)]);
      }
    } else if (src[j] === ")" && isIfGuard(src, i)) {
      let bodyEnd;
      const k = ws(j + 1);
      if (src[k] === "{") {
        bodyEnd = braceEnd(k);
        if (browserAfter) blanks.push([k + 1, bodyEnd]);
      } else {
        bodyEnd = stmtEnd(k);
        if (browserAfter) blanks.push([k, bodyEnd]);
      }
      const after = ws(bodyEnd + 1);
      if (src.startsWith("else", after)) {
        const e = ws(after + 4);
        if (src[e] === "{") {
          const close = braceEnd(e);
          if (!browserAfter) blanks.push([e + 1, close]);
        } else {
          const stop = stmtEnd(e);
          if (!browserAfter) blanks.push([e, stop]);
        }
      }
    }
    i = j;
  }
  if (blanks.length === 0) return src;
  const out = [...src];
  for (const [a, b] of blanks) {
    for (let k = a; k < b && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
  }
  return out.join("");
}
function scriptOf(source) {
  return source.match(COMPONENT_RE)?.[1] ?? null;
}
async function loadConfig(root) {
  const file = path3.join(root, "rosespan.config.js");
  if (!fs4.existsSync(file)) return { plugins: [], i18n: {} };
  const mod = await import(pathToFileURL(file).href + `?t=${Date.now()}`);
  return {
    plugins: mod.default ?? [],
    i18n: mod.i18n ?? {},
    pwa: mod.pwa ?? void 0
  };
}
async function loadPlugins(root) {
  return (await loadConfig(root)).plugins;
}
function resolveRoseImports(script, fromFile, registry) {
  const imports = [];
  const resolve2 = (spec, at) => {
    const abs = path3.resolve(path3.dirname(fromFile), spec);
    const hit = registry.get(abs);
    if (!hit) {
      throw new RoseError(
        "E-IMPORT",
        `${path3.basename(fromFile)}: cannot import '${spec}' - no .rose file at ${abs}. A component lives under src/components/ (or src/pages/) and is imported by relative path.`,
        {
          file: fromFile,
          line: lineOf(script, at),
          hint: `create ${abs} (a .rose component) or fix the import path - a .rose import resolves to a file, never to a package`
        }
      );
    }
    return hit;
  };
  let rewritten = script.replace(/import\s+(\w+)\s+from\s*(['"])([^'"]+\.rose)\2/g, (whole, name, q, spec, at) => {
    const hit = resolve2(spec, at);
    imports.push({ name, specifier: spec, index: hit.index });
    return `import { render as ${name} } from ${q}__rose_${hit.index}__${q}`;
  });
  rewritten = rewritten.replace(/import\s*(\{[^}]*\})\s+from\s*(['"])([^'"]+\.rose)\2/g, (whole, clause, q, spec, at) => {
    const hit = resolve2(spec, at);
    const alias = /\bas\s+(\w+)/.exec(clause)?.[1] ?? "render";
    imports.push({ name: alias, specifier: spec, index: hit.index });
    return `import ${clause} from ${q}__rose_${hit.index}__${q}`;
  });
  return { script: rewritten, imports };
}
function rewriteRoseImports(script, kind) {
  return script.replace(/from\s*(['"])__rose_(\d+)__\1/g, (_, q, n) => `from ${q}./comp-${n}.${kind}.js${q}`);
}
var NODE_ONLY_SPEC = /^(?:node:|(?:fs|path|os|crypto|http|https|net|tls|stream|child_process|worker_threads|dns|cluster|better-sqlite3|sqlite3|pg|mysql2|mongodb|redis|ioredis)$)/;
function nodeOnlyImports(importStmts) {
  const out = [];
  for (const m of importStmts.matchAll(/import\s+(type\s+)?[\s\S]*?from\s*['"]([^'"]+)['"]/g)) {
    if (m[1]) continue;
    if (NODE_ONLY_SPEC.test(m[2])) out.push(m[2]);
  }
  return out;
}
function wireEventBindings(template, actionNames, filePath2 = "<template>") {
  const bindings = [];
  let out = "";
  let rest = template;
  const TARGET_MODS = { window: "w", document: "d" };
  const MOD_PRE = {
    preventDefault: () => "e.preventDefault()",
    stopPropagation: () => "e.stopPropagation()",
    self: (p) => `const __self = e.target.closest && e.target.closest('[data-${p}-' + e.type + ']'); if (__self && e.target !== __self) return;`
  };
  const MOD_POST = {
    once: (p) => `const __o = e.target && e.target.closest ? e.target.closest('[data-${p}-' + e.type + ']') : null; if (__o) __o.removeAttribute('data-${p}-' + e.type);`
  };
  const KNOWN_MODS = [...Object.keys(MOD_PRE), ...Object.keys(MOD_POST), ...Object.keys(TARGET_MODS)];
  for (; ; ) {
    const m = /\bon:(\w+)((?:\|\w+)*)\s*=\s*\{/.exec(rest);
    if (!m) {
      out += rest;
      break;
    }
    const mods = m[2] ? m[2].slice(1).split("|") : [];
    const targets = mods.filter((mod) => TARGET_MODS[mod]);
    if (targets.length > 1) {
      throw new RoseError(
        "E-TEMPLATE",
        `${filePath2}: on:${m[1]} carries both |${targets.join(" and |")}`,
        { hint: "a handler binds to one target - the element (default), |window or |document" }
      );
    }
    const prefix = targets.length ? "on" + TARGET_MODS[targets[0]] : "on";
    for (const mod of mods) {
      if (!KNOWN_MODS.includes(mod)) {
        throw new RoseError(
          "E-TEMPLATE",
          `${filePath2}: unknown event modifier |${mod}`,
          { hint: `the supported modifiers are ${KNOWN_MODS.map((k) => "|" + k).join(" ")} - capture/passive are listener options a delegated listener cannot carry per element; anything else belongs inside the handler body` }
        );
      }
    }
    out += rest.slice(0, m.index);
    let i = m.index + m[0].length;
    let depth = 1;
    while (i < rest.length) {
      const ch = rest[i];
      if (ch === '"' || ch === "'") {
        i = skipQuoted(rest, i);
        continue;
      }
      if (ch === "`") {
        i = skipTemplate(rest, i);
        continue;
      }
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) break;
      }
      i++;
    }
    const expr = rest.slice(m.index + m[0].length, i).trim();
    const wrap = (body) => {
      if (!mods.length) return body;
      const pre = mods.filter((mod) => MOD_PRE[mod]).map((mod) => MOD_PRE[mod](prefix));
      const post = mods.filter((mod) => MOD_POST[mod]).map((mod) => MOD_POST[mod](prefix));
      return `(e) => {${pre.length ? " " + pre.join("; ") + ";" : ""} (${body})(e);${post.length ? " " + post.join("; ") + ";" : ""} }`;
    };
    if (mods.length && actionNames.has(expr)) {
      throw new RoseError(
        "E-TEMPLATE",
        `${filePath2}: event modifiers are not supported on the server action ${expr}`,
        { hint: "$action already preventDefaults - drop the modifiers, or bind a local handler that calls $action" }
      );
    }
    if (mods.length) {
      const name = `__h${bindings.length}`;
      out += `data-${prefix}-${m[1]}="${name}"`;
      bindings.push({ event: m[1], fn: `${name}: ${wrap(expr)}` });
    } else if (actionNames.has(expr)) {
      out += `data-on-${m[1]}="$action:${expr}"`;
    } else if (/^\w+$/.test(expr)) {
      out += `data-on-${m[1]}="${expr}"`;
      bindings.push({ event: m[1], fn: expr });
    } else {
      const name = `__h${bindings.length}`;
      out += `data-on-${m[1]}="${name}"`;
      bindings.push({ event: m[1], fn: `${name}: ${expr}` });
    }
    rest = rest.slice(i + 1);
  }
  return { template: out, bindings };
}
function scanSlotDecls(filePath2) {
  let src;
  try {
    src = fs4.readFileSync(filePath2, "utf-8");
  } catch {
    return [];
  }
  const noScript = src.replace(COMPONENT_RE, "");
  const noBlocks = noScript.replace(STYLE_RE, "");
  const tpl = noBlocks.match(TEMPLATE_RE)?.[1] ?? noBlocks.replace(HEAD_RE, "").trim();
  const out = [];
  for (const m of tpl.matchAll(/<slot\s+([^>]*?)\/?>/g)) {
    const name = /\bname\s*=\s*["'](\w+)["']/.exec(m[1]);
    if (!name) continue;
    const props = [...m[1].matchAll(/\b(\w+)\s*=\s*\{/g)].map((x) => x[1]).filter((n) => n !== "name");
    out.push({ name: name[1], props });
  }
  return out;
}
function hoistImports(script) {
  const imports = [];
  const rest = [];
  let buf = null;
  let depth = 0;
  const done = (line) => depth <= 0 && /from\s*['"][^'"]+['"]\s*;?\s*$/.test(line);
  for (const line of script.split("\n")) {
    if (buf) {
      buf.push(line);
      for (const ch of line) {
        if (ch === "{" || ch === "(") depth++;
        else if (ch === "}" || ch === ")") depth--;
      }
      if (done(line)) {
        imports.push(buf.join("\n"));
        buf = null;
      }
      continue;
    }
    if (/^\s*import\b/.test(line)) {
      buf = [line];
      depth = 0;
      for (const ch of line) {
        if (ch === "{" || ch === "(") depth++;
        else if (ch === "}" || ch === ")") depth--;
      }
      if (done(line)) {
        imports.push(line);
        buf = null;
      }
      continue;
    }
    rest.push(line);
  }
  if (buf) imports.push(buf.join("\n"));
  return { imports: imports.join("\n"), rest: rest.join("\n") };
}
var __compileMemo = /* @__PURE__ */ new Map();
var __memoCap = 2e3;
var __regKeyCache = /* @__PURE__ */ new WeakMap();
var __pluginFpCache = /* @__PURE__ */ new WeakMap();
function registryKey(registry) {
  let k = __regKeyCache.get(registry);
  if (k === void 0) {
    const reg = [];
    for (const [p, e] of registry) reg.push(`${p}#${e.index}:${e.scopeKey}:${e.slots.join("|")}`);
    k = reg.join(";");
    __regKeyCache.set(registry, k);
  }
  return k;
}
function pluginFingerprint(plugins) {
  let fp = __pluginFpCache.get(plugins);
  if (fp === void 0) {
    const parts = [];
    for (const p of plugins) {
      if (!p.transform) continue;
      let src;
      try {
        src = String(p.transform);
      } catch {
        src = "opaque";
      }
      parts.push(`${p.name}${__fnv1a(src)}`);
    }
    fp = parts.join("");
    __pluginFpCache.set(plugins, fp);
  }
  return fp;
}
function compileMemoKey(filePath2, scopeKey, isApi, registry, plugins) {
  let st;
  try {
    st = fs4.statSync(filePath2);
  } catch {
    return null;
  }
  return [filePath2, String(st.mtimeMs), String(st.size), scopeKey, isApi ? "1" : "0", registryKey(registry), pluginFingerprint(plugins)].join("\0");
}
var __compilerStamp = (() => {
  try {
    return String(fs4.statSync(fileURLToPath(import.meta.url)).mtimeMs);
  } catch {
    return "noid";
  }
})();
var __diskCacheDir = (() => {
  try {
    const dir = path3.join(os.tmpdir(), "rosespan-compile-cache");
    fs4.mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return null;
  }
})();
var __diskWrites = 0;
function __fnv1a(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
function __diskFile(key) {
  return path3.join(__diskCacheDir, __fnv1a(key + "|" + __compilerStamp) + ".json");
}
function __diskGet(key) {
  if (!__diskCacheDir || process.env.ROSESPAN_NO_DISK_CACHE === "1") return null;
  try {
    const obj = JSON.parse(fs4.readFileSync(__diskFile(key), "utf-8"));
    if (obj && typeof obj === "object" && typeof obj.ssr === "string") return obj;
  } catch {
  }
  return null;
}
function __diskSet(key, result) {
  if (!__diskCacheDir || process.env.ROSESPAN_NO_DISK_CACHE === "1") return;
  const file = __diskFile(key);
  const payload = JSON.stringify(result);
  void fs4.promises.writeFile(file, payload).catch(() => {
    fs4.promises.mkdir(__diskCacheDir, { recursive: true }).then(() => fs4.promises.writeFile(file, payload)).catch(() => {
    });
  });
  try {
    if ((__diskWrites++ & 511) === 0) {
      const entries = fs4.readdirSync(__diskCacheDir);
      if (entries.length > 5e3) {
        for (const e of entries) {
          try {
            fs4.unlinkSync(path3.join(__diskCacheDir, e));
          } catch {
          }
        }
      }
    }
  } catch {
  }
}
async function compileComponentMemo(filePath2, publicDir, scopeKey, isApi, plugins, registry) {
  const key = compileMemoKey(filePath2, scopeKey, isApi, registry, plugins);
  if (key) {
    const hit = __compileMemo.get(key);
    if (hit) return { ...hit };
    const disk = __diskGet(key);
    if (disk) return disk;
  }
  const result = await compileComponent(filePath2, publicDir, scopeKey, isApi, plugins, registry);
  if (key) {
    if (__compileMemo.size >= __memoCap) {
      const oldest = __compileMemo.keys().next().value;
      if (oldest !== void 0) __compileMemo.delete(oldest);
    }
    __compileMemo.set(key, result);
    __diskSet(key, result);
  }
  return result;
}
async function compileComponent(filePath2, publicDir, scopeKey, isApi = false, plugins = [], registry = /* @__PURE__ */ new Map()) {
  let source = await fs4.promises.readFile(filePath2, "utf-8");
  for (const p of plugins) {
    if (!p.transform) continue;
    try {
      source = await p.transform(source, filePath2);
    } catch (err) {
      throw new RoseError(
        "E-PLUGIN",
        `plugin ${p.name} failed on ${path3.basename(filePath2)}: ${err instanceof Error ? err.message : String(err)}`,
        { file: filePath2, hint: "the error above came from inside the plugin - fix its transform() (or remove the plugin from rosespan.config.js)" }
      );
    }
  }
  if (isApi) {
    const scriptMatch2 = source.match(COMPONENT_RE);
    const rawScript2 = scriptMatch2?.[1] ?? "";
    const apiMethods = [...rawScript2.matchAll(/(?:^|\n)\s*export\s+(?:async\s+)?function\s+(\w+)\s*\(/g)].map((m) => m[1]).filter((name) => HTTP_METHODS.has(name));
    const usesContext2 = /getContext\s*\(/.test(rawScript2);
    const usesStore2 = /\$store\s*\(/.test(rawScript2);
    const hasPrerender = !usesContext2 && /(?:^|\n)\s*export\s+(?:const|let|var)\s+prerender\s*=\s*true\b/.test(rawScript2);
    const hoisted = hoistImports(resolveRoseImports(rawScript2, filePath2, registry).script);
    const ownRuntimeImports = new Set(
      [...rawScript2.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]\.\/runtime\.js['"]/g)].flatMap((m) => m[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean))
    );
    const helpers = API_RUNTIME_HELPERS.filter((n) => !ownRuntimeImports.has(n));
    const runtimeImport = helpers.length > 0 ? `import { ${helpers.join(", ")} } from './runtime.js';
` : "";
    return {
      ssr: "",
      client: "",
      stateKeys: [],
      actionNames: [],
      guardName: null,
      style: "",
      hasParams: false,
      api: `${runtimeImport}${rewriteRoseImports(`${hoisted.imports}
${hoisted.rest}`, "ssr").trim()}`,
      apiMethods,
      hasPrerender,
      usesContext: usesContext2,
      usesStore: usesStore2
    };
  }
  const sourceNoScript = source.replace(COMPONENT_RE, "");
  const sourceNoHead = sourceNoScript.replace(HEAD_RE, "");
  const styleMatch = sourceNoHead.match(STYLE_RE);
  const scopedStyle = styleMatch?.[1] ? scopeCss(styleMatch[1], scopeKey) : "";
  const sourceNoBlocks = sourceNoHead.replace(STYLE_RE, "");
  const scriptMatch = source.match(COMPONENT_RE);
  const roseResolved = resolveRoseImports(scriptMatch?.[1] ?? "", filePath2, registry);
  const rawScript = roseResolved.script;
  const usesRoseSpanAuth = rawScript.includes("__rosespanAuth");
  const roseImports = roseResolved.imports;
  const { imports: importStmts, rest: scriptNoImports } = hoistImports(rawScript);
  if (path3.basename(filePath2) !== "_middleware.rose") {
    for (const spec of nodeOnlyImports(importStmts)) {
      const at = importStmts.indexOf(spec);
      throw new RoseError(
        "E-NODE-ONLY",
        `${filePath2}: cannot import '${spec}' in a page or component - it never reaches the browser. This module's script ships to the client (its $data bodies included), so move the import to src/pages/_middleware.rose or a pages/api/*.rose handler: those are server-only, and the rows travel to the page through getContext() / $data.`,
        {
          file: filePath2,
          line: at >= 0 ? lineOf(importStmts, at) : void 0,
          hint: `'${spec}' is a server-only module: import it inside src/pages/_middleware.rose (or a pages/api/*.rose handler) instead - a page/component script ships to the browser`
        }
      );
    }
  }
  const isComponent = registry.get(filePath2)?.scopeKey.startsWith("components/") ?? false;
  if (isComponent && /\$data\s*\(/.test(rawScript)) {
    throw new RoseError(
      "E-EXPORT",
      `${filePath2}: $data() is not allowed in a component - an imported component renders synchronously inside its parent. Fetch in the page's $data (or pages/_middleware.rose) and pass the value down as a prop: <Card user={user()}>.`,
      { file: filePath2, hint: "move the fetch to the page (or the middleware) and pass the value down as a prop" }
    );
  }
  const usesContext = /getContext\s*\(/.test(rawScript) || /\$store\s*\(/.test(rawScript) || /\$query\s*\(/.test(rawScript);
  const usesStore = /\$store\s*\(/.test(rawScript);
  const hasParams = /(?:^|\n)\s*export\s+(?:(?:const|let|var)\s+|(?:async\s+)?function\s+)params\b/.test(rawScript);
  const revalidateMatch = rawScript.match(/(?:^|\n)\s*export\s+(?:const|let|var)\s+revalidate\s*=\s*(\d+)\s*;?/);
  const revalidate = revalidateMatch ? Number(revalidateMatch[1]) : void 0;
  const cacheMatch = rawScript.match(/(?:^|\n)\s*export\s+(?:const|let|var)\s+cache\s*=\s*(\d+)\s*;?/);
  const cacheSeconds = cacheMatch ? Number(cacheMatch[1]) : void 0;
  const prefetchMatch = rawScript.match(/(?:^|\n)\s*export\s+(?:const|let|var)\s+prefetch\s*=\s*['"`](\w+)['"`]\s*;?/);
  const prefetch = prefetchMatch ? prefetchMatch[1] : void 0;
  if (prefetch && !["off", "hover", "viewport", "all"].includes(prefetch)) {
    throw new RoseError(
      "E-EXPORT",
      `${filePath2}: export const prefetch must be 'off', 'hover', 'viewport' or 'all'`,
      { file: filePath2, line: lineAt(rawScript, prefetchMatch), hint: "prefetch is the app-global link strategy, declared once in the root _layout.rose: 'off' | 'hover' (default) | 'viewport' | 'all'" }
    );
  }
  const lazyMatch = rawScript.match(/(?:^|\n)\s*export\s+(?:const|let|var)\s+lazyHydration\s*=\s*(true|false)\s*;?/);
  const lazyHydration = lazyMatch ? lazyMatch[1] === "true" : void 0;
  if (lazyMatch && !lazyHydration) {
    throw new RoseError(
      "E-EXPORT",
      `${filePath2}: export const lazyHydration must be true (or be absent - hydration is eager by default)`,
      { file: filePath2, line: lineAt(rawScript, lazyMatch), hint: "omit the export entirely, or set it to exactly true - lazy hydration is opt-in per app, declared once in the root _layout.rose" }
    );
  }
  const vitalsMatch = rawScript.match(/(?:^|\n)\s*export\s+(?:const|let|var)\s+vitals\s*=\s*([^;\n]+)\s*;?/);
  const vitals = vitalsMatch ? vitalsMatch[1].trim() === "true" : void 0;
  if (vitalsMatch && !vitals) {
    throw new RoseError(
      "E-EXPORT",
      `${filePath2}: export const vitals must be true (or be absent - the hook ships only when an app asks for it)`,
      { file: filePath2, line: lineAt(rawScript, vitalsMatch), hint: "omit the export entirely, or set it to exactly true - the web-vitals hook is opt-in per app" }
    );
  }
  const bundleMatch = rawScript.match(/(?:^|\n)\s*export\s+(?:const|let|var)\s+bundle\s*=\s*['"`](\w+)['"`]\s*;?/);
  const bundle = bundleMatch ? bundleMatch[1] : void 0;
  if (bundle && !["inline", "split"].includes(bundle)) {
    throw new RoseError(
      "E-EXPORT",
      `${filePath2}: export const bundle must be 'inline' or 'split'`,
      { file: filePath2, line: lineAt(rawScript, bundleMatch), hint: "'inline' (default) is the single-document mode; 'split' is mode B for large apps - route-level chunks, loaded on demand" }
    );
  }
  const csrMatch = rawScript.match(/(?:^|\n)\s*export\s+(?:const|let|var)\s+csr\s*=\s*(true|false)\s*;?/);
  const csr = csrMatch ? csrMatch[1] !== "false" : void 0;
  const shellMatch = rawScript.match(/(?:^|\n)\s*export\s+(?:const|let|var)\s+shell\s*=\s*(true|false)\s*;?/);
  const shell = shellMatch ? shellMatch[1] !== "false" : void 0;
  const bufferMatch = rawScript.match(/(?:^|\n)\s*export\s+(?:const|let|var)\s+buffer\s*=\s*(true|false)\s*;?/);
  const buffer = bufferMatch ? bufferMatch[1] !== "false" : void 0;
  const controlSignal = /\b(?:redirect|notFound)\s*\(/.test(rawScript) || void 0;
  if (csr === false) {
    const dead = /\son:[a-z]+\s*=/.exec(source) ?? /\b(?:onMount|onCleanup|refresh)\s*\(/.exec(rawScript);
    if (dead) {
      const deadSrc = dead === (/\son:[a-z]+\s*=/.exec(source) ?? void 0) ? source : rawScript;
      throw new RoseError(
        "E-EXPORT",
        `${filePath2}: csr = false cannot ship ${dead[0].trim()} - event wiring, onMount/onCleanup and refresh() all need the client bundle. (Forms still work without JS: a native POST runs the server action.)`,
        {
          file: filePath2,
          line: lineAt(deadSrc, dead),
          hint: 'drop csr = false (let the compiler decide), or remove the client-only code - a native <form method="POST"> server action works without the bundle'
        }
      );
    }
  }
  let headers;
  const headersLiteral = extractObjectLiteral(rawScript, "headers");
  if (headersLiteral) {
    let value;
    try {
      value = new Function(`return ${headersLiteral}`)();
    } catch {
      throw new RoseError(
        "E-EXPORT",
        `${filePath2}: export const headers must be an object literal`,
        { file: filePath2, hint: "write it as one literal: export const headers = { 'x-robots-tag': 'noindex' }" }
      );
    }
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.values(value).some((v) => typeof v !== "string")) {
      throw new RoseError(
        "E-EXPORT",
        `${filePath2}: export const headers must be a flat map of string -> string`,
        { file: filePath2, hint: "every value must be a string literal (a number or an array fails here instead of shipping verbatim)" }
      );
    }
    headers = value;
  }
  let cspNonce;
  const cspLiteral = extractObjectLiteral(rawScript, "csp");
  if (cspLiteral) {
    let value;
    try {
      value = new Function(`return ${cspLiteral}`)();
    } catch {
      throw new RoseError(
        "E-EXPORT",
        `${filePath2}: export const csp must be an object literal`,
        { file: filePath2, hint: "write it as one literal: export const csp = { nonce: true }" }
      );
    }
    const nonce = value?.nonce;
    if (nonce !== void 0 && typeof nonce !== "boolean") {
      throw new RoseError(
        "E-EXPORT",
        `${filePath2}: csp.nonce must be a boolean`,
        { file: filePath2, hint: "csp.nonce is a switch: true (per-request nonce, the route becomes dynamic) or absent (the default hashed policy)" }
      );
    }
    cspNonce = nonce === true;
  }
  const { clean: scriptNoExports, exports: exportStmts, actions, props, guard } = extractExports(scriptNoImports);
  const script = scriptNoExports;
  const actionNames = new Set(actions.map((a) => a.name));
  const clientReasons = [];
  if (/\son:[a-z]+\s*=/.test(source)) clientReasons.push("event wiring (on:)");
  if (/<form[^>]*\son:[a-z]+\s*=/i.test(source) || /\$action:|data-on-/.test(source)) {
    clientReasons.push("a form bound to a client dispatch ($action)");
  }
  const lifecycle = rawScript.match(/\b(?:onMount|onCleanup|refresh|adopt)\s*\(|(?:\$action|\$effect)\s*\(/);
  if (lifecycle) clientReasons.push(`${lifecycle[0].replace(/\s*\($/, "")}()`);
  if (source.includes("{#defer")) clientReasons.push("{#defer} progressive content");
  if (source.includes("{#await")) clientReasons.push("{#await} async block");
  const needsClient = clientReasons.length > 0;
  const jsWarnings = [];
  if (!needsClient) {
    const codeOnly = stripComments(source);
    const scriptCodeOnly = stripComments(rawScript);
    const scriptScannable = stripGuardedBranches(scriptCodeOnly);
    if (/\son[a-z]+\s*=\s*["'][^"']*["']/i.test(codeOnly)) {
      jsWarnings.push('an inline on* attribute (e.g. onclick="...") - it cannot fire without the bundle; use on:click or set csr = true');
    }
    if (/javascript:/i.test(codeOnly)) {
      jsWarnings.push("a javascript: URL - it needs the bundle to run; link to a real route");
    }
    if (/\b(?:eval|new Function)\s*\(/.test(scriptScannable)) {
      jsWarnings.push("eval()/new Function() - client code the predicate cannot see");
    }
    if (/\b(?:document|window|localStorage|sessionStorage)\s*\.|\b(?:add|remove)EventListener\s*\(|\brequestAnimationFrame\s*\(|\bMutationObserver\b|\bnavigator\s*\.|\blocation\s*\.\s*(?:href|assign|replace|reload|pathname|search|hash|origin)\b|\b(?:setTimeout|setInterval)\s*\(/.test(scriptScannable)) {
      jsWarnings.push("browser-only code (document./window./addEventListener/a timer/...) - a JS-free document never ships this script to the browser, so it throws on the server or runs there and never reaches the client; if the route needs the browser, set csr = true");
    }
  }
  const templateMatch = sourceNoBlocks.match(TEMPLATE_RE);
  const headContent = sourceNoScript.match(HEAD_RE)?.[1] ?? "";
  const rawTemplate = templateMatch ? templateMatch[1] : sourceNoBlocks.replace(COMPONENT_RE, "").trim();
  const template = scopedStyle ? injectScopeAttr(inlineImages(rawTemplate, publicDir), scopeKey) : inlineImages(rawTemplate, publicDir);
  const decls = extractDecls(script);
  const stateDecls = decls.filter((d) => d.kind === "state" || d.kind === "kv" || d.kind === "persist");
  const derivedNames = decls.filter((d) => d.kind === "derived").map((d) => d.name);
  const callifyNames = [...stateDecls.map((s) => s.name), ...derivedNames];
  const setterNames = /* @__PURE__ */ new Map();
  stateDecls.forEach((s) => setterNames.set(s.name, `set${capitalize(s.name)}`));
  const declCode = (d) => {
    const key = isComponent ? `${scopeKey}:${d.name}` : d.name;
    if (d.kind === "state") {
      return `const [${d.name}, ${setterNames.get(d.name)}] = state(${JSON.stringify(key)}, ${d.expr});`;
    }
    const isFn = d.expr.includes("=>") || d.expr.startsWith("function");
    const fn = isFn ? d.expr : `() => (${d.expr})`;
    if (d.kind === "persist") {
      return `const [${d.name}, ${setterNames.get(d.name)}] = persistState(${JSON.stringify(key)}, ${d.expr});`;
    }
    if (d.kind === "derived") {
      return `const ${d.name} = () => (${callifyStateReads(d.expr, callifyNames)});`;
    }
    if (d.kind === "kv") {
      const mTtl = /^(.*)\s*,\s*(\d+)\s*$/s.exec(d.expr);
      const fnExpr = mTtl ? mTtl[1] : d.expr;
      const ttl = mTtl ? mTtl[2] : "300";
      return `const __seeded_${d.name} = isSeeded(${JSON.stringify(key)});
const [${d.name}, set${capitalize(d.name)}] = state(${JSON.stringify(key)}, null);
if (!__seeded_${d.name}) { const __v_${d.name} = await globalThis.__rosespanKvApi.kvMemo(${JSON.stringify("__kvh:" + scopeKey + ":" + d.name)}, ${fnExpr}, ${ttl}); set${capitalize(d.name)}(__v_${d.name}); markSeeded(${JSON.stringify(key)}); }`;
    }
    return `const __seeded_${d.name} = isSeeded(${JSON.stringify(key)});
const [${d.name}, set${capitalize(d.name)}] = state(${JSON.stringify(key)}, null);
if (!__seeded_${d.name}) { const __v_${d.name} = await $data(${fn}); set${capitalize(d.name)}(__v_${d.name}); markSeeded(${JSON.stringify(key)}); }`;
  };
  const nestedDecls = [];
  let spliced = "";
  let pos = 0;
  decls.forEach((d, i) => {
    const top = braceDepthAt(script, d.start) === 0;
    if (!top) {
      if (d.kind === "derived") {
        throw new Error(
          `${filePath2}: $derived must be a top-level declaration - inside a function body a plain const arrow already does this natively`
        );
      }
      nestedDecls.push(d);
    }
    spliced += script.slice(pos, d.start) + (top ? `'__rvdecl${i}__';` : "");
    pos = d.end;
  });
  spliced += script.slice(pos);
  let cleanScript = spliced.replace(SETSTATE_RE, (_, key, val) => {
    const trimmedKey = key.trim().replace(/^['"`]|['"`]$/g, "");
    if (derivedNames.includes(trimmedKey)) {
      throw new Error(
        `${filePath2}: $setState('${trimmedKey}', ...) - a $derived value is read-only; make it $state or derive a different expression`
      );
    }
    const setter = setterNames.get(trimmedKey) || `set${capitalize(trimmedKey)}`;
    return `${setter}(${val})`;
  });
  cleanScript = callifyStateReads(cleanScript, callifyNames);
  cleanScript = cleanScript.replace(/'__rvdecl(\d+)__';/g, (_m, i) => declCode(decls[Number(i)]));
  const stateDeclsCode = nestedDecls.filter((d) => d.kind === "state").map(declCode).join("\n");
  const dataDeclsCode = nestedDecls.filter((d) => d.kind === "data").map(declCode).join("\n");
  const templateCalled = callifyTemplateExprs(template, callifyNames);
  const imgDefaulted = templateCalled.replace(/<img\b(?![^>]*?\sloading=)/gi, '<img loading="lazy"').replace(/<img\b(?![^>]*?\sdecoding=)/gi, '<img decoding="async"');
  const wired = wireEventBindings(imgDefaulted, actionNames, filePath2);
  const stateKeys = decls.filter((d) => d.kind !== "derived").map((d) => d.name);
  const bindBindings = [];
  let bindCounter = 0;
  const bindExpanded = wired.template.replace(
    /\sbind:(value|checked|this|open)\s*=\s*\{([\w$]+)(?:\(\))?\}/g,
    (whole, kind, name, offset, str) => {
      if (!stateKeys.includes(name)) {
        throw new Error(
          `${filePath2}: bind:${kind}={${name}} must name a $state declaration` + (stateKeys.length ? ` (state keys here: ${stateKeys.join(", ")})` : " (this file declares no $state)")
        );
      }
      if (kind === "this") return ` data-bind-this="${name}"`;
      const tagStart = str.lastIndexOf("<", offset);
      const tagText = tagStart >= 0 ? str.slice(tagStart, offset) : "";
      if (kind === "value" && /^<select[\s>]/i.test(tagText) && /\smultiple\b/i.test(tagText)) {
        const setterM = setterNames.get(name);
        const hnameM = `__rvbind_${scopeKey.replace(/\W/g, "_")}_${bindCounter++}`;
        bindBindings.push({
          event: "change",
          fn: `${hnameM}: (e) => ${setterM}(Array.from(e.target.selectedOptions, (o) => o.value))`
        });
        return ` data-selmulti={${name}().join(',')} data-on-change="${hnameM}"`;
      }
      if (kind === "open") {
        const setterO = setterNames.get(name);
        const hnameO = `__rvbind_${scopeKey.replace(/\W/g, "_")}_${bindCounter++}`;
        bindBindings.push({ event: "toggle", fn: `${hnameO}: (e) => ${setterO}(e.target.open)` });
        return ` open={${name}()} data-on-toggle="${hnameO}"`;
      }
      const setter = setterNames.get(name);
      const evt = kind === "checked" ? "change" : "input";
      const hname = `__rvbind_${scopeKey.replace(/\W/g, "_")}_${bindCounter++}`;
      bindBindings.push({
        event: evt,
        fn: kind === "checked" ? `${hname}: (e) => ${setter}(e.target.checked)` : `${hname}: (e) => { const t = e.target; const raw = t.type === 'number' || t.type === 'range' ? t.valueAsNumber : t.value; ${setter}(typeof raw === 'number' && Number.isNaN(raw) ? null : raw); }`
      });
      const evtAttr = kind === "checked" ? ` data-on-change="${hname}"` : ` data-on-input="${hname}" data-on-change="${hname}"`;
      return ` ${kind}={${name}()}${evtAttr}`;
    }
  );
  const comps = new Map(roseImports.map((r) => {
    const abs = path3.resolve(path3.dirname(filePath2), r.specifier);
    const hit = registry.get(abs);
    return [r.name, { index: hit.index, slots: hit.slots }];
  }));
  const groupBindings = [];
  let groupCounter = 0;
  const TAG_SCAN_RE = /<([a-zA-Z][^\s>/]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  const groupExpanded = (() => {
    if (!bindExpanded.includes("bind:group")) return bindExpanded;
    let out = "";
    let pos2 = 0;
    let m;
    TAG_SCAN_RE.lastIndex = 0;
    while (m = TAG_SCAN_RE.exec(bindExpanded)) {
      const [whole, tag, attrs, selfClose] = m;
      const gm = /\sbind:group\s*=\s*\{([\w$]+)(?:\(\))?\}/.exec(attrs);
      if (!gm) continue;
      const name = gm[1];
      if (!stateKeys.includes(name)) {
        throw new RoseError(
          "E-TEMPLATE",
          `${filePath2}: bind:group={${name}} must name a $state declaration`,
          { hint: "the group state holds the selected value (radio) or an ARRAY of checked values (checkbox) - declare it: let " + name + ' = $state("")' }
        );
      }
      if (!/\stype\s*=\s*["'](radio|checkbox)["']/.test(attrs)) {
        throw new RoseError(
          "E-TEMPLATE",
          `${filePath2}: bind:group is for radio and checkbox inputs`,
          { hint: '<input type="radio" value="v" bind:group={state}> holds the selected value; type="checkbox" holds an ARRAY of the checked values (declare the state as $state([]))' }
        );
      }
      const isArrayGroup = /\stype\s*=\s*["']checkbox["']/.test(attrs);
      const vm = /\svalue\s*=\s*"([^"]*)"|\svalue\s*=\s*'([^']*)'/.exec(attrs);
      if (!vm || /\{/.test(vm[0])) {
        throw new RoseError(
          "E-TEMPLATE",
          `${filePath2}: a bind:group input needs a static value attribute`,
          { hint: '<input type="radio" value="free" bind:group={plan}> - the value IS what the state receives' }
        );
      }
      if (/\schecked\s*=/.test(attrs)) {
        throw new RoseError(
          "E-TEMPLATE",
          `${filePath2}: a bind:group input cannot also carry checked=`,
          { hint: "the group state alone decides which inputs are checked" }
        );
      }
      const setter = setterNames.get(name);
      const hname = `__rvbg_${scopeKey.replace(/\W/g, "_")}_${groupCounter++}`;
      const groupValue = JSON.stringify(vm[1] ?? vm[2]);
      const checkedExpr = isArrayGroup ? `${name}().includes(${groupValue})` : `${name}() === ${groupValue}`;
      const handlerBody = isArrayGroup ? `${setter}(e.target.checked ? [...${name}(), ${groupValue}] : ${name}().filter((x) => x !== ${groupValue}))` : `${setter}(e.target.value)`;
      groupBindings.push({ event: "change", fn: `${hname}: (e) => { ${handlerBody}; }` });
      const newAttrs = attrs.replace(gm[0], ` checked={${checkedExpr}} data-on-change="${hname}"`);
      out += bindExpanded.slice(pos2, m.index) + `<${tag}${newAttrs}${selfClose}>`;
      pos2 = m.index + whole.length;
    }
    if (pos2 === 0) return bindExpanded;
    out += bindExpanded.slice(pos2);
    return out;
  })();
  const eventBindings = wired.bindings.concat(bindBindings, groupBindings);
  const useExpanded = groupExpanded.replace(
    /\suse:([\w-]+)(\s*=\s*\{([\s\S]*?)\})?/g,
    (_w, name, hasParam, expr) => hasParam ? ` data-use="${name}" data-use-param={JSON.stringify(${expr})}` : ` data-use="${name}"`
  );
  const classExpanded = expandClassDirectives(useExpanded, filePath2);
  const classMerged = mergeStaticClass(classExpanded);
  const styleExpanded = expandStyleDirectives(classMerged, filePath2);
  const transExpanded = expandTransitionDirectives(styleExpanded, filePath2);
  const animExpanded = expandAnimateDirectives(transExpanded, filePath2);
  const keyExpanded = expandKeyBlocks(animExpanded, filePath2);
  const elseExpanded = expandIfElse(keyExpanded);
  const deferExpanded = expandDeferBlocks(elseExpanded);
  const awaitExpanded = expandAwaitBlocks(deferExpanded.template, filePath2);
  const fbExpanded = expandBoundaryFallbacks(awaitExpanded.template, filePath2);
  const ssrTemplate = rewriteQuotedExprAttrs(fbExpanded.replace(SLOT_NAMED_RE, (_w, attrs, fallback) => {
    const call = `{__slot(${encodeSlotCall(attrs)})}`;
    if (fallback) {
      if (/\{[^{}]*\}/.test(fallback)) {
        throw new RoseError(
          "E-TEMPLATE",
          `${filePath2}: slot fallback content must be static markup`,
          { hint: "a {expr} inside a slot fallback has no reactive scope here - render the dynamic part in the parent and pass it as the slot content" }
        );
      }
      return `{__slot(${encodeSlotCall(attrs)}, ${JSON.stringify(fallback)})}`;
    }
    return call;
  }).replace(SLOT_RE, (_w, fallback) => fallback && fallback.trim() ? `{__slotDefault(${JSON.stringify(fallback)})}` : "{__slot__}"), comps);
  assertKnownDirectives(ssrTemplate, filePath2);
  const compiledTemplate = compileTemplate(ssrTemplate, "h", "__c", null, 0, true, comps);
  let compiledHead = headContent.trim() ? compileHead(headContent) : "";
  if (!isComponent && scopedStyle) {
    const styleId = "rosespan-style-" + scopeKey.replace(/[^a-zA-Z0-9_-]/g, "-");
    const pageStyleBlock = `<style id="${styleId}">${scopedStyle}</style>`;
    compiledHead = (compiledHead ? compiledHead + "\n" : "") + `__hd += ${JSON.stringify(pageStyleBlock)};`;
  }
  const hasNamedSlots = /<slot\s+[^>]*\bname\s*=/.test(template);
  const ssrExports = actions.length > 0 ? `${exportStmts}
${actions.map((a) => a.stmt).join("\n")}` : exportStmts;
  const ssrGuard = guard ? `
${guard}` : "";
  const isMiddleware = path3.basename(filePath2) === "_middleware.rose";
  const bootCode = deferBootCode(deferExpanded.count, deferExpanded.holds) + (awaitExpanded.blocks.length ? "\n" + awaitBootCode(awaitExpanded.blocks) : "");
  const ssr = isMiddleware ? `${RUNTIME_IMPORTS}

${importStmts}

${ssrExports}
${ssrGuard}

${cleanScript}
` : generateSSR(cleanScript + bootCode, compiledTemplate, stateDeclsCode, ssrExports, compiledHead, props, hasNamedSlots, importStmts, isComponent, ssrGuard, actions.length > 0, dataDeclsCode);
  const client = generateClient(cleanScript + bootCode, compiledTemplate, stateDeclsCode, eventBindings, exportStmts, compiledHead, props, hasNamedSlots, importStmts, isComponent, dataDeclsCode);
  return {
    ssr: rewriteRoseImports(ssr, "ssr"),
    client: rewriteRoseImports(client, "client"),
    stateKeys,
    actionNames: [...actionNames],
    guardName: guard ? "beforeAction" : null,
    style: scopedStyle,
    hasParams,
    usesContext,
    usesStore,
    revalidate,
    cache: cacheSeconds,
    csr,
    shell,
    buffer,
    controlSignal,
    prefetch,
    lazyHydration,
    vitals,
    bundle,
    needsClient,
    clientReasons,
    jsWarnings,
    headers,
    cspNonce,
    usesRoseSpanAuth,
    props,
    roseImports,
    isComponent
  };
}
function minifyDecls(block) {
  return block.replace(
    /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^"']+/g,
    (m) => m[0] === '"' || m[0] === "'" ? m : m.replace(/\s+/g, " ").replace(/\s*([:;{},])\s*/g, "$1").trim()
  ).trim();
}
function scopeCss(css, key) {
  const attr = `[data-rosespan-c="${key}"]`;
  const scopeOneSelector = (s) => {
    const t = s.trim();
    if (!t.includes(":global")) return `${attr} ${t}`;
    const stripped = t.replace(/:global\([^()]*\)/g, (m) => m.slice(8, -1)).trim();
    const outside = t.replace(/:global\([^()]*\)/g, "").trim();
    return outside ? `${attr} ${stripped}` : stripped;
  };
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let out = "";
  let prelude = "";
  let i = 0;
  while (i < clean.length) {
    const ch = clean[i];
    if (ch === "{") {
      let depth = 1;
      let j = i + 1;
      while (j < clean.length && depth > 0) {
        if (clean[j] === "{") depth++;
        else if (clean[j] === "}") depth--;
        j++;
      }
      const block = clean.slice(i + 1, j - 1);
      const sel = prelude.trim();
      if (sel.startsWith("@")) {
        out += `${sel}{${/^@(?:-[\w]+-)?keyframes/.test(sel) ? minifyDecls(block) : scopeCss(block, key)}}`;
      } else if (sel) {
        const scoped = sel.split(",").map((s) => scopeOneSelector(s)).join(",");
        out += `${scoped}{${minifyDecls(block)}}`;
      }
      prelude = "";
      i = j;
      continue;
    }
    if (ch !== "}" && ch !== "\n" && ch !== "\r") prelude += ch;
    else if (ch === "}") prelude = "";
    i++;
  }
  return out.trim();
}
function injectScopeAttr(template, key) {
  const attr = ` data-rosespan-c="${key}"`;
  let out = "";
  let depth = 0;
  let i = 0;
  while (i < template.length) {
    const lt = template.indexOf("<", i);
    if (lt === -1) {
      out += template.slice(i);
      break;
    }
    out += template.slice(i, lt);
    let j = lt + 1;
    let quote = "";
    while (j < template.length) {
      const c = template[j];
      if (quote) {
        if (c === quote) quote = "";
      } else if (c === '"' || c === "'") quote = c;
      else if (c === ">") break;
      j++;
    }
    const tagText = template.slice(lt, j + 1);
    const closing = /^<\//.test(tagText);
    const nameMatch = tagText.match(/^<\/?([a-zA-Z][\w-]*)/);
    const selfClosing = /\/>$/.test(tagText) || nameMatch && VOID_TAGS.has(nameMatch[1].toLowerCase());
    if (nameMatch && !closing && depth === 0 && !selfClosing) {
      const injectAt = tagText.endsWith("/>") ? tagText.length - 2 : tagText.length - 1;
      out += tagText.slice(0, injectAt) + attr + tagText.slice(injectAt);
      depth++;
    } else {
      out += tagText;
      if (nameMatch) depth += closing ? -1 : selfClosing ? 0 : 1;
    }
    i = j + 1;
  }
  return out;
}
var VOID_TAGS = /* @__PURE__ */ new Set(["img", "br", "hr", "input", "meta", "link", "source", "wbr"]);
var EXPORT_RE = /^[ \t]*export\s+(?:(const|let|var)|(?:async\s+)?function)\s+(\w+)/gm;
function extractObjectLiteral(script, name) {
  const m = new RegExp(`(?:^|\\n)\\s*export\\s+(?:const|let|var)\\s+${name}\\s*=\\s*`).exec(script);
  if (!m) return null;
  let i = m.index + m[0].length;
  if (script[i] !== "{") return null;
  const start = i;
  let depth = 0;
  for (; i < script.length; i++) {
    const ch = script[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
  }
  return script.slice(start, i);
}
function extractExports(script) {
  const stmts = [];
  const actions = [];
  const props = [];
  const guards = [];
  let out = "";
  let pos = 0;
  let m;
  EXPORT_RE.lastIndex = 0;
  while (m = EXPORT_RE.exec(script)) {
    const kind = m[1];
    const start = m.index + m[0].indexOf("export");
    let i = start + m[0].length - m[0].indexOf("export");
    if (kind) {
      let depth = 0;
      while (i < script.length) {
        const ch = script[i];
        if (ch === "(" || ch === "{" || ch === "[") depth++;
        else if (ch === ")" || ch === "}" || ch === "]") {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        } else if (depth === 0 && ch === ";") {
          i++;
          break;
        } else if (depth === 0 && ch === "\n") {
          const rest = script.slice(i + 1);
          if (!/^\s*[.([{+\-*/?:,=&|]/.test(rest)) {
            i++;
            break;
          }
        }
        i++;
      }
      if (script[i] === ";") i++;
    } else {
      while (i < script.length && script[i] !== "{") i++;
      let depth = 0;
      while (i < script.length) {
        const ch = script[i];
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        }
        i++;
      }
    }
    out += script.slice(pos, start);
    const stmt = script.slice(start, i).trim();
    const asyncFn = stmt.match(/^export\s+async\s+function\s+(\w+)/);
    const anyFn = stmt.match(/^export\s+(?:async\s+)?function\s+(\w+)/);
    if (anyFn?.[1] === "beforeAction") {
      guards.push(stmt);
    } else if (asyncFn) {
      actions.push({ name: asyncFn[1], stmt });
    } else if (kind === "let") {
      const pm = stmt.match(/^export\s+let\s+(\w+)\s*(?:=\s*([\s\S]*?))?\s*;?$/);
      if (pm) props.push({ name: pm[1], def: pm[2]?.trim() ?? null });
      else stmts.push(stmt);
    } else {
      stmts.push(stmt);
    }
    pos = i;
  }
  out += script.slice(pos);
  return { clean: out, exports: stmts.join("\n"), actions, props, guard: guards.join("\n") };
}
var REGEX_PRECEDERS = new Set("(,=:[!&|?{};+-*%<>~^".split(""));
function isRegexStart(src, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  if (j < 0) return true;
  const p = src[j];
  if (REGEX_PRECEDERS.has(p)) return true;
  if (/[A-Za-z0-9_$]/.test(p)) {
    const w = /([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(src.slice(0, j + 1));
    if (!w) return false;
    return ["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else"].includes(w[1]);
  }
  return false;
}
function extractDecls(script) {
  const decls = [];
  DECL_RE.lastIndex = 0;
  let m;
  while (m = DECL_RE.exec(script)) {
    let j = m.index + m[0].length;
    const skipSpace = () => {
      while (j < script.length && /\s/.test(script[j])) j++;
    };
    skipSpace();
    if (script[j] === "<") {
      let depth2 = 0;
      while (j < script.length) {
        const ch = script[j];
        if (ch === "<") depth2++;
        else if (ch === ">" && script[j - 1] !== "=") {
          depth2--;
          if (depth2 === 0) {
            j++;
            break;
          }
        } else if (ch === "=" && script[j + 1] === ">") j++;
        j++;
      }
      skipSpace();
    }
    if (script[j] !== "(") continue;
    const open = j + 1;
    let depth = 1;
    let i = open;
    while (i < script.length && depth > 0) {
      const ch = script[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      i++;
    }
    let end = i;
    const cast = DECL_CAST_RE.exec(script.slice(i));
    if (cast) end = i + cast[0].length;
    if (script[end] === ";") end++;
    decls.push({
      name: m[1],
      kind: m[2],
      expr: script.slice(open, i - 1).trim(),
      start: m.index,
      end
    });
  }
  return decls;
}
function braceDepthAt(src, index) {
  let depth = 0;
  let i = 0;
  while (i < index) {
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      i++;
      while (i < index) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === quote) {
          i++;
          break;
        }
        if (quote === "`" && src[i] === "$" && src[i + 1] === "{") {
          let d = 1;
          i += 2;
          while (i < index && d > 0) {
            if (src[i] === "{") d++;
            else if (src[i] === "}") d--;
            i++;
          }
          continue;
        }
        i++;
      }
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      i = close === -1 ? src.length : close + 2;
      continue;
    }
    if (ch === "/" && isRegexStart(src, i)) {
      i++;
      let inClass = false;
      while (i < index) {
        const c2 = src[i];
        if (c2 === "\\") {
          i += 2;
          continue;
        }
        if (inClass) {
          if (c2 === "]") inClass = false;
          i++;
          continue;
        }
        if (c2 === "[") {
          inClass = true;
          i++;
          continue;
        }
        if (c2 === "/") {
          i++;
          break;
        }
        if (c2 === "\n") break;
        i++;
      }
      while (i < index && /[a-z]/.test(src[i])) i++;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    i++;
  }
  return depth;
}
function autoCall(expr) {
  const e = expr.trim();
  return /^[A-Za-z_$][\w$]*$/.test(e) ? `${e}()` : e;
}
var DEFER_ENABLED = true;
function expandKeyBlocks(template, filePath2) {
  if (!template.includes("{#key")) return template;
  for (let pass = 0; pass < 10; pass++) {
    const OPEN_RE = /\{#key\s+([^}]+)\}/g;
    OPEN_RE.lastIndex = 0;
    const openM = OPEN_RE.exec(template);
    if (!openM) return template;
    const expr = openM[1].trim();
    const bodyStart = openM.index + openM[0].length;
    const TOK_RE = /\{[#\/](?:key|if|each|boundary|island)\b[^}]*\}/g;
    TOK_RE.lastIndex = bodyStart;
    let depth = 1;
    let closeAt = -1;
    let tm;
    while (tm = TOK_RE.exec(template)) {
      if (tm[0].startsWith("{#")) {
        depth++;
        continue;
      }
      depth--;
      if (depth === 0) {
        closeAt = tm.index;
        break;
      }
    }
    if (closeAt < 0) {
      throw new RoseError(
        "E-TEMPLATE",
        `${filePath2}: {#key ${expr}} is never closed`,
        { hint: "every {#key} needs its {/key}" }
      );
    }
    template = template.slice(0, openM.index) + `{#each [${expr}] as __rvkv}` + template.slice(bodyStart, closeAt) + "{/each}" + template.slice(closeAt + "{/key}".length);
  }
  return template;
}
function expandIfElseOnce(template) {
  const TOK_RE = /\{#(?:if|each|boundary|island)\b[^}]*\}|\{\/(?:if|each|boundary|island)\s*\}|\{:else(?:\s+if\s+[^}]*)?\}/g;
  let out = "";
  let pos = 0;
  let changed = false;
  for (; ; ) {
    const openM = /\{#(if|each)\s+([^}]+)\}/g.exec(template.slice(pos));
    if (!openM) {
      out += template.slice(pos);
      break;
    }
    const kind = openM[1];
    const head = openM[2];
    const start = pos + openM.index;
    const cond = kind === "if" ? head.trim() : "";
    const bodyStart = start + openM[0].length;
    out += template.slice(pos, start);
    TOK_RE.lastIndex = bodyStart;
    let depth = 1;
    let closeAt = -1;
    let closeLen = 0;
    const elses = [];
    let tm;
    while (tm = TOK_RE.exec(template)) {
      const tok = tm[0];
      if (tok.startsWith("{:else")) {
        if (depth === 1) {
          const condM = /^\{:else\s+if\s+([^}]*)\}$/.exec(tok);
          elses.push({ at: tm.index, len: tok.length, cond: condM ? condM[1].trim() : null });
        }
        continue;
      }
      if (tok.startsWith("{#")) {
        depth++;
        continue;
      }
      depth--;
      if (depth === 0) {
        closeAt = tm.index;
        closeLen = tok.length;
        break;
      }
    }
    if (closeAt < 0 || elses.length === 0) {
      out += template.slice(start, closeAt < 0 ? template.length : closeAt + closeLen);
      if (closeAt < 0) break;
      pos = closeAt + closeLen;
      continue;
    }
    const body = template.slice(bodyStart, closeAt);
    if (kind === "each") {
      const lastBare = [...elses].reverse().find((e) => e.cond === null);
      if (!lastBare) {
        out += template.slice(start, closeAt + closeLen);
        pos = closeAt + closeLen;
        continue;
      }
      const relLast = lastBare.at - bodyStart;
      const eachBody = body.slice(0, relLast);
      const elseBody = body.slice(relLast + lastBare.len);
      const itemsExpr = head.replace(/\s+as\s+[\w,\s]*$/, "").trim();
      out += template.slice(start, bodyStart) + eachBody + `{/each}{#if !(${itemsExpr}.length)}${elseBody}{/if}`;
      pos = closeAt + closeLen;
      changed = true;
      continue;
    }
    const branches = [];
    let cursor = 0;
    for (let i = 0; i < elses.length; i++) {
      const e = elses[i];
      const rel = e.at - bodyStart;
      branches.push({ cond: i === 0 ? null : elses[i - 1].cond, body: body.slice(cursor, rel) });
      cursor = rel + e.len;
    }
    branches.push({ cond: elses[elses.length - 1].cond, body: body.slice(cursor) });
    const first = branches.shift();
    const build2 = (bs) => {
      if (!bs.length) return "";
      const head2 = bs[0];
      const rest = bs.slice(1);
      if (head2.cond == null) return head2.body;
      let s = `{#if ${head2.cond}}${head2.body}{/if}`;
      if (rest.length) s += `{#if !(${head2.cond})}` + build2(rest) + `{/if}`;
      return s;
    };
    let emitted = `{#if ${cond}}${first.body}{/if}`;
    if (branches.length) emitted += `{#if !(${cond})}` + build2(branches) + `{/if}`;
    out += emitted;
    pos = closeAt + closeLen;
    changed = true;
  }
  return { template: out, changed };
}
function mergeStaticClass(template) {
  if (!/\sclass\s*=\s*"/.test(template) || !/\sclass\s*=\s*\{/.test(template)) return template;
  const TAG_RE = /<([a-zA-Z][^\s>/]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  let out = "";
  let pos = 0;
  let m;
  TAG_RE.lastIndex = 0;
  while (m = TAG_RE.exec(template)) {
    const [whole, tag, attrs, selfClose] = m;
    const sm = /\sclass\s*=\s*"([^"]*)"/.exec(attrs);
    if (!sm) continue;
    const rm = /\sclass\s*=\s*\{/.exec(attrs);
    if (!rm || rm.index === sm.index) continue;
    const open = attrs.indexOf("{", rm.index);
    let depth = 1;
    let j = open + 1;
    while (j < attrs.length && depth > 0) {
      const ch = attrs[j];
      if (ch === '"' || ch === "'") {
        j = skipQuoted(attrs, j);
        continue;
      }
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      j++;
    }
    if (depth !== 0) continue;
    const expr = attrs.slice(open + 1, j - 1);
    const base = JSON.stringify(sm[1]);
    const merged = ` class={((v) => v == null ? ${base} : typeof v === 'object' ? ({ ${base}: true, ...v }) : (${base} + ' ' + v))(${expr})}`;
    const lo = Math.min(sm.index, rm.index);
    const hiEnd = Math.max(sm.index + sm[0].length, j);
    const newAttrs = attrs.slice(0, lo) + merged + attrs.slice(hiEnd);
    out += template.slice(pos, m.index) + `<${tag}${newAttrs}${selfClose}>`;
    pos = m.index + whole.length;
  }
  out += template.slice(pos);
  return out;
}
function expandClassDirectives(template, filePath2) {
  if (!template.includes("class:")) return template;
  const TAG_RE = /<([a-zA-Z][^\s>/]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  let out = "";
  let pos = 0;
  let m;
  TAG_RE.lastIndex = 0;
  while (m = TAG_RE.exec(template)) {
    const [whole, tag, attrs, selfClose] = m;
    if (!attrs.includes("class:")) continue;
    const pairs = [];
    const NAME_RE = /\sclass:([\w-]+)\s*=\s*\{/g;
    let nm;
    while (nm = NAME_RE.exec(attrs)) {
      let i = nm.index + nm[0].length;
      let depth = 1;
      while (i < attrs.length && depth > 0) {
        const ch = attrs[i];
        if (ch === '"' || ch === "'") {
          i = skipQuoted(attrs, i);
          continue;
        }
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
        i++;
      }
      if (depth !== 0) {
        throw new RoseError("E-TEMPLATE", `${filePath2}: class:${nm[1]}={...} is missing its closing brace`, { file: filePath2, hint: "the binding expression needs a matching } before the tag ends" });
      }
      pairs.push({ name: nm[1], expr: attrs.slice(nm.index + nm[0].length, i - 1), start: nm.index, end: i });
    }
    const clsRe = /(\sclass\s*=\s*)("([^"]*)"|'([^']*)'|\{[^}]*\})/;
    const clsM = clsRe.exec(attrs);
    if (clsM && clsM[2].startsWith("{")) {
      throw new RoseError("E-TEMPLATE", `${filePath2}: <${tag}> has both class={...} and class: directives`, { file: filePath2, hint: 'merge them: move the dynamic part into a class:NAME={expr} and keep the rest in class="..."' });
    }
    const staticCls = clsM ? clsM[3] ?? clsM[4] ?? "" : "";
    let closure = `(${JSON.stringify(staticCls)}`;
    for (const p of pairs) {
      closure += `+((${p.expr})?${JSON.stringify(" " + p.name)}:'')`;
    }
    closure += `)`;
    let newAttrs = attrs;
    for (let k = pairs.length - 1; k >= 0; k--) {
      newAttrs = newAttrs.slice(0, pairs[k].start) + newAttrs.slice(pairs[k].end);
    }
    if (clsM) {
      newAttrs = newAttrs.replace(clsRe, ` class={${closure}}`);
    } else {
      newAttrs = ` class={${closure}}` + newAttrs;
    }
    out += template.slice(pos, m.index) + `<${tag}${newAttrs}${selfClose}>`;
    pos = m.index + whole.length;
  }
  if (pos === 0) return template;
  out += template.slice(pos);
  return out;
}
function expandTransitionDirectives(template, filePath2) {
  if (!/\s(?:transition|in|out):/.test(template)) return template;
  const TAG_RE = /<([a-zA-Z][^\s>/]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  let out = "";
  let pos = 0;
  let m;
  TAG_RE.lastIndex = 0;
  while (m = TAG_RE.exec(template)) {
    const [whole, tag, attrs, selfClose] = m;
    if (!attrs.includes("transition:") && !/\s(?:in|out):/.test(attrs)) continue;
    const pairs = [];
    const NAME_RE = /\s(transition|in|out):([\w-]+)(?:\s*=\s*\{)?/g;
    let nm;
    while (nm = NAME_RE.exec(attrs)) {
      let start = nm.index;
      let end = nm.index + nm[0].length;
      let params = "";
      if (nm[0].endsWith("{")) {
        let depth = 1;
        let i = end;
        while (i < attrs.length && depth > 0) {
          const ch = attrs[i];
          if (ch === '"' || ch === "'") {
            i = skipQuoted(attrs, i);
            continue;
          }
          if (ch === "{") depth++;
          else if (ch === "}") depth--;
          i++;
        }
        if (depth !== 0) {
          throw new RoseError("E-TEMPLATE", `${filePath2}: transition:${nm[1]}={...} is missing its closing brace`, { file: filePath2, hint: "the transition params expression needs a matching } before the tag ends" });
        }
        params = attrs.slice(end, i - 1);
        end = i;
      }
      pairs.push({ dir: nm[1] === "transition" ? "" : nm[1], name: nm[2], params, start, end });
    }
    if (pairs.length === 0) continue;
    let transitionValue = "";
    for (const p of pairs) {
      if (transitionValue) transitionValue += "|";
      transitionValue += (p.dir ? p.dir + ":" : "") + p.name + (p.params ? ":" + p.params : "");
    }
    let newAttrs = attrs;
    for (let k = pairs.length - 1; k >= 0; k--) {
      newAttrs = newAttrs.slice(0, pairs[k].start) + newAttrs.slice(pairs[k].end);
    }
    const transRe = /\sdata-transition\s*=\s*("([^"]*)"|'([^']*)'|\{[^}]*\})/;
    const tm = transRe.exec(newAttrs);
    if (tm) {
      const existing = tm[2] ?? tm[3] ?? "";
      newAttrs = newAttrs.replace(transRe, ` data-transition="${existing}${transitionValue ? (existing ? "|" : "") + transitionValue : ""}"`);
    } else {
      newAttrs = ` data-transition="${transitionValue}"` + newAttrs;
    }
    out += template.slice(pos, m.index) + `<${tag}${newAttrs}${selfClose}>`;
    pos = m.index + whole.length;
  }
  out += template.slice(pos);
  return out;
}
function expandAnimateDirectives(template, filePath2) {
  if (!template.includes("animate:")) return template;
  const TAG_RE = /<([a-zA-Z][^\s>/]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  let out = "";
  let pos = 0;
  let m;
  TAG_RE.lastIndex = 0;
  while (m = TAG_RE.exec(template)) {
    const [whole, tag, attrs, selfClose] = m;
    if (!attrs.includes("animate:")) continue;
    const pairs = [];
    const NAME_RE = /\sanimate:([\w-]+)(?:\s*=\s*\{)?/g;
    let nm;
    while (nm = NAME_RE.exec(attrs)) {
      let start = nm.index;
      let end = nm.index + nm[0].length;
      let params = "";
      if (nm[0].endsWith("{")) {
        let depth = 1;
        let i = end;
        while (i < attrs.length && depth > 0) {
          const ch = attrs[i];
          if (ch === '"' || ch === "'") {
            i = skipQuoted(attrs, i);
            continue;
          }
          if (ch === "{") depth++;
          else if (ch === "}") depth--;
          i++;
        }
        if (depth !== 0) {
          throw new RoseError("E-TEMPLATE", `${filePath2}: animate:${nm[1]}={...} is missing its closing brace`, { file: filePath2, hint: "the animate params expression needs a matching } before the tag ends" });
        }
        params = attrs.slice(end, i - 1);
        end = i;
      }
      pairs.push({ name: nm[1], params, start, end });
    }
    let animateValue = "";
    for (const p of pairs) {
      if (animateValue) animateValue += "|";
      animateValue += p.name + (p.params ? ":" + p.params : "");
    }
    let newAttrs = attrs;
    for (let k = pairs.length - 1; k >= 0; k--) {
      newAttrs = newAttrs.slice(0, pairs[k].start) + newAttrs.slice(pairs[k].end);
    }
    const animRe = /\sdata-animate\s*=\s*("([^"]*)"|'([^']*)'|\{[^}]*\})/;
    const am = animRe.exec(newAttrs);
    if (am) {
      const existing = am[2] ?? am[3] ?? "";
      newAttrs = newAttrs.replace(animRe, ` data-animate="${existing}${animateValue ? (existing ? "|" : "") + animateValue : ""}"`);
    } else {
      newAttrs = ` data-animate="${animateValue}"` + newAttrs;
    }
    out += template.slice(pos, m.index) + `<${tag}${newAttrs}${selfClose}>`;
    pos = m.index + whole.length;
  }
  out += template.slice(pos);
  return out;
}
function expandStyleDirectives(template, filePath2) {
  if (!template.includes("style:")) return template;
  const TAG_RE = /<([a-zA-Z][^\s>/]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  let out = "";
  let pos = 0;
  let m;
  TAG_RE.lastIndex = 0;
  while (m = TAG_RE.exec(template)) {
    const [whole, tag, attrs, selfClose] = m;
    if (!attrs.includes("style:")) continue;
    const pairs = [];
    const NAME_RE = /\sstyle:([\w-]+)\s*=\s*\{/g;
    let nm;
    while (nm = NAME_RE.exec(attrs)) {
      let i = nm.index + nm[0].length;
      let depth = 1;
      while (i < attrs.length && depth > 0) {
        const ch = attrs[i];
        if (ch === '"' || ch === "'") {
          i = skipQuoted(attrs, i);
          continue;
        }
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
        i++;
      }
      if (depth !== 0) {
        throw new RoseError("E-TEMPLATE", `${filePath2}: style:${nm[1]}={...} is missing its closing brace`, { file: filePath2, hint: "the binding expression needs a matching } before the tag ends" });
      }
      pairs.push({ prop: nm[1], expr: attrs.slice(nm.index + nm[0].length, i - 1), start: nm.index, end: i });
    }
    const styleRe = /(\sstyle\s*=\s*)("([^"]*)"|'([^']*)'|\{[^}]*\})/;
    const stM = styleRe.exec(attrs);
    if (stM && stM[2].startsWith("{")) {
      throw new RoseError("E-TEMPLATE", `${filePath2}: <${tag}> has both style={...} and style: directives`, { file: filePath2, hint: 'keep the static declarations in style="..." and move the dynamic ones to style:PROP={expr}' });
    }
    const staticStyle = stM ? stM[3] ?? stM[4] ?? "" : "";
    let closure = `${JSON.stringify(staticStyle.endsWith(";") || staticStyle === "" ? staticStyle : staticStyle + ";")}`;
    for (const p of pairs) {
      closure += `+${JSON.stringify(p.prop + ":")}+(${p.expr})+';'`;
    }
    let newAttrs = attrs;
    for (let k = pairs.length - 1; k >= 0; k--) {
      newAttrs = newAttrs.slice(0, pairs[k].start) + newAttrs.slice(pairs[k].end);
    }
    if (stM) {
      newAttrs = newAttrs.replace(styleRe, ` style={${closure}}`);
    } else {
      newAttrs = ` style={${closure}}` + newAttrs;
    }
    out += template.slice(pos, m.index) + `<${tag}${newAttrs}${selfClose}>`;
    pos = m.index + whole.length;
  }
  if (pos === 0) return template;
  out += template.slice(pos);
  return out;
}
function expandBoundaryFallbacks(template, filePath2) {
  if (!template.includes("{:fallback")) return template;
  for (let pass = 0; pass < 10; pass++) {
    const TOK_RE = /\{#boundary\}|\{\/boundary\}|\{:fallback\}/g;
    let out = "";
    let pos = 0;
    let changed = false;
    let tm;
    while (tm = TOK_RE.exec(template)) {
      if (tm[0] !== "{#boundary}") continue;
      const start = tm.index;
      const bodyStart = start + tm[0].length;
      let depth = 1;
      let closeAt = -1;
      let tm2;
      while (tm2 = TOK_RE.exec(template)) {
        if (tm2[0] === "{#boundary}") {
          depth++;
          continue;
        }
        if (tm2[0] === "{/boundary}") {
          depth--;
          if (depth === 0) {
            closeAt = tm2.index;
            break;
          }
        }
      }
      if (closeAt < 0) break;
      const body = template.slice(bodyStart, closeAt);
      const BTOK2 = /\{#(boundary|if|each|key|island)(?:\s+[^}]*)?\}|\{\/(?:boundary|if|each|key|island)\s*\}|\{:fallback\}/g;
      const kindStack = ["boundary"];
      let d = 1;
      let fbAt = -1;
      let fbLen = 0;
      let tm3;
      BTOK2.lastIndex = 0;
      while (tm3 = BTOK2.exec(body)) {
        const tok = tm3[0];
        if (tok === "{:fallback}") {
          const top = kindStack[kindStack.length - 1];
          if (top !== "boundary") {
            throw new RoseError(
              "E-TEMPLATE",
              `${filePath2}: {:fallback} must sit directly inside a {#boundary} block`,
              { hint: "move it out of the {#if}/{#each} it sits in, or keep the conditional fallback in the parent" }
            );
          }
          if (fbAt >= 0) {
            throw new RoseError("E-TEMPLATE", `${filePath2}: a {#boundary} can carry only one {:fallback}`, { hint: "remove the extra {:fallback} segment" });
          }
          fbAt = tm3.index;
          fbLen = tok.length;
          continue;
        }
        if (tok.startsWith("{#")) {
          d++;
          kindStack.push(tok.slice(2, tok.length - 1).trim().split(/\s/)[0]);
          continue;
        }
        d--;
        kindStack.pop();
      }
      if (fbAt < 0) continue;
      const custom = body.slice(0, fbAt);
      const fbMarkup = body.slice(fbAt + fbLen);
      const b64 = Buffer.from(fbMarkup, "utf-8").toString("base64");
      out += template.slice(pos, start) + `{#boundary __fb="${b64}"}` + custom + "{/boundary}";
      pos = closeAt + "{/boundary}".length;
      changed = true;
    }
    if (!changed) break;
    template = out + template.slice(pos);
  }
  return template;
}
function expandIfElse(template) {
  for (let pass = 0; pass < 10; pass++) {
    if (!/\{:else\b/.test(template)) return template;
    const r = expandIfElseOnce(template);
    template = r.template;
    if (!r.changed) return template;
  }
  return template;
}
function expandDeferBlocks(template) {
  if (!DEFER_ENABLED) {
    const openRe2 = /\{#defer(?:\s+hold=\\d+)?\}/g;
    let out2 = "";
    let dpos = 0;
    for (; ; ) {
      openRe2.lastIndex = dpos;
      const openM = openRe2.exec(template);
      if (!openM) break;
      const openAt = openM.index;
      const openLen = openM[0].length;
      const closeAt = template.indexOf("{/defer}", openAt + openLen);
      if (closeAt < 0) break;
      out2 += template.slice(dpos, openAt) + template.slice(openAt + openLen, closeAt);
      dpos = closeAt + 8;
    }
    return { template: dpos === 0 ? template : out2, count: 0, holds: [] };
  }
  let count = 0;
  const holds = [];
  let out = "";
  let pos = 0;
  const openRe = /\{#defer(?:\s+hold=(\d+))?\}/g;
  for (; ; ) {
    openRe.lastIndex = pos;
    const openM = openRe.exec(template);
    if (!openM) break;
    const openAt = openM.index;
    const openLen = openM[0].length;
    const hold = openM[1] ? Number(openM[1]) : 0;
    let depth = 1;
    let i = openAt + openLen;
    let closeAt = -1;
    while (i < template.length) {
      openRe.lastIndex = i;
      const nextOpenM = openRe.exec(template);
      const nextOpen = nextOpenM ? nextOpenM.index : -1;
      const nextClose = template.indexOf("{/defer}", i);
      if (nextClose < 0) break;
      if (nextOpen >= 0 && nextOpen < nextClose) {
        depth++;
        i = nextOpen + nextOpenM[0].length;
        continue;
      }
      depth--;
      if (depth === 0) {
        closeAt = nextClose;
        break;
      }
      i = nextClose + 8;
    }
    if (closeAt < 0) break;
    const content = template.slice(openAt + openLen, closeAt);
    holds.push(hold);
    const n = ++count;
    out += template.slice(pos, openAt);
    out += "{#if __rvDefer" + n + "()}" + content + "{/if}\n{#if !__rvDefer" + n + '()}<div class="rv-defer-loading"></div>{/if}';
    pos = closeAt + 8;
  }
  if (count === 0) return { template, count: 0, holds: [] };
  out += template.slice(pos);
  return { template: out, count, holds };
}
function deferBootCode(count, holds = []) {
  let code = "";
  for (let n = 1; n <= count; n++) {
    code += "const [__rvDefer" + n + ", set__rvDefer" + n + '] = state("__rvdefer' + n + '", false);\n';
    const hold = holds[n - 1] || 0;
    code += hold > 0 ? "onMount(function () { setTimeout(function () { set__rvDefer" + n + "(true); }, " + hold + "); });\n" : "onMount(function () { requestAnimationFrame(function () { requestAnimationFrame(function () { set__rvDefer" + n + "(true); }); }); });\n";
  }
  return code;
}
function expandAwaitBlocks(template, filePath2) {
  let out = "";
  let pos = 0;
  let n = 0;
  const blocks = [];
  for (; ; ) {
    const openAt = template.indexOf("{#await", pos);
    if (openAt < 0) break;
    let i = openAt + 7;
    let brace = 1;
    while (i < template.length && brace > 0) {
      const c = template[i];
      if (c === "{") brace++;
      else if (c === "}") brace--;
      i++;
    }
    if (brace !== 0) break;
    const openLen = i - openAt;
    const expr = template.slice(openAt + 7, i - 1).trim();
    if (!expr) {
      throw new RoseError("E-TEMPLATE", `${filePath2}: {#await} needs a promise expression`, {
        file: filePath2,
        hint: "write {#await fetchUsers()}...{:then users}...{/await}"
      });
    }
    const blockOpenRe = /\{\#(if|each|boundary|island|await)\b/g;
    const blockCloseRe = /\{\/(if|each|boundary|island|await)\}/g;
    const thenRe = /\{:then\b([^}]*)\}/g;
    const catchRe = /\{:catch\b([^}]*)\}/g;
    let d = 1;
    let j = i;
    let thenAt = -1, catchAt = -1, closeAt = -1;
    let thenRaw = "", catchRaw = "";
    for (; ; ) {
      blockOpenRe.lastIndex = j;
      blockCloseRe.lastIndex = j;
      thenRe.lastIndex = j;
      catchRe.lastIndex = j;
      const nextOpen = blockOpenRe.exec(template);
      const nextClose = blockCloseRe.exec(template);
      const nextThen = thenRe.exec(template);
      const nextCatch = catchRe.exec(template);
      let nearestPos = Infinity, kind = "", m = null;
      const consider = (mm, k) => {
        if (mm && mm.index < nearestPos) {
          nearestPos = mm.index;
          kind = k;
          m = mm;
        }
      };
      consider(nextOpen, "open");
      consider(nextClose, "close");
      consider(nextThen, "then");
      consider(nextCatch, "catch");
      if (!m) break;
      if (kind === "open") {
        d++;
        j = m.index + m[0].length;
        continue;
      }
      if (kind === "close") {
        if (d === 1 && m[1] === "await") {
          closeAt = m.index;
          break;
        }
        d--;
        j = m.index + m[0].length;
        continue;
      }
      if (d === 1) {
        if (kind === "then" && thenAt < 0) {
          thenAt = m.index;
          thenRaw = m[1];
        } else if (kind === "catch" && catchAt < 0) {
          catchAt = m.index;
          catchRaw = m[1];
        }
      }
      j = m.index + m[0].length;
    }
    if (closeAt < 0 || thenAt < 0) break;
    const thenTokenEnd = thenAt + 7 + thenRaw.length;
    const catchTokenEnd = catchAt >= 0 ? catchAt + 7 + catchRaw.length : -1;
    const pending = template.slice(i, thenAt);
    const thenBody = template.slice(thenTokenEnd, catchAt >= 0 ? catchAt : closeAt);
    const catchBody = catchAt >= 0 ? template.slice(catchTokenEnd, closeAt) : "";
    const thenVarRaw = thenRaw.trim();
    const catchVarRaw = catchRaw.trim();
    const thenVar = /^\w+$/.test(thenVarRaw) ? thenVarRaw : `__rvAwaitThen${n + 1}`;
    const catchVar = catchAt >= 0 ? /^\w+$/.test(catchVarRaw) ? catchVarRaw : `__rvAwaitCatch${n + 1}` : "";
    n++;
    const nn = n;
    const stateName = `__rvAwait${nn}`;
    blocks.push({ n: nn, expr, thenVar, catchVar });
    out += template.slice(pos, openAt);
    out += `{#if ${stateName}().status === 'pending'}` + pending + "{/if}\n";
    out += `{#each (${stateName}().status === 'resolved' ? [${stateName}().value] : []) as ${thenVar}}` + thenBody + "{/each}\n";
    if (catchAt >= 0) {
      out += `{#each (${stateName}().status === 'rejected' ? [${stateName}().error] : []) as ${catchVar}}` + catchBody + "{/each}\n";
    }
    pos = closeAt + 8;
  }
  if (n === 0) return { template, blocks };
  out += template.slice(pos);
  return { template: out, blocks };
}
function awaitBootCode(blocks) {
  let code = "";
  for (const b of blocks) {
    const stateName = `__rvAwait${b.n}`;
    code += `const [${stateName}, set${stateName}] = state("__rvawait${b.n}", { status: 'pending', value: null, error: null });
`;
    code += `onMount(function () {
`;
    code += `  Promise.resolve(${b.expr}).then(function (__rvAwaitVal) {
`;
    code += `    set${stateName}({ status: 'resolved', value: __rvAwaitVal });
`;
    code += `  }).catch(function (__rvAwaitErr) {
`;
    code += `    set${stateName}({ status: 'rejected', error: __rvAwaitErr });
`;
    code += `  });
`;
    code += `});
`;
  }
  return code;
}
function findBlock(src, kind) {
  const head = kind === "boundary" ? /\{#boundary(?:\s+([^}]*))?\}/g : kind === "if" ? /\{#if\s+([^}]+)\}/g : kind === "island" ? /\{#island(?:\s+name="([^"]*)")?(?:\s+hydrate="([^"]*)")?\s*\}/g : kind === "snippet" ? /\{#snippet\s+(\w+)(?:\s*\(([^)]+)\))?\s*\}/g : /\{#each\s+([^}]+?)\s+as\s+(\{[^{}]*\}|\[[^[\]]*\]|\w+)(?:\s*,\s*(\w+))?(?:\s*\(([^)]+)\))?\}/g;
  const closeRe = new RegExp(`\\{/${kind}\\}`, "g");
  let open;
  while (open = head.exec(src)) {
    const start = open.index;
    const afterOpen = start + open[0].length;
    let depth = 1;
    let i = afterOpen;
    for (; ; ) {
      head.lastIndex = i;
      closeRe.lastIndex = i;
      const nextOpen = head.exec(src);
      const nextClose = closeRe.exec(src);
      if (!nextClose) break;
      if (nextOpen && nextOpen.index < nextClose.index) {
        depth++;
        i = nextOpen.index + nextOpen[0].length;
        continue;
      }
      i = nextClose.index + nextClose[0].length;
      if (--depth === 0) {
        const content = src.slice(afterOpen, nextClose.index);
        const groups = kind === "boundary" ? [open[1] ?? "", content] : kind === "island" ? [open[1] ?? "", open[2] ?? "", content] : kind === "snippet" ? [open[1], open[2] ?? "", content] : kind === "if" ? [open[1], content] : [open[1], open[2], open[3] ?? "", open[4] ?? "", content];
        const arr = [src.slice(start, i), ...groups];
        arr.index = start;
        return arr;
      }
    }
    head.lastIndex = afterOpen;
  }
  return null;
}
function compileHead(head) {
  const RAW_OPEN = /<(style|script|noscript)\b[^>]*>/iy;
  let out = "";
  let buf = "";
  let seg = 0;
  let i = 0;
  const flush = () => {
    if (buf.trim()) out += compileTemplate(buf, "__hd", "__hc", null, seg++, false);
    buf = "";
  };
  while (i < head.length) {
    if (head.startsWith("<!--", i)) {
      const end = head.indexOf("-->", i + 4);
      i = end < 0 ? head.length : end + 3;
      continue;
    }
    RAW_OPEN.lastIndex = i;
    const open = RAW_OPEN.exec(head);
    if (open) {
      const tag = open[1].toLowerCase();
      const closeAt = head.toLowerCase().indexOf(`</${tag}`, i + open[0].length);
      const gt = closeAt < 0 ? -1 : head.indexOf(">", closeAt);
      const end = gt < 0 ? head.length : gt + 1;
      flush();
      out += emitOpenTag(open[0], "__hd", "__hc", null);
      out += emitChunk(head.slice(i + open[0].length, end), "__hd", "__hc", null);
      i = end;
      continue;
    }
    buf += head[i++];
  }
  flush();
  return out;
}
var KNOWN_CLOSERS = /* @__PURE__ */ new Set(["if", "each", "boundary", "island", "await", "snippet"]);
var __blockResCache = /* @__PURE__ */ new Map();
function blockCloseRes(kind) {
  let hit = __blockResCache.get(kind);
  if (!hit) {
    hit = {
      open: new RegExp(`\\{#${kind}\\b[^}]*\\}`, "g"),
      close: new RegExp(`\\{/${kind}\\}`, "g")
    };
    __blockResCache.set(kind, hit);
  }
  return hit;
}
function assertKnownDirectives(template, filePath2) {
  const rawRanges = [];
  const RAW_OPEN = /<(style|script|noscript)\b[^>]*>/gi;
  let raw;
  while (raw = RAW_OPEN.exec(template)) {
    const tag = raw[1].toLowerCase();
    const closeAt = template.toLowerCase().indexOf(`</${tag}`, raw.index + raw[0].length);
    const gt = closeAt < 0 ? -1 : template.indexOf(">", closeAt);
    const end = gt < 0 ? template.length : gt + 1;
    rawRanges.push([raw.index, end]);
    RAW_OPEN.lastIndex = end;
  }
  const COMMENT_RE = /<!--[\s\S]*?-->/g;
  let note;
  while (note = COMMENT_RE.exec(template)) rawRanges.push([note.index, note.index + note[0].length]);
  rawRanges.sort((a, b) => a[0] - b[0]);
  const inRaw = (idx) => rawRanges.some(([s, e]) => idx >= s && idx < e);
  const DIRECTIVE_RE = /\{([:/])(\w+)\}/g;
  let m;
  while (m = DIRECTIVE_RE.exec(template)) {
    if (inRaw(m.index)) continue;
    const [, sigil, word] = m;
    if (sigil === "/" && KNOWN_CLOSERS.has(word)) continue;
    if (sigil === "/") {
      throw new RoseError(
        "E-TEMPLATE",
        `${filePath2}: {/${word}} does not close anything`,
        { file: filePath2, line: lineAt(template, m), hint: "the closers are {/if}, {/each} and {/boundary} - one per block you opened" }
      );
    }
    if (word === "else") {
      const netOpens = (re, closer, at) => {
        let n = 0, mm;
        re.lastIndex = 0;
        while (mm = re.exec(template)) {
          if (mm.index >= at) break;
          if (!inRaw(mm.index)) n++;
        }
        const cr = new RegExp(closer, "g");
        let c = 0;
        while (mm = cr.exec(template)) {
          if (mm.index >= at) break;
          if (!inRaw(mm.index)) c++;
        }
        return n - c;
      };
      const ifNet = netOpens(/\{#if\b/g, "\\{/if\\b", m.index);
      const eachNet = netOpens(/\{#each\b/g, "\\{/each\\b", m.index);
      if (ifNet <= 0 && eachNet <= 0) {
        throw new RoseError(
          "E-TEMPLATE",
          `${filePath2}: a stray {:else} with no {#if} or {#each} above it`,
          { file: filePath2, line: lineAt(template, m), hint: "{:else} belongs inside an {#if} ... {/if} or {#each} ... {/each} block" }
        );
      }
      continue;
    }
    if (word === "fallback") {
      throw new RoseError(
        "E-TEMPLATE",
        `${filePath2}: a stray {:fallback} with no {#boundary} above it`,
        { file: filePath2, line: lineAt(template, m), hint: "{:fallback} belongs directly inside a {#boundary} ... {/boundary} block" }
      );
    }
    if (word === "then" || word === "catch") {
      const opensBefore = (re, at) => {
        re.lastIndex = 0;
        let n = 0, mm;
        while (mm = re.exec(template)) {
          if (mm.index >= at) break;
          if (!inRaw(mm.index)) n++;
        }
        return n;
      };
      const open = opensBefore(/\{#await\b/g, m.index);
      const close = opensBefore(/\{\/await\b/g, m.index);
      if (open <= close) {
        throw new RoseError(
          "E-TEMPLATE",
          `${filePath2}: a stray {:${word}} with no {#await} above it`,
          { file: filePath2, line: lineAt(template, m), hint: "{:then} / {:catch} belong inside an {#await} ... {/await} block" }
        );
      }
      continue;
    }
    throw new RoseError(
      "E-TEMPLATE",
      `${filePath2}: {:${word}} is not a rosespan directive`,
      { file: filePath2, line: lineAt(template, m), hint: "rosespan templates support {#if}/{:else}, {#each} and {#boundary}" }
    );
  }
  const OPENER_RE = /\{#(if|each|boundary|island|await)\b([^}]*)\}/g;
  while (m = OPENER_RE.exec(template)) {
    if (inRaw(m.index)) continue;
    const [, kind, head] = m;
    if (kind === "each" && !/\bas\s+(\{[^{}]*\}?|\[[^[\]]*\]?|\w+)(?:\s*,\s*\w+)?(?:\s*\([^)]*\))?\s*$/.test(head)) {
      throw new RoseError(
        "E-TEMPLATE",
        `${filePath2}: {#each ${head.trim()}} is missing its item name`,
        { file: filePath2, line: lineAt(template, m), hint: "write {#each items() as item} - the name after `as` is what the block body reads (item.id, item.name)" }
      );
    }
    const { open: OPEN_RE, close: CLOSE_RE } = blockCloseRes(kind);
    let depth = 1;
    let i = m.index + m[0].length;
    for (; ; ) {
      OPEN_RE.lastIndex = i;
      CLOSE_RE.lastIndex = i;
      const nextOpen = OPEN_RE.exec(template);
      const nextClose = CLOSE_RE.exec(template);
      if (!nextClose) break;
      if (nextOpen && nextOpen.index < nextClose.index) {
        i = nextOpen.index + nextOpen[0].length;
        continue;
      }
      i = nextClose.index + nextClose[0].length;
      if (--depth === 0) break;
    }
    if (depth !== 0) {
      throw new RoseError(
        "E-TEMPLATE",
        `${filePath2}: unclosed {#${kind}} - every block needs its {/${kind}}`,
        { file: filePath2, line: lineAt(template, m), hint: `add the matching {/${kind}} (an inner {#if} or {#each} closes first, deepest first)` }
      );
    }
  }
}
function rewriteQuotedExprAttrs(template, comps) {
  const TAG_RE = /<([a-zA-Z][\w-]*)((?:\s+[\w:-]+(?:=(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>/g;
  return template.replace(TAG_RE, (tag, name, attrs, selfClose) => {
    if (comps.has(name) || !/\{/.test(attrs)) return tag;
    const rewritten = attrs.replace(/([\w:-]+)="([^"]*)"/g, (whole, attr, value) => {
      if (!/\{/.test(value) || value.includes("`")) return whole;
      const spans = templateExprSpans(value);
      if (spans.length === 0) return whole;
      let expr = "";
      let last = 0;
      for (const s of spans) {
        if (last < s.start) expr += (expr ? " + " : "") + JSON.stringify(value.slice(last, s.start));
        expr += (expr ? " + " : "") + `(${s.expr})`;
        last = s.end + 1;
      }
      if (last < value.length) expr += (expr ? " + " : "") + JSON.stringify(value.slice(last));
      return `${attr}={${expr}}`;
    });
    return `<${name}${rewritten}${selfClose ? " /" : ""}>`;
  });
}
function compileTemplate(template, acc, closes, scope, depth, markers = true, comps = /* @__PURE__ */ new Map(), islandDepth = 0) {
  let result = "";
  let remaining = template;
  let blockId = 0;
  const islandsMode = /\{#island\b/.test(template);
  const effMarkers = markers && (!islandsMode || islandDepth > 0);
  const nextId = () => `${depth}_${blockId++}`;
  if (depth === 0) result += "const __snip = {};\n";
  while (remaining.length > 0) {
    const ifMatch = findBlock(remaining, "if");
    const eachMatch = findBlock(remaining, "each");
    const boundaryMatch = findBlock(remaining, "boundary");
    const firstExpr = templateExprSpans(remaining)[0];
    const exprMatch = firstExpr ? Object.assign([remaining.slice(firstExpr.start, firstExpr.end + 1), firstExpr.expr], { index: firstExpr.start }) : null;
    const compTag = comps.size > 0 ? findCompTag(remaining, comps) : null;
    const islandMatch = findBlock(remaining, "island");
    const snippetMatch = findBlock(remaining, "snippet");
    const candidates = [];
    if (ifMatch?.index !== void 0) candidates.push({ type: "if", match: ifMatch, index: ifMatch.index });
    if (eachMatch?.index !== void 0) candidates.push({ type: "each", match: eachMatch, index: eachMatch.index });
    if (boundaryMatch?.index !== void 0) candidates.push({ type: "boundary", match: boundaryMatch, index: boundaryMatch.index });
    if (islandMatch?.index !== void 0) candidates.push({ type: "island", match: islandMatch, index: islandMatch.index });
    if (snippetMatch?.index !== void 0) candidates.push({ type: "snippet", match: snippetMatch, index: snippetMatch.index });
    if (exprMatch?.index !== void 0) candidates.push({ type: "expr", match: exprMatch, index: exprMatch.index });
    if (compTag) candidates.push({ type: "comp", match: exprMatch, index: compTag.start, tag: compTag });
    const earliest = candidates.length > 0 ? candidates.reduce((a, b) => a.index <= b.index ? a : b) : null;
    const rawOpenRe = /<(style|script|noscript)\b[^>]*>/g;
    const rawHit = rawOpenRe.exec(remaining);
    if (rawHit && earliest && rawHit.index < earliest.index) {
      const tag = rawHit[1].toLowerCase();
      const closeAt = remaining.toLowerCase().indexOf(`</${tag}`, rawHit.index + rawHit[0].length);
      const gt = closeAt < 0 ? -1 : remaining.indexOf(">", closeAt);
      const end = gt < 0 ? remaining.length : gt + 1;
      result += emitChunk(remaining.slice(0, rawHit.index), acc, closes, scope);
      result += emitOpenTag(rawHit[0], acc, closes, scope);
      result += emitChunk(remaining.slice(rawHit.index + rawHit[0].length, end), acc, closes, scope);
      remaining = remaining.substring(end);
      continue;
    }
    const noteAt = remaining.indexOf("<!--");
    if (noteAt >= 0 && (!earliest || noteAt < earliest.index)) {
      const noteEnd = remaining.indexOf("-->", noteAt + 4);
      const end = noteEnd < 0 ? remaining.length : noteEnd + 3;
      result += emitChunk(remaining.slice(0, end), acc, closes, scope);
      remaining = remaining.substring(end);
      continue;
    }
    if (!earliest) {
      result += emitChunk(remaining, acc, closes, scope);
      break;
    }
    if (earliest.type === "if") {
      const [, cond, content] = earliest.match;
      const before = remaining.substring(0, earliest.index);
      if (before) result += emitChunk(before, acc, closes, scope);
      const call = autoCall(cond);
      const id = nextId();
      const innerScope = scope ?? "__s";
      const inner = compileTemplate(content.trim(), "h", "__c", innerScope, depth + 1, effMarkers, comps, islandDepth);
      result += `const __b${id} = (__s, __c) => { let h = ''; ${inner} return h; };
`;
      if (effMarkers) {
        result += `${acc} += ifMark(${closes}, () => (${call}), __b${id}${scope ? `, ${scope}` : ""});
`;
      } else {
        result += `${acc} += (${call}) ? __b${id}(${scope ?? "undefined"}, []) : '';
`;
      }
      remaining = remaining.substring(earliest.index + earliest.match[0].length);
    } else if (earliest.type === "each") {
      const [, items, item, index, key, content] = earliest.match;
      const before = remaining.substring(0, earliest.index);
      if (before) result += emitChunk(before, acc, closes, scope);
      const call = autoCall(items);
      const id = nextId();
      const isDestructure = /^[{[]/.test(item);
      const itemRe = isDestructure ? null : new RegExp(`\\b${item}\\b`, "g");
      const indexRe = index ? new RegExp(`\\b${index}\\b`, "g") : null;
      let scoped = "";
      let lastSpan = 0;
      for (const s of templateExprSpans(content.trim())) {
        let expr = itemRe ? s.expr.replace(itemRe, "__s") : s.expr;
        if (indexRe) expr = expr.replace(indexRe, "__i");
        scoped += content.trim().slice(lastSpan, s.start) + "{" + expr + "}";
        lastSpan = s.end + 1;
      }
      scoped += content.trim().slice(lastSpan);
      const inner = compileTemplate(scoped, "h", "__c", "__s", depth + 1, effMarkers, comps, islandDepth);
      const body = isDestructure ? `const ${item} = __s; ${inner}` : inner;
      let keyFn = "";
      if (key) {
        if (isDestructure) {
          throw new RoseError(
            "E-TEMPLATE",
            `${filePath}: a keyed {#each} keys on a named item's property - write {#each xs as x (x.id)}, not a destructuring pattern`,
            { file: filePath, hint: "name the item first, then key on one of its properties" }
          );
        }
        let k = key.trim();
        if (itemRe) k = k.replace(itemRe, "__s");
        if (indexRe) k = k.replace(indexRe, "__i");
        keyFn = `, (__s, __i) => (${k})`;
      }
      result += `const __b${id} = (__s, __c${index ? ", __i" : ""}) => { let h = ''; ${body} return h; };
`;
      if (effMarkers) {
        result += `${acc} += eachMark(${closes}, () => (${call}), __b${id}${keyFn});
`;
      } else {
        const param = isDestructure ? "__s" : item;
        result += `${acc} += (${call}).map((${param}${index ? ", __i" : ""}) => __b${id}(${param}, []${index ? ", __i" : ""}))).join('');
`;
      }
      remaining = remaining.substring(earliest.index + earliest.match[0].length);
    } else if (earliest.type === "boundary") {
      const [, fbAttr, content] = earliest.match;
      let fallbackSrc = "";
      if (fbAttr) {
        const fbM = /__fb="([A-Za-z0-9+/=]*)"/.exec(fbAttr);
        if (fbM) fallbackSrc = Buffer.from(fbM[1], "base64").toString("utf-8");
      }
      const custom = content;
      const before = remaining.substring(0, earliest.index);
      if (before) result += emitChunk(before, acc, closes, scope);
      const id = nextId();
      const catchesAction = /\$action:|<form[\s>]/.test(custom);
      const inner = compileTemplate(custom.trim(), "h", closes, scope, depth + 1, effMarkers, comps, islandDepth);
      result += `const __b${id} = (__c) => { let h = ''; ${inner} return h; };
`;
      let fbBlock = "";
      if (fallbackSrc.trim()) {
        const fbInner = compileTemplate(fallbackSrc.trim(), "h", closes, scope, depth + 1, effMarkers, comps, islandDepth);
        fbBlock = `const __bf${id} = (__c) => { let h = ''; ${fbInner} return h; };
`;
      }
      result += fbBlock;
      result += `let __bd${id} = '';
`;
      result += catchesAction ? `try { $actionErrorOrThrow(); __bd${id} = __b${id}(${closes}); } catch (e) { $setBoundaryError(e); __bd${id} = ${fbBlock ? `__bf${id}(${closes})` : "$boundaryFallback(e)"}; }
` : `try { __bd${id} = __b${id}(${closes}); } catch (e) { $setBoundaryError(e); __bd${id} = ${fbBlock ? `__bf${id}(${closes})` : JSON.stringify(BOUNDARY_FALLBACK)}; }
`;
      result += `${acc} += __bd${id};
`;
      remaining = remaining.substring(earliest.index + earliest.match[0].length);
    } else if (earliest.type === "snippet") {
      const [, name, params, content] = earliest.match;
      const before = remaining.substring(0, earliest.index);
      if (before) result += emitChunk(before, acc, closes, scope);
      const id = nextId();
      const paramList = params ? params.split(",").map((p) => p.trim()).filter(Boolean).join(",") : "";
      const inner = compileTemplate(content.trim(), "h", "__c", "__s", depth + 1, effMarkers, comps, islandDepth);
      result += `__snip.${name} = (__s, __c${paramList ? "," + paramList : ""}) => { let h = ''; ${inner} return h; };
`;
      remaining = remaining.substring(earliest.index + earliest.match[0].length);
    } else if (earliest.type === "comp") {
      const tag = earliest.tag;
      if (tag.start > 0) result += emitChunk(remaining.substring(0, tag.start), acc, closes, scope);
      const entry = comps.get(tag.name);
      const id = nextId();
      let childrenSrc = "";
      let rest;
      if (tag.selfClosing) {
        rest = remaining.substring(tag.end);
      } else {
        const closeIdx = findClose(remaining, tag.end, tag.name);
        if (closeIdx < 0) throw new RoseError("E-TEMPLATE", `unclosed <${tag.name}> - every component tag needs its matching close tag`, { hint: `add the matching </${tag.name}> (or close the tag with /> when it takes no children)` });
        childrenSrc = remaining.substring(tag.end, closeIdx);
        rest = remaining.substring(closeIdx + tag.name.length + 3);
      }
      const { def, named } = splitSlots(childrenSrc);
      const hasChildren = def.trim().length > 0;
      if (hasChildren) {
        result += `const __ch${id} = (__s, __c) => { let h = ''; ${compileTemplate(def, "h", "__c", scope, depth + 1, effMarkers, comps, islandDepth)} return h; };
`;
      }
      const slotFns = named.map(([nm, src]) => {
        const decl = entry.slots.find((s) => s.name === nm);
        let content = src;
        for (const p of decl?.props ?? []) {
          const pRe = new RegExp(`\\b${p}\\b`, "g");
          let out = "";
          let lastSpan = 0;
          for (const s of templateExprSpans(content)) {
            out += content.slice(lastSpan, s.start) + "{" + s.expr.replace(pRe, `__s.${p}`) + "}";
            lastSpan = s.end + 1;
          }
          content = out + content.slice(lastSpan);
        }
        return `${JSON.stringify(nm)}: (__s, __c) => { let h = ''; ${compileTemplate(content, "h", "__c", scope, depth + 1, effMarkers, comps, islandDepth)} return h; }`;
      });
      const propsObj = parseCompAttrs(tag.attrs).filter((a) => a.name !== "slot").map((a) => {
        if (a.kind === "spread") return `...(${a.value})`;
        const key = a.name.startsWith("on:") ? `on${capitalize(a.name.slice(3))}` : a.name;
        const val = a.kind === "expr" ? `(${a.value})` : a.kind === "str" ? JSON.stringify(a.value) : "true";
        return `${JSON.stringify(key)}: ${val}`;
      }).join(", ");
      const childrenArg = hasChildren ? `__ch${id}(${scope ?? "undefined"}, ${closes})` : `''`;
      result += `${acc} += ${tag.name}(${closes}, ${childrenArg}, { ${propsObj} }, { ${slotFns.join(", ")} });
`;
      remaining = rest;
    } else if (earliest.type === "island") {
      const [, name, hydrate, content] = earliest.match;
      const before = remaining.substring(0, earliest.index);
      if (before) result += emitChunk(before, acc, closes, scope);
      const hydrateAttr = hydrate === "visible" || hydrate === "idle" ? ` data-rv-island-hydrate="${hydrate}"` : "";
      result += `${acc} += ${JSON.stringify(`<div data-rv-island="${name || ""}"${hydrateAttr}>`)};
`;
      const inner = compileTemplate(content.trim(), "h", "__c", scope, depth + 1, markers, comps, islandDepth + 1);
      result += inner;
      result += `${acc} += '</div>';
`;
      remaining = remaining.substring(earliest.index + earliest.match[0].length);
    } else {
      const [, expr] = earliest.match;
      const trimmed = expr.trim();
      const before = remaining.substring(0, earliest.index);
      const constMatch = /^@const\s+([A-Za-z_$][\w$]*)\s*=\s*([\s\S]+)$/.exec(trimmed);
      if (constMatch) {
        if (before) result += emitChunk(before, acc, closes, scope);
        result += `const ${constMatch[1]} = (${constMatch[2].trim()});
`;
        remaining = remaining.substring(earliest.index + earliest.match[0].length);
        continue;
      }
      if (trimmed === "__slot__") {
        if (before) result += emitChunk(before, acc, closes, scope);
        result += compileSlot(acc);
        remaining = remaining.substring(earliest.index + earliest.match[0].length);
        continue;
      }
      const slotDefault = /^__slotDefault\(("(?:[^"\\]|\\.)*")\)$/.exec(trimmed);
      if (slotDefault) {
        if (before) result += emitChunk(before, acc, closes, scope);
        result += `${acc} += __slotDefault(children, ${slotDefault[1]});
`;
        remaining = remaining.substring(earliest.index + earliest.match[0].length);
        continue;
      }
      const slotCall = /^__slot\((['"])(\w+)\1, \[([\s\S]*?)\](?:,\s*("(?:[^"\\]|\\.)*"))?\)$/.exec(trimmed);
      if (slotCall) {
        if (before) result += emitChunk(before, acc, closes, scope);
        const fb = slotCall[4] ? `, ${slotCall[4]}` : "";
        result += `${acc} += __slotBlock(${closes}, __sl, ${JSON.stringify(slotCall[2])}, [${slotCall[3]}]${fb});
`;
        remaining = remaining.substring(earliest.index + earliest.match[0].length);
        continue;
      }
      const rawMatch = /^@html\s+([\s\S]+)$/.exec(trimmed);
      if (rawMatch) {
        if (before) result += emitChunk(before, acc, closes, scope);
        const expr2 = rawMatch[1].trim();
        if (!effMarkers) {
          result += `${acc} += String(${expr2} ?? '');
`;
        } else {
          const fn = scope ? `(${scope}) => (${expr2})` : `() => (${expr2})`;
          result += `${acc} += rawMark(${closes}, ${fn}${scope ? `, ${scope}` : ""});
`;
        }
        remaining = remaining.substring(earliest.index + earliest.match[0].length);
        continue;
      }
      const dbgMatch = /^@debug\b([\s\S]*)$/.exec(trimmed);
      if (dbgMatch) {
        if (before) result += emitChunk(before, acc, closes, scope);
        const names = dbgMatch[1].trim().replace(/,$/, "");
        result += names ? `console.log('[rosespan:debug]', { ${names} });
` : `console.log('[rosespan:debug]'); debugger;
`;
        remaining = remaining.substring(earliest.index + earliest.match[0].length);
        continue;
      }
      const renderMatch = /^@render\s+([A-Za-z_$][\w$]*)\s*\(([\s\S]*)\)\s*$/.exec(trimmed);
      if (renderMatch) {
        const ahead = new RegExp(`\\{#snippet\\s+${renderMatch[1]}\\b`).test(remaining.substring(earliest.index + earliest.match[0].length));
        if (ahead) {
          throw new RoseError(
            "E-TEMPLATE",
            `${filePath}: {@render ${renderMatch[1]}} runs before its {#snippet ${renderMatch[1]}} is defined`,
            { file: filePath, hint: "move the {#snippet} definition above the {@render} call - definitions register as the statement stream reaches them" }
          );
        }
        if (before) result += emitChunk(before, acc, closes, scope);
        const renderArgs = renderMatch[2].trim();
        result += `${acc} += ((__snip && __snip.${renderMatch[1]}) ? __snip.${renderMatch[1]}(${scope ?? "null"}, ${closes}${renderArgs ? ", " + renderArgs : ""}) : '');
`;
        remaining = remaining.substring(earliest.index + earliest.match[0].length);
        continue;
      }
      const attrMatch = before.match(/([\w-]+)=\s*$/);
      if (attrMatch) {
        const lit = before.slice(0, before.length - attrMatch[0].length);
        if (lit) result += emitChunk(lit, acc, closes, scope);
        result += emitAttr(attrMatch[1], trimmed, acc, closes, scope, effMarkers);
      } else {
        if (before) result += emitChunk(before, acc, closes, scope);
        const after = remaining.substring(earliest.index + earliest.match[0].length);
        const pair = after.length > 0 && !/^<[a-zA-Z/!]/.test(after) && !after.startsWith("{");
        result += emitText(trimmed, acc, closes, scope, effMarkers, pair);
      }
      remaining = remaining.substring(earliest.index + earliest.match[0].length);
    }
  }
  return result;
}
function scanTagEnd(src, start) {
  let j = start + 1;
  let quote = "";
  let brace = 0;
  while (j < src.length) {
    const c = src[j];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "{") brace++;
    else if (c === "}") brace = Math.max(0, brace - 1);
    else if (c === ">" && brace === 0) return j + 1;
    j++;
  }
  return -1;
}
function findCompTag(src, comps) {
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) return null;
    const nm = /^<([a-zA-Z][\w-]*)/.exec(src.slice(lt, lt + 64));
    if (nm && comps.has(nm[1])) {
      const end = scanTagEnd(src, lt);
      if (end > 0) {
        const raw = src.slice(lt, end);
        const selfClosing = /\/>$/.test(raw);
        return { start: lt, end, name: nm[1], attrs: raw.slice(1 + nm[1].length, selfClosing ? -2 : -1), selfClosing };
      }
    }
    i = lt + 1;
  }
  return null;
}
function findClose(src, from, name) {
  const re = new RegExp(`<(/?)${name}(?=[\\s/>])`, "g");
  re.lastIndex = from;
  let depth = 1;
  let m;
  while (m = re.exec(src)) {
    const end = scanTagEnd(src, m.index);
    if (end < 0) return -1;
    if (m[1] === "/") {
      depth--;
      if (depth === 0) return m.index;
    } else if (!/\/>$/.test(src.slice(m.index, end))) depth++;
  }
  return -1;
}
function parseCompAttrs(attrs) {
  const out = [];
  let i = 0;
  while (i < attrs.length) {
    const spread = /^\s*\{\.\.\.([^}]*)\}/.exec(attrs.slice(i));
    if (spread) {
      out.push({ name: "...", kind: "spread", value: spread[1].trim() });
      i += spread[0].length;
      continue;
    }
    const nm = /^\s*([\w:.-]+)/.exec(attrs.slice(i));
    if (!nm) break;
    i += nm[0].length;
    const eq = /^\s*=\s*/.exec(attrs.slice(i));
    if (!eq) {
      out.push({ name: nm[1], kind: "bool", value: "" });
      continue;
    }
    i += eq[0].length;
    const ch = attrs[i];
    if (ch === "{") {
      let depth = 1;
      let j = i + 1;
      while (j < attrs.length && depth > 0) {
        if (attrs[j] === "{") depth++;
        else if (attrs[j] === "}") depth--;
        j++;
      }
      out.push({ name: nm[1], kind: "expr", value: attrs.slice(i + 1, j - 1).trim() });
      i = j;
    } else if (ch === '"' || ch === "'") {
      const j = attrs.indexOf(ch, i + 1);
      out.push({ name: nm[1], kind: "str", value: attrs.slice(i + 1, j < 0 ? attrs.length : j) });
      i = j < 0 ? attrs.length : j + 1;
    } else break;
  }
  return out;
}
function rejectNestedSlot(src, outer) {
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) return;
    const nm = /^<(\/?)([a-zA-Z][\w-]*)/.exec(src.slice(lt, lt + 64));
    if (!nm) {
      i = lt + 1;
      continue;
    }
    const end = scanTagEnd(src, lt);
    if (end < 0) return;
    const hit = /\bslot\s*=\s*["'](\w+)["']/.exec(src.slice(lt, end));
    if (hit && nm[1] !== "/") {
      throw new RoseError("E-TEMPLATE", `slot="${hit[1]}" on <${nm[2]}> is nested inside slot="${outer}" - a slot must be a direct child of the component`, { hint: "move the inner <slot> out of the outer one - a slot is a direct child of the component tag, never nested in another slot" });
    }
    i = end;
  }
}
function splitSlots(src) {
  let def = "";
  const named = /* @__PURE__ */ new Map();
  let i = 0;
  let elemDepth = 0;
  let blockDepth = 0;
  const blockStack = [];
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    const ob = src.indexOf("{#", i);
    const cb = src.indexOf("{/", i);
    const cands = [lt, ob, cb].filter((x) => x >= 0);
    if (cands.length === 0) {
      def += src.slice(i);
      break;
    }
    const next = Math.min(...cands);
    if (next > i) def += src.slice(i, next);
    if (next === ob || next === cb) {
      const close = src.indexOf("}", next);
      const token = src.slice(next, close < 0 ? src.length : close + 1);
      if (next === ob) {
        const m = /^\{#(\w+)/.exec(token);
        blockStack.push({ header: token, type: m ? m[1] : "" });
        blockDepth++;
      } else {
        blockDepth = Math.max(0, blockDepth - 1);
        if (blockStack.length) blockStack.pop();
      }
      def += token;
      i = next + token.length;
      continue;
    }
    const nm = /^<(\/?)([a-zA-Z][\w-]*)/.exec(src.slice(next, next + 64));
    if (!nm) {
      def += "<";
      i = next + 1;
      continue;
    }
    const end = scanTagEnd(src, next);
    if (end < 0) {
      def += src.slice(next);
      break;
    }
    const tagText = src.slice(next, end);
    const selfClosing = /\/>$/.test(tagText);
    const isVoid = VOID_TAGS.has(nm[2].toLowerCase());
    if (nm[1] === "/") {
      elemDepth = Math.max(0, elemDepth - 1);
      def += tagText;
      i = end;
      continue;
    }
    if (!selfClosing && !isVoid) elemDepth++;
    const slotName = /\bslot\s*=\s*["'](\w+)["']/.exec(tagText)?.[1];
    if (slotName && elemDepth === 1 && blockDepth === 0) {
      if (selfClosing || isVoid) {
        named.set(slotName, (named.get(slotName) ?? "") + tagText.replace(/\s*slot\s*=\s*["']\w+["']/, ""));
      } else {
        const closeIdx = findClose(src, end, nm[2]);
        if (closeIdx < 0) throw new RoseError("E-TEMPLATE", `unclosed <${nm[2]}> inside slot="${slotName}"`, { hint: `add the matching </${nm[2]}>` });
        const tail = `</${nm[2]}>`;
        const inner = src.slice(end, closeIdx);
        rejectNestedSlot(inner, slotName);
        named.set(slotName, (named.get(slotName) ?? "") + tagText.replace(/\s*slot\s*=\s*["']\w+["']/, "") + inner + tail);
        elemDepth = Math.max(0, elemDepth - 1);
        i = closeIdx + tail.length;
        continue;
      }
      i = end;
      continue;
    }
    if (slotName && blockDepth > 0) {
      const stripped = tagText.replace(/\s*slot\s*=\s*["']\w+["']/, "");
      let lifted = "";
      for (const b of blockStack) lifted += b.header;
      lifted += stripped;
      if (selfClosing || isVoid) {
        for (let k = blockStack.length - 1; k >= 0; k--) lifted += `{/${blockStack[k].type}}`;
        named.set(slotName, (named.get(slotName) ?? "") + lifted);
        i = end;
        continue;
      }
      const closeIdx = findClose(src, end, nm[2]);
      if (closeIdx < 0) throw new RoseError("E-TEMPLATE", `unclosed <${nm[2]}> inside slot="${slotName}"`, { hint: `add the matching </${nm[2]}>` });
      const tail = `</${nm[2]}>`;
      lifted += src.slice(end, closeIdx) + tail;
      for (let k = blockStack.length - 1; k >= 0; k--) lifted += `{/${blockStack[k].type}}`;
      named.set(slotName, (named.get(slotName) ?? "") + lifted);
      elemDepth = Math.max(0, elemDepth - 1);
      i = closeIdx + tail.length;
      continue;
    }
    if (slotName) {
      throw new RoseError("E-TEMPLATE", `slot="${slotName}" on <${nm[2]}> must be a direct child of the component, or wrapped only by an {#if}/{#each}/{#boundary} block - it is nested inside another element`, {
        hint: 'place the element with slot="..." directly inside the component tag, or inside a single {#if}/{#each} block - wrapping it in another element is not yet supported'
      });
    }
    def += tagText;
    i = end;
  }
  return { def, named: [...named.entries()] };
}
function emitChunk(text, acc, closes, scope) {
  if (!text) return "";
  return `${acc} += ${JSON.stringify(text)};
`;
}
function emitOpenTag(openTag, acc, closes, scope) {
  const spans = templateExprSpans(openTag);
  if (spans.length === 0) return emitChunk(openTag, acc, closes, scope);
  let code = `${acc} += `;
  let last = 0;
  spans.forEach((s, k) => {
    const lit = openTag.slice(last, s.start);
    const fullValue = lit.endsWith("=");
    if (k > 0) code += " + ";
    code += JSON.stringify(fullValue ? lit + '"' : lit);
    code += ` + esc(${s.expr})`;
    if (fullValue) code += ` + '"'`;
    last = s.end + 1;
  });
  if (last < openTag.length) code += " + " + JSON.stringify(openTag.slice(last));
  return code + ";\n";
}
var IMG_RE = /<img\b(?:[^<>]|\{[^{}]*\})*>/g;
var IMG_MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};
var INLINE_IMG_MAX = 4096;
var INLINE_SVG_MAX = 16384;
function listImageVariants(publicDir, url) {
  const ext = path3.extname(url);
  const base = path3.basename(url, ext);
  const dirUrl = url.slice(0, url.length - (base + ext).length);
  let entries;
  try {
    entries = fs4.readdirSync(path3.join(publicDir, path3.dirname(url)));
  } catch {
    return [];
  }
  const re = new RegExp(
    "^" + base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\.w(\\d+)" + ext.replace(".", "\\.") + "$",
    "i"
  );
  const out = [];
  for (const e of entries) {
    const m = re.exec(e);
    const width = m ? Number(m[1]) : 0;
    if (width > 0) out.push({ url: `${dirUrl}${base}.w${width}${ext}`, width });
  }
  return out.sort((a, b) => a.width - b.width);
}
var __imgReadCache = /* @__PURE__ */ new Map();
function cachedImageRead(filePath2) {
  let st;
  try {
    st = fs4.statSync(filePath2);
  } catch {
    return null;
  }
  const hit = __imgReadCache.get(filePath2);
  if (hit && hit.mtime === st.mtimeMs) return { buffer: hit.buffer, dims: hit.dims };
  let buffer;
  try {
    buffer = fs4.readFileSync(filePath2);
  } catch {
    return null;
  }
  const dims = readImageSize(filePath2);
  const entry = { mtime: st.mtimeMs, buffer, dims };
  __imgReadCache.set(filePath2, entry);
  return { buffer, dims: entry.dims };
}
function inlineImages(template, publicDir) {
  return template.replace(IMG_RE, (tag) => {
    const src = tag.match(/\bsrc="(\/[^"{}]+)"/);
    if (!src) return tag;
    const ext = path3.extname(src[1]).toLowerCase();
    const mime = IMG_MIME[ext];
    if (!mime) return tag;
    const filePath2 = path3.join(publicDir, src[1]);
    const read = cachedImageRead(filePath2);
    if (!read) return tag;
    const file = read.buffer;
    const authorDims = /\swidth=/.test(tag) || /\sheight=/.test(tag);
    const dims = authorDims ? null : read.dims;
    const withDims = (t) => dims ? t.replace(/<img\b/, `<img width="${dims.width}" height="${dims.height}"`) : t;
    const inlineMax = ext === ".svg" ? INLINE_SVG_MAX : INLINE_IMG_MAX;
    if (file.length > inlineMax) {
      const hasSS = /\ssrcset=/.test(tag) || /\ssizes=/.test(tag);
      const variants = hasSS ? [] : listImageVariants(publicDir, src[1]);
      if (!variants.length) return withDims(tag);
      const srcset = variants.map((v) => `${v.url} ${v.width}w`).join(", ");
      return withDims(tag.replace(/<img\b/, `<img srcset="${srcset}"`));
    }
    const uri = ext === ".svg" ? `data:image/svg+xml,${file.toString("utf-8").replace(/%/g, "%25").replace(/#/g, "%23").replace(/"/g, "%22")}` : `data:${mime};base64,${file.toString("base64")}`;
    return withDims(tag.replace(src[0], `src="${uri}"`));
  });
}
function emitText(expr, acc, closes, scope, markers = true, pair = false) {
  if (!markers) {
    return `${acc} += esc(${expr});
`;
  }
  const fn = scope ? `(${scope}) => (${expr})` : `() => (${expr})`;
  let extra = pair ? ", 1" : scope ? ", 0" : "";
  if (scope) extra += `, ${scope}`;
  return `${acc} += textMark(${closes}, ${fn}${extra});
`;
}
var BOOLEAN_ATTRS = /* @__PURE__ */ new Set(["checked", "disabled", "readonly", "required", "selected", "multiple", "autofocus", "open"]);
function emitAttr(attr, expr, acc, closes, scope, markers = true) {
  if (!markers) {
    return `${acc} += '${attr}="' + esc(${expr}) + '"';
`;
  }
  const fn = scope ? `(${scope}) => (${expr})` : `() => (${expr})`;
  const arg = scope ? `, ${scope}` : "";
  if (BOOLEAN_ATTRS.has(attr)) {
    return `${acc} += boolAttrMark(${closes}, ${fn}, '${attr}'${arg});
`;
  }
  return `${acc} += attrMark(${closes}, ${fn}, '${attr}'${arg});
`;
}
function compileSlot(acc) {
  return `${acc} += String(children);
`;
}
var RUNTIME_IMPORTS = `import { state, setState, persistState, $data, hasState, isSeeded, markSeeded, esc, refresh, onMount, onCleanup, $effect, getContext, $query, $t, bestLocale, localeDir, ensureLocale, loadLocale, handlers, directives, $cookies, $sessionCookie, $store, $udp, $tcp, $listen, $websocket, $mqtt, parseLoRaWAN, ActionError, $actionError, $actionErrorOrThrow, $actionPending, $boundaryFallback, $setBoundaryError, $boundaryError, $append, $prepend, $merge, applyStateDeltas, textMark, attrMark, boolAttrMark, ifMark, eachMark, headMark, rawMark, slotBlockMark, redirect, notFound, aggregate, loader, encodeSdui, decodeSdui } from './runtime.js';`;
var API_RUNTIME_HELPERS = RUNTIME_IMPORTS.replace(/^import\s*\{/, "").replace(/\}\s*from[\s\S]*$/, "").split(",").map((s) => s.trim()).filter(Boolean);
function propsCode(props) {
  if (props.length === 0) return "";
  return props.map((p) => `const ${p.name} = __p.${p.name}${p.def ? ` ?? (${p.def})` : ""};`).join("\n");
}
var SLOT_HELPER = `const __slot = (sl, name, pairs) => {
  const fn = sl[name];
  if (typeof fn !== 'function') return null;
  const o = {};
  for (let i = 0; i < pairs.length; i++) o[pairs[i][0]] = pairs[i][1];
  return { o, fn };
};
const __slotBlock = (closes, sl, name, pairs, fallback) => {
  const hit = __slot(sl, name, pairs);
  if (hit) return slotBlockMark(closes, hit);
  return fallback || '';
};
const __slotDefault = (children, fallback) => {
  const c = children == null ? '' : String(children);
  if (c.trim()) return c;
  return fallback || '';
};`;
function generateSSR(script, templateFn, stateDeclsCode, exports = "", headFn = "", props = [], namedSlots = false, imports = "", isComponent = false, guard = "", hasActions = false, dataDeclsCode = "") {
  const headCode = headFn ? `
const __head = () => { let __hd = ''; ${headFn} return __hd; };
__html += headMark(closes, __head);` : "";
  const actionState = hasActions ? `
const $setState = (key, value) => setState(key, value);` : "";
  return `
${RUNTIME_IMPORTS}

${imports}

${exports}
${guard}
${actionState}

${namedSlots ? SLOT_HELPER : ""}

export ${isComponent ? "function" : "async function"} render(closes, children, __props, __slots) {
  ${props.length > 0 ? "const __p = __props || {};" : ""}
  ${namedSlots ? "const __sl = __slots || {};" : ""}
  ${propsCode(props)}
  ${script}
  ${stateDeclsCode}
  ${dataDeclsCode}
 
  ${isComponent ? "" : "applyStateDeltas();"}
  const __root = (__c, children) => { let h = ''; ${templateFn} return h; };
  let __html = ${isComponent ? "" : "await "}__root(closes, children);${headCode}
  return __html;
}
`;
}
function generateClient(script, templateFn, stateDeclsCode, eventBindings, exports = "", headFn = "", props = [], namedSlots = false, imports = "", isComponent = false, dataDeclsCode = "") {
  const handlerRegistry = eventBindings.length > 0 ? `Object.assign(handlers, { ${eventBindings.map((b) => b.fn).join(", ")} });` : "";
  const clientSetState = eventBindings.length > 0 ? `const $setState = (key, value) => setState(key, value);` : "";
  const headCode = headFn ? `
const __head = () => { let __hd = ''; ${headFn} return __hd; };
__html += headMark(closes, __head);` : "";
  return `
${RUNTIME_IMPORTS}

${imports}

${exports}
${clientSetState ? `
${clientSetState}
` : ""}
${namedSlots ? SLOT_HELPER : ""}

export ${isComponent ? "function" : "async function"} render(closes, children, __props, __slots) {
  ${props.length > 0 ? "const __p = __props || {};" : ""}
  ${namedSlots ? "const __sl = __slots || {};" : ""}
  ${propsCode(props)}
  ${script}
  ${stateDeclsCode}
  ${dataDeclsCode}
  ${handlerRegistry}
  const __root = (__c, children) => { let h = ''; ${templateFn} return h; };
  let __html = ${isComponent ? "" : "await "}__root(closes, children);${headCode}
  return __html;
}
`;
}
var layoutsOf = (infos, idx) => infos.map((li, i) => ({ li, i })).filter(({ li }) => li.isLayout && isAncestorDir(li.filePath, infos[idx].filePath)).sort((a, b) => b.li.filePath.length - a.li.filePath.length).map(({ i }) => i);
var routeShipsNoJs = (infos, compiled, i) => {
  if (compiled[i].csr === true) return false;
  if (compiled[i].needsClient) return false;
  return !layoutsOf(infos, i).some((li) => compiled[li].needsClient);
};
var routeShellOff = (infos, compiled, i) => compiled[i].shell === false || layoutsOf(infos, i).some((li) => compiled[li].shell === false);
function buildReport(infos, compiled) {
  return infos.map((info, i) => ({ info, i })).filter(({ info }) => !info.isLayout && !info.isNotFound && !info.isError && !info.isApi && !info.isMiddleware && !info.isComponent).map(({ info, i }) => {
    if (routeShipsNoJs(infos, compiled, i)) {
      return `${info.routePath}  zero-JS  nothing in the chain needs the client`;
    }
    const why = [i, ...layoutsOf(infos, i)].filter((ci) => compiled[ci].needsClient).map((ci) => `${(compiled[ci].clientReasons ?? ["needs the client"]).join(" + ")} in ${path3.basename(infos[ci].filePath)}`).join("; ");
    const forced = compiled[i].csr === true ? " (csr = true forces the bundle)" : "";
    return `${info.routePath}  client JS  ${why}${forced}`;
  });
}
var MOUNT_ENTRY = `

import { start, postForm } from '/client.js';

for (const el of document.querySelectorAll('[data-rosespan]')) {
  const route = el.getAttribute('data-rosespan');
  const doc = await fetch(route).then((r) => (r.ok ? r.text() : ''));
  const parsed = new DOMParser().parseFromString(doc, 'text/html');
  // A JS-shipping document wraps its content in #app; a zero-JS route's content is the body's own (no wrapper).
  const app = parsed.getElementById('app');
  if (app) {
    el.innerHTML = app.innerHTML;
  } else {
    for (const node of Array.from(parsed.body.children)) {
      if (!/^(?:SCRIPT|LINK|STYLE)$/.test(node.tagName)) el.appendChild(node);
    }
  }
  // start() resumes from #__rosespan_state (zero hydration), so the state
  const state = parsed.getElementById('__rosespan_state');
  if (state) el.appendChild(state);
  
  const rendered = state ? JSON.parse(state.textContent || '{}').__route : null;
  await start(el, route, rendered === route);
  if (state) state.remove();
  
  el.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href^="/"]');
    if (!a || !el.contains(a)) return;
    e.preventDefault();
    el.setAttribute('data-rosespan', a.getAttribute('href'));
    start(el, a.getAttribute('href'), false);
  });
  // Progressive-enhancement forms work inside a mount too: the native POST would replace the HOST page.
  el.addEventListener('submit', (e) => {
    const f = e.target;
    if (!f || f.tagName !== 'FORM' || f.hasAttribute('data-on-submit')) return;
    if ((f.getAttribute('method') || '').toLowerCase() !== 'post') return;
    e.preventDefault();
    postForm(new FormData(f), el, el.getAttribute('data-rosespan'));
  });
}
`;
var __writtenContent = /* @__PURE__ */ new Map();
var __writtenFor = null;
async function buildProject(root, outDir, opts = {}) {
  const minify = opts.minify !== false;
  const incremental = opts.incremental === true;
  await fs4.promises.mkdir(outDir, { recursive: true });
  const stale = (await fs4.promises.readdir(outDir)).filter((f) => /^(?:comp-\d+\.(?:ssr|client)|runtime|(?:server|client)-entry)\.js$/.test(f));
  await Promise.all(stale.map((f) => fs4.promises.rm(path3.join(outDir, f), { force: true })));
  const [pageFiles, compFiles] = await Promise.all([scanRoseFiles(root), scanComponentFiles(root)]);
  const files = [...pageFiles, ...compFiles];
  if (pageFiles.length === 0) {
    throw new RoseError(
      "E-ROUTE",
      `no .rose pages found under ${path3.join(root, "src", "pages")} - run rosespan from a project root, or pass one: rosespan build <dir>`,
      { file: path3.join(root, "src", "pages"), hint: "create src/pages/index.rose in that directory (or run the command from the project root)" }
    );
  }
  const infos = files.map((f) => ({ ...getRouteInfo(f, root) }));
  const config = await loadConfig(root);
  const plugins = config.plugins;
  const scopeKeys = files.map((f, i) => {
    const base = infos[i].isComponent ? path3.join(root, "src") : path3.join(root, "src", "pages");
    return path3.relative(base, f).replace(/\\/g, "/").replace(/\.rose$/, "");
  });
  const registry = new Map(
    files.map((f, i) => [f, { index: i, scopeKey: scopeKeys[i], slots: scanSlotDecls(f) }])
  );
  const compiled = await Promise.all(
    files.map((f, i) => compileComponentMemo(f, path3.join(root, "public"), scopeKeys[i], infos[i].isApi, plugins, registry))
  );
  const importsOf = /* @__PURE__ */ new Map();
  files.forEach((_, i) => {
    const list = [];
    for (const r of compiled[i].roseImports ?? []) {
      const abs = path3.resolve(path3.dirname(files[i]), r.specifier);
      const hit = registry.get(abs);
      if (hit) list.push(hit.index);
    }
    importsOf.set(i, list);
  });
  const needyDep = (i, seen = /* @__PURE__ */ new Set()) => {
    if (compiled[i].needsClient) return path3.basename(files[i]);
    if (seen.has(i)) return null;
    seen.add(i);
    for (const dep of importsOf.get(i) ?? []) {
      const hit = needyDep(dep, seen);
      if (hit) return hit;
    }
    return null;
  };
  compiled.forEach((c, i) => {
    if (c.needsClient) return;
    const who = needyDep(i);
    if (who) {
      c.needsClient = true;
      c.clientReasons = [...c.clientReasons ?? [], `imported component ${who} needs the client`];
    }
  });
  const reachable = /* @__PURE__ */ new Set();
  const visit = (i) => {
    if (reachable.has(i)) return;
    reachable.add(i);
    for (const r of compiled[i].roseImports ?? []) {
      const abs = path3.resolve(path3.dirname(files[i]), r.specifier);
      const hit = registry.get(abs);
      if (hit) visit(hit.index);
    }
  };
  files.forEach((_, i) => {
    if (!infos[i].isComponent) visit(i);
  });
  const styles = compiled.map((c, i) => reachable.has(i) && infos[i].isComponent ? c.style : "").filter(Boolean).join("\n");
  if (styles) await fs4.promises.writeFile(path3.join(outDir, "styles.css"), styles);
  else await fs4.promises.rm(path3.join(outDir, "styles.css"), { force: true });
  let locales = {};
  try {
    const localeDir = path3.join(root, "src", "locales");
    const localeFiles = (await fs4.promises.readdir(localeDir)).filter((f) => f.endsWith(".json"));
    const loaded = await Promise.all(localeFiles.map(async (f) => [f.slice(0, -5), JSON.parse(await fs4.promises.readFile(path3.join(localeDir, f), "utf-8"))]));
    locales = Object.fromEntries(loaded);
  } catch {
    locales = {};
  }
  const defaultLocale = locales.en ? "en" : Object.keys(locales).sort()[0] ?? "en";
  const localesJson = JSON.stringify(locales).replace(/</g, "\\u003c");
  const preload = config.i18n.preload ?? Object.keys(locales);
  const packed = Object.keys(locales).filter((l) => !preload.includes(l));
  for (const l of preload) {
    if (!locales[l]) console.warn(`RoseSpan: i18n.preload lists '${l}' but there is no src/locales/${l}.json - ignored`);
  }
  await fs4.promises.rm(path3.join(outDir, "locales"), { recursive: true, force: true });
  if (packed.length > 0) {
    const packDir = path3.join(outDir, "locales");
    await fs4.promises.mkdir(packDir, { recursive: true });
    for (const l of packed) await fs4.promises.writeFile(path3.join(packDir, `${l}.json`), JSON.stringify(locales[l]));
  }
  const clientLocales = Object.fromEntries(Object.keys(locales).filter((l) => !packed.includes(l)).map((l) => [l, locales[l]]));
  const clientLocalesJson = JSON.stringify(clientLocales).replace(/</g, "\\u003c");
  const buildRoot = path3.join(root, ".rosespan-build");
  const buildDir = path3.join(buildRoot, `${process.pid}-${__fnv1a(path3.resolve(root))}`);
  const dirExisted = fs4.existsSync(buildDir);
  await fs4.promises.mkdir(buildDir, { recursive: true });
  const stamp = /* @__PURE__ */ new Date();
  await fs4.promises.utimes(buildDir, stamp, stamp);
  if (!dirExisted || __writtenFor !== buildDir) {
    __writtenContent.clear();
    __writtenFor = buildDir;
  }
  sweepStaleBuildDirs(buildRoot);
  const contentSrcCands = [path3.join(path3.dirname(fileURLToPath(import.meta.url)), "..", "cli", "content.ts"), path3.join(path3.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli", "content.ts")];
  const contentSrc = contentSrcCands.find((c) => fs4.existsSync(c)) ?? contentSrcCands[0];
  fs4.copyFileSync(contentSrc, path3.join(buildDir, "content-md.ts"));
  const runtimePlugins = plugins.filter((p) => p && (p.onRequest || p.onResponse));
  if (runtimePlugins.length > 0) {
    const configRel = path3.relative(buildDir, path3.join(root, "rosespan.config.js")).replace(/\\/g, "/");
    await fs4.promises.writeFile(path3.join(buildDir, "plugins.js"), `
import config from ${JSON.stringify(configRel)};

const list = Array.isArray(config) ? config : [];
export const hooks = list
  .filter((p) => p && (p.onRequest || p.onResponse))
  .map((p) => ({ name: p.name, onRequest: p.onRequest ? p.onRequest.bind(p) : null, onResponse: p.onResponse ? p.onResponse.bind(p) : null }));

export const hasRequestHooks = hooks.some((p) => p.onRequest);
export const hasResponseHooks = hooks.some((p) => p.onResponse);
`);
  }
  const runtimeEntry = ["../runtime/index.ts", "../src/runtime/index.ts"].map((rel) => fileURLToPath(new URL(rel, import.meta.url))).find((p) => fs4.existsSync(p));
  if (!runtimeEntry) throw new RoseError("E-INTERNAL", "RoseSpan: the runtime source (src/runtime/index.ts) was not found next to the compiler", { hint: "the published package ships src/ beside dist-cli/ - reinstall it, or run from a checkout" });
  const runtimeBuild = runEsbuild(runtimeEntry, {
    entryPoints: [runtimeEntry],
    bundle: true,
    outfile: path3.join(buildDir, "runtime.js"),
    format: "esm",
    platform: "browser",
    write: true
  }, incremental);
  const prodEntry = (() => {
    const here = path3.dirname(fileURLToPath(import.meta.url));
    for (const cand of [path3.join(here, "..", "cli", "prod-server.ts"), path3.join(here, "..", "src", "cli", "prod-server.ts")]) {
      if (fs4.existsSync(cand)) return cand;
    }
    return path3.join(here, "..", "cli", "prod-server.ts");
  })();
  const prodBuild = incremental ? Promise.resolve({}) : runEsbuild(prodEntry, {
    entryPoints: [prodEntry],
    bundle: true,
    outfile: path3.join(outDir, "prod.mjs"),
    format: "esm",
    platform: "node",
    write: true,
    banner: {
      js: "import { createRequire } from 'node:module'; import { fileURLToPath as __f2p } from 'node:url'; import { dirname as __dn } from 'node:path'; const require = createRequire(import.meta.url); const __filename = __f2p(import.meta.url); const __dirname = __dn(__filename);"
    },
    ...TS_LOADER,
    ...minify ? { minify: true, keepNames: true } : {}
  }, incremental);
  runtimeBuild.catch(() => {
  });
  prodBuild.catch(() => {
  });
  const compWrites = [];
  const writeIfChanged = (name, content) => {
    if (__writtenContent.get(name) === content) return;
    __writtenContent.set(name, content);
    compWrites.push(fs4.promises.writeFile(path3.join(buildDir, name), content));
  };
  for (let i = 0; i < compiled.length; i++) {
    const src = compiled[i].api ?? compiled[i].ssr;
    writeIfChanged(`comp-${i}.ssr.js`, src);
    if (!infos[i].isApi) {
      writeIfChanged(`comp-${i}.client.js`, compiled[i].client);
    }
  }
  for (let c = 0; c < compWrites.length; c += 64) {
    await Promise.all(compWrites.slice(c, c + 64));
  }
  const pages = infos.map((info, i) => ({ info, i })).filter(({ info }) => !info.isLayout && !info.isNotFound && !info.isError && !info.isApi && !info.isMiddleware && !info.isComponent).sort((a, b) => {
    const rank = (pattern) => {
      const segs = pattern.split("/");
      return [
        segs.filter((s) => s.startsWith("**")).length,
        segs.filter((s) => s.startsWith("*")).length,
        segs.filter((s) => s.startsWith(":")).length
      ];
    };
    const ra = rank(a.info.pattern);
    const rb = rank(b.info.pattern);
    for (let k = 0; k < 3; k++) if (ra[k] !== rb[k]) return ra[k] - rb[k];
    return a.info.filePath < b.info.filePath ? -1 : 1;
  });
  const apiRoutes = infos.map((info, i) => ({ info, i })).filter(({ info }) => info.isApi).sort((a, b) => {
    const rank = (pattern) => {
      const segs = pattern.split("/");
      return [
        segs.filter((s) => s.startsWith("**")).length,
        segs.filter((s) => s.startsWith("*")).length,
        segs.filter((s) => s.startsWith(":")).length
      ];
    };
    const ra = rank(a.info.pattern);
    const rb = rank(b.info.pattern);
    for (let k = 0; k < 3; k++) if (ra[k] !== rb[k]) return ra[k] - rb[k];
    return a.info.filePath < b.info.filePath ? -1 : 1;
  });
  const compose = (idx) => {
    let expr = `render_${idx}`;
    for (const i of layoutsOf(infos, idx)) {
      expr = `(async (closes, children) => await render_${i}(closes, await (${expr})(closes, children)))`;
    }
    return expr;
  };
  const bundleMode = compiled.find((c) => c.bundle)?.bundle ?? "inline";
  const split = bundleMode === "split";
  const chainOf = (idx) => [idx, ...layoutsOf(infos, idx)];
  const loaderInner = (idx) => `load: () => loadChain([${chainOf(idx).map((i) => `() => import('./comp-${i}.client.js')`).join(", ")}])`;
  const loaderOf = (idx) => `{ ${loaderInner(idx)} }`;
  const routeNoJs = (i) => routeShipsNoJs(infos, compiled, i);
  const serverImports = compiled.map((_, i) => {
    if (!reachable.has(i)) return "";
    if (infos[i].isMiddleware) {
      return `import * as middlewareMod from './comp-${i}.ssr.js';`;
    }
    if (infos[i].isApi) {
      const names2 = compiled[i].apiMethods ?? [];
      const handlerImports = names2.map((n) => `${n} as ${n}_${i}`).join(", ");
      return handlerImports ? `import { ${handlerImports} } from './comp-${i}.ssr.js';` : `import './comp-${i}.ssr.js';`;
    }
    const isPage = !infos[i].isLayout && !infos[i].isNotFound;
    const names = isPage ? compiled[i].actionNames : [];
    const actionImports = names.map((n) => `${n} as ${n}_${i}`).join(", ");
    const guardImport = isPage && compiled[i].guardName ? `beforeAction as beforeAction_${i}` : "";
    const named = [actionImports, guardImport].filter(Boolean).join(", ");
    return named ? `import { render as render_${i}, ${named} } from './comp-${i}.ssr.js';` : `import { render as render_${i} } from './comp-${i}.ssr.js';`;
  }).join("\n");
  const notFoundEntries = infos.map((info, i) => ({ info, i })).filter(({ info }) => info.isNotFound).map(({ info, i }) => {
    const rel = path3.relative(path3.join(root, "src", "pages"), info.filePath).replace(/\\/g, "/");
    const dir = path3.posix.dirname(rel);
    const prefix = dir === "." ? "/" : "/" + dir;
    const f = [];
    if (routeShellOff(infos, compiled, i)) f.push("shell: false");
    if (routeShipsNoJs(infos, compiled, i)) f.push("csr: false");
    const flags = f.length ? `, { ${f.join(", ")} }` : "";
    return { prefix, render: compose(i), flags };
  }).sort((a, b) => b.prefix.length - a.prefix.length);
  const notFoundTable = `[
${notFoundEntries.map((e) => `  ['${e.prefix}', ${e.render}${e.flags}],`).join("\n")}
]`;
  const errIdx = infos.findIndex((info) => info.isError);
  const errorRender = errIdx >= 0 ? compose(errIdx) : "null";
  const errorNoJs = errIdx >= 0 ? routeShipsNoJs(infos, compiled, errIdx) : false;
  const middlewareIdx = infos.findIndex((info) => info.isMiddleware);
  const serverRoutes = pages.map(({ info, i }) => {
    const actionMap = compiled[i].actionNames.map((n) => `${n}: ${n}_${i}`).join(", ");
    if (compiled[i].csr === false && compiled[i].needsClient) {
      throw new RoseError(
        "E-EXPORT",
        `${info.filePath}: csr = false but this route needs the client bundle (${(compiled[i].clientReasons ?? ["needs the client"]).join(" + ")}).`,
        { file: info.filePath, hint: "remove csr = false (the compiler decides zero-JS by itself), or remove the client-only code listed above" }
      );
    }
    if (compiled[i].csr === false) {
      const needy = layoutsOf(infos, i).find((li) => compiled[li].needsClient);
      if (needy !== void 0) {
        throw new RoseError(
          "E-EXPORT",
          `${info.filePath}: csr = false cannot ship under ${infos[needy].filePath} - the layout needs the client bundle (event wiring, onMount/onCleanup, refresh() or a server action).`,
          { file: info.filePath, hint: "a layout needing the runtime bundles every route under it - drop csr = false here, or make the layout content-only" }
        );
      }
    }
    const csrFlag = routeNoJs(i) ? ", csr: false" : "";
    const shellFlag = routeShellOff(infos, compiled, i) ? ", shell: false" : "";
    const bufferFlag = compiled[i].buffer ? ", buffer: true" : "";
    const signalFlag = compiled[i].controlSignal ? ", signal: true" : "";
    const guardFlag = compiled[i].guardName ? `, guard: beforeAction_${i}` : "";
    return `{ pattern: '${info.pattern}', path: '${info.routePath}', render: ${compose(i)}, actions: ${actionMap ? `{ ${actionMap} }` : "null"}${guardFlag}${csrFlag}${shellFlag}${bufferFlag}${signalFlag} }`;
  }).join(",\n  ");
  const appUsesAuth = compiled.some((c) => c.usesRoseSpanAuth);
  const appUsesNet = compiled.some((c) => /\$(?:udp|tcp|listen|mqtt)\s*\(/.test((c.ssr || "") + (c.client || "") + (c.api || "")));
  const appUsesWs = compiled.some((c) => /\$websocket\s*\(/.test((c.ssr || "") + (c.client || "") + (c.api || "")));
  const serverEntry = `
${serverImports}
import { renderMarkdown } from './content-md.ts';
${appUsesAuth ? "import crypto from 'node:crypto';" : "// no route references __rosespanAuth: the node:crypto auth helpers are omitted, keeping the bundle edge-loadable"}
${appUsesNet ? "import * as __rosespanDgram from 'node:dgram';\nimport * as __rosespanNet from 'node:net';" : "// no route opens a network listener ($udp/$tcp/$listen): the node:dgram/node:net imports are omitted, keeping the bundle edge-loadable"}
${appUsesWs ? "import * as __rosespanHttp from 'node:http';\nimport * as __rosespanCrypto from 'node:crypto';" : "// no route opens a WebSocket server ($websocket): the node:http/node:crypto imports are omitted, keeping the bundle edge-loadable"}
import { setState, persistState, clearRequestState, isolateRender, serializeState, resetRequestContext, installContextStore, setRequestQuery, getRequestQuery, isLocale, setLocales, localeList, localeDir, setStoreTransport, applyStorePatch, ActionError, StateDelta, setStateDelta, esc, __startNetwork, __stopNetwork, $udp, $tcp, $listen, $websocket, $mqtt } from './runtime.js';
export { __startNetwork, __stopNetwork };
${runtimePlugins.length > 0 ? `import { hooks as __pluginHooks, hasRequestHooks as __hasRequestHooks, hasResponseHooks as __hasResponseHooks } from './plugins.js';` : `// no plugin declares a runtime hook, so there is no plugins
// module to import - the runners below stay no-ops and the servers call them
// unconditionally (one code path, no flags to keep in sync).
const __pluginHooks = [];
const __hasRequestHooks = false;
const __hasResponseHooks = false;`}


export async function runRequestHooks(ctx) {
  for (const p of __pluginHooks) {
    if (!p.onRequest) continue;
    try {
      const r = await p.onRequest(ctx);
      if (r instanceof Response) return r;
    } catch (err) {
      console.error('RoseSpan: plugin', p.name, 'onRequest failed:', err instanceof Error ? err.message : err);
    }
  }
  return null;
}

export async function runResponseHooks(ctx, res) {
  let out = res;
  for (const p of __pluginHooks) {
    if (!p.onResponse) continue;
    try {
      const r = await p.onResponse(ctx, out);
      if (r instanceof Response) out = r;
    } catch (err) {
      console.error('RoseSpan: plugin', p.name, 'onResponse failed:', err instanceof Error ? err.message : err);
    }
  }
  return out;
}


export const hasRequestHooks = __hasRequestHooks;
export const hasResponseHooks = __hasResponseHooks;

// P0-1: the query of the request being rendered, for $query().
export function setQuery(query) {
  setRequestQuery(query || {});
}


setLocales(${localesJson}, '${defaultLocale}');


// Live store channel: every $store write fans out to the browsers holding an open
// SSE connection AND (when forked) to sibling workers. The client set lives on
// globalThis so a dev hot-re-import (a fresh module instance) keeps serving the
// same live connections. __addStoreClient/__removeStoreClient are called by the
// host (cli serve worker / devWrap) as SSE connections open and close.
const __storeClients: Set<any> = (globalThis as any).__rosespan_storeClients || ((globalThis as any).__rosespan_storeClients = new Set());
function __broadcastStore(name: string, value: unknown): void {
  if (__storeClients.size === 0) return;
  const frame = 'event: store\\ndata: ' + JSON.stringify({ name: name, value: value }) + '\\n\\n';
  for (const res of __storeClients) {
    try { res.write(frame); } catch { __storeClients.delete(res); }
  }
}
setStoreTransport((name, value) => {
  __broadcastStore(name, value);
  if (typeof process !== 'undefined' && typeof process.send === 'function') process.send({ type: 'rosespan:store', name, value });
});
if (typeof process !== 'undefined' && typeof process.send === 'function') {
  process.on('message', (msg) => {
    if (msg && msg.type === 'rosespan:store') {
      applyStorePatch(msg.name, msg.value);
      __broadcastStore(msg.name, msg.value);
    }
  });
}
export function __addStoreClient(res: any): void { __storeClients.add(res); }
export function __removeStoreClient(res: any): void { __storeClients.delete(res); }


// (the cross-machine seam): the cluster relay above covers ONE machine.
export function __installStoreTransport(send: (name: string, value: unknown) => void): void {
  // Wrap, not replace: a cross-machine transport (a plugin's LISTEN/NOTIFY bus)
  // still fans out to this machine's live browsers on every patch.
  setStoreTransport((name, value) => { __broadcastStore(name, value); send(name, value); });
}
export function __deliverStorePatch(name: string, value: unknown): void {
  applyStorePatch(name, value);
  __broadcastStore(name, value);
}

export { localeList };
export const defaultLocale = '${defaultLocale}';

// Route params maps, re-exported for the build's prerender step: routePath -> the component's exported params (a static map or a function).
${pages.filter(({ i }) => compiled[i].hasParams).map(({ i }) => `import * as comp_${i} from './comp-${i}.ssr.js';`).join("\n")}

export const routeParams = {
  ${pages.filter(({ info, i }) => compiled[i].hasParams).map(({ info, i }) => `'${info.routePath}': comp_${i}.params`).join(",\n  ")}
};

// Routes whose component reads the request context (getContext()), mutates a shared store ($store()), reads the query ($query(), P0-1)
export const dynamicRoutes = [
  ${pages.filter(({ i }) => compiled[i].usesContext || compiled[i].cspNonce || compiled[i].buffer || compiled[i].controlSignal || compiled[i].needsClient).map(({ info }) => `'${info.routePath}'`).join(",\n  ")}
];

// Routes that the prerender function should skip (not bake into static files).
export const prerenderSkipRoutes = [
  ${pages.filter(({ i }) => compiled[i].usesContext || compiled[i].cspNonce || compiled[i].buffer || compiled[i].controlSignal).map(({ info }) => `'${info.routePath}'`).join(",\n  ")}
];

// Which api routes opt into build-time baking (export const prerender = true): routePath -> boolean.
${apiRoutes.filter(({ i }) => compiled[i].hasPrerender).map(({ i }) => `import * as api_${i} from './comp-${i}.ssr.js';`).join("\n")}

export const apiPrerender = {
  ${apiRoutes.map(({ info, i }) => `'${info.routePath}': ${compiled[i].hasPrerender ? `api_${i}.prerender === true` : "false"}`).join(",\n  ")}
};


export const revalidate = [
  ${pages.filter(({ i }) => compiled[i].revalidate !== void 0 && !compiled[i].usesContext).map(({ info, i }) => `{ pattern: '${info.pattern}', seconds: ${compiled[i].revalidate} }`).join(",\n  ")}
];

// Per-request render memo (export const cache = N): a dynamic route's whole renderPage result is memoized for N seconds.
export const routeCaches = [
  ${pages.filter(({ i }) => compiled[i].cache !== void 0).map(({ info, i }) => `{ pattern: '${info.pattern}', seconds: ${compiled[i].cache} }`).join(",\n  ")}
];
const __dynCache = new Map();
export function invalidateRenderCache(): void {
  __dynCache.clear();
}


// Application KV cache primitive (server-side, per-worker in-memory): a zero-dependency store for expensive computations.
const __kvStore = new Map<string, { v: unknown; exp: number }>();
// Content collections: src/content/<coll>/*.md scanned once at build time,
const contentCollections = ${JSON.stringify(scanContentDir(path3.join(root, "src", "content")))};
export const kv = {
  get(key: string): unknown {
    const e = __kvStore.get(key);
    if (!e) return undefined;
    if (e.exp < Date.now()) { __kvStore.delete(key); return undefined; }
    return e.v;
  },
  set(key: string, value: unknown, ttlSeconds = 300): void {
    if (__kvStore.size > 1000) {
      const cutoff = Date.now();
      for (const [k, e] of __kvStore) { if (e.exp < cutoff) __kvStore.delete(k); }
      if (__kvStore.size > 2000) __kvStore.clear(); 
    }
    __kvStore.set(key, { v: value, exp: Date.now() + ttlSeconds * 1000 });
  },
  del(key: string): void { __kvStore.delete(key); },
  has(key: string): boolean {
    const e = __kvStore.get(key);
    return !!e && e.exp >= Date.now();
  },
};
globalThis.__rosespanKvApi = { kv, kvMemo: $kv };
globalThis.__rosespanContent = {
  list: (coll: string, filter?: { tag: string }) => {
    let items = contentCollections[coll] ?? [];
    if (filter?.tag) items = items.filter((e) => ((e.frontmatter.tags as string[] | undefined) ?? []).includes(filter.tag));
    return items.map((e) => ({ slug: e.slug, ...e.frontmatter }));
  },
  rss: (coll: string, opts: { title: string; origin: string; description?: string }) => {
    return buildRss(contentCollections[coll] ?? [], opts);
  },
  get: (coll: string, slug: string, vars?: Record<string, unknown>) => {
    const e = (contentCollections[coll] ?? []).find((x) => x.slug === slug);
    if (!e) return null;
    return { slug: e.slug, ...e.frontmatter, html: renderMarkdown(e.body, vars), toc: e.toc, readingTime: e.readingTime, wordCount: e.wordCount, excerpt: e.excerpt };
  },
};

const v = {
  validate(body: Record<string, unknown>, rules: Record<string, string[]>): { ok: boolean; errors: Record<string, string>; values: Record<string, unknown> } {
    const errors: Record<string, string> = {};
    const values: Record<string, unknown> = {};
    for (const [field, ruleList] of Object.entries(rules)) {
      let val = body[field];
      for (const rule of ruleList) {
        if (val === undefined || val === null || val === "") {
          if (rule === "required") errors[field] = field + " is required";
          else if (rule.startsWith("default:")) val = rule.slice(8);
          continue;
        }
        if (rule === "string") val = String(val);
        else if (rule === "trim") val = String(val).trim();
        else if (rule === "number") {
          const num = Number(val);
          if (Number.isNaN(num)) errors[field] = field + " must be a number";
          else val = num;
        } else if (rule === "email") {
          if (!/^[^s@]+@[^s@]+.[^s@]+$/.test(String(val))) errors[field] = field + " must be a valid email";
        } else if (rule.startsWith("min:")) {
          const min = Number(rule.slice(4));
          if (typeof val === "number" ? val < min : String(val).length < min) errors[field] = field + " must be at least " + min;
        } else if (rule.startsWith("max:")) {
          const max = Number(rule.slice(4));
          if (typeof val === "number" ? val > max : String(val).length > max) errors[field] = field + " must be at most " + max;
        }
      }
      values[field] = val;
    }
    return { ok: Object.keys(errors).length === 0, errors, values };
  },
};

const jobs = {
  _timers: new Map<string, ReturnType<typeof setInterval>>(),
  every(name: string, seconds: number, fn: () => void | Promise<void>): void {
    if (this._timers.has(name)) return;
    const t = setInterval(() => { Promise.resolve(fn()).catch(() => {}); }, seconds * 1000);
    this._timers.set(name, t as any);
  },
  cancel(name: string): void {
    const t = this._timers.get(name);
    if (t) { clearInterval(t); this._timers.delete(name); }
  },
  cancelAll(): void { for (const t of this._timers.values()) clearInterval(t); this._timers.clear(); }
};

function sse(handler: (send: (event: string, data: unknown) => void) => Promise<void> | void): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        controller.enqueue(encoder.encode("event: " + event + "\\ndata: " + JSON.stringify(data) + "\\n\\n"));
      };
      try {
        await handler(send);
      } finally {
        closed = true;
        try { controller.close(); } catch {  }
      }
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", "connection": "keep-alive" },
  });
}
${appUsesNet ? `// The isomorphic runtime's $udp/$tcp reach Node's dgram/net only through these globals; injecting them at server boot is what lets __startNetwork() turn a registered spec into a bound socket.
(globalThis as any).__rosespan_dgram = __rosespanDgram;
(globalThis as any).__rosespan_net = __rosespanNet;` : ""}
${appUsesWs ? `// The isomorphic runtime's $websocket performs the RFC 6455 handshake (sha1) on a node:http upgrade socket; both reach it only through these globals.
(globalThis as any).__rosespan_http = __rosespanHttp;
(globalThis as any).__rosespan_crypto = __rosespanCrypto;` : ""}
globalThis.__rosespanExtras = { v, jobs, sse, udp: $udp, tcp: $tcp, listen: $listen, websocket: $websocket, mqtt: $mqtt };
${appUsesAuth ? `
const auth = {
  hashPassword(password: string): string {
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.scryptSync(password, salt, 32).toString("hex");
    return salt + ":" + hash;
  },
  verifyPassword(password: string, stored: string): boolean {
    const [salt, hash] = stored.split(":");
    if (!salt || !hash) return false;
    return crypto.timingSafeEqual(Buffer.from(hash, "hex"), crypto.scryptSync(password, salt, 32));
  },
  signSession(data: Record<string, unknown>, secret: string, ttlSeconds = 86400): string {
    const payload = Buffer.from(JSON.stringify({ ...data, exp: Date.now() + ttlSeconds * 1000 })).toString("base64url");
    const sig = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
    return payload + "." + sig;
  },
  verifySession<T = Record<string, unknown>>(token: string, secret: string): T | null {
    const dot = token.lastIndexOf(".");
    if (dot < 0) return null;
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expect = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
    try {
      if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
    } catch { return null; }
    try {
      const data = JSON.parse(Buffer.from(payload, "base64url").toString());
      if (data.exp < Date.now()) return null;
      return data as T;
    } catch { return null; }
  },
  csrfToken(secret: string, sessionId: string): string {
    return crypto.createHmac("sha256", secret).update(sessionId).digest("hex");
  },
  verifyCsrf(token: string, secret: string, sessionId: string): boolean {
    try {
      return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(this.csrfToken(secret, sessionId)));
    } catch { return false; }
  },
};
globalThis.__rosespanAuth = auth;
` : "// __rosespanAuth helpers omitted: no route references them (keeps the bundle free of node:crypto and edge-loadable)"}

// Concurrent missers on a cold key share ONE compute through this inflight map - the check-then-set shape alone lets N simultaneous cold readers hammer.
const __kvInflight = new Map<string, Promise<unknown>>();
export async function $kv(key: string, compute: () => unknown | Promise<unknown>, ttlSeconds = 300): Promise<unknown> {
  const hit = kv.get(key);
  if (hit !== undefined) return hit;
  let p = __kvInflight.get(key);
  if (!p) {
    p = (async () => {
      const v = await compute();
      if (v !== undefined) kv.set(key, v, ttlSeconds);
      return v;
    })();
    __kvInflight.set(key, p);
    p.finally(() => { __kvInflight.delete(key); }).catch(() => {});
  }
  return p;
}
export function isCachedRoute(pathname: string): boolean {
  return routeClass(pathname).cache !== null;
}
export function invalidatePath(pathname: string): number {
  let n = 0;
  for (const key of [...__dynCache.keys()]) {
    if (key.startsWith(pathname + '|')) { __dynCache.delete(key); n++; }
  }
  return n;
}
export function peekRenderCache(pathname: string, cookieHeader: string, search = ''): ReturnType<typeof renderPage> | null {
  const cfg = routeClass(pathname).cache;
  if (!cfg) return null;
  let h = 0x811c9dc5;
  const c = cookieHeader || '';
  for (let i = 0; i < c.length; i++) {
    h ^= c.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  // The query string is part of the cache key: routes like /search?q= or /archives?year= render different documents per query.
  const hit = __dynCache.get(pathname + '|' + (search || '') + '|' + h.toString(16));
  return hit && hit.expires > Date.now() ? hit.page : null;
}
export async function renderPageCached(pathname: string, cookieHeader: string, search = ''): Promise<ReturnType<typeof renderPage>> {
  const cfg = routeClass(pathname).cache;
  if (!cfg) return renderPage(pathname);
  let h = 0x811c9dc5;
  for (let i = 0; i < cookieHeader.length; i++) {
    h ^= cookieHeader.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  const key = pathname + '|' + (search || '') + '|' + h.toString(16);
  const hit = __dynCache.get(key);
  if (hit && hit.expires > Date.now()) {
    __dynCache.delete(key);
    __dynCache.set(key, hit);
    return hit.page;
  }
  // Stale-while-revalidate: an EXPIRED entry still answers instantly while one background render refreshes it - the TTL boundary never spikes.
  if (hit && !hit.refreshing) {
    hit.refreshing = true;
    // BUG.md A: this refresh runs AFTER the live response returned, so the module-global
    // requestQuery may already belong to a later request. Re-seed it from THIS entry's
    // search and restore the snapshot afterward, so the cached refresh reflects this query.
    const __q: Record<string, string> = {};
    new URLSearchParams(search || '').forEach((v, k) => { __q[k] = v; });
    const __prevQ = getRequestQuery();
    setRequestQuery(__q);
    renderPage(pathname).then((fresh: any) => {
      setRequestQuery(__prevQ);
      if (fresh.status === 200 && !fresh.redirect) {
        __dynCache.set(key, { page: fresh, expires: Date.now() + cfg.seconds * 1000 });
      } else {
        __dynCache.delete(key);
      }
    }).catch(() => { setRequestQuery(__prevQ); __dynCache.delete(key); });
    return hit.page;
  }
  // Miss: render with this request's query. The caller (edge/cli) already seeded
  // requestQuery; re-seed from the key's search so the cached entry stays self-consistent
  // even if a concurrent request overwrote the global during the await.
  const __q0: Record<string, string> = {};
  new URLSearchParams(search || '').forEach((v, k) => { __q0[k] = v; });
  setRequestQuery(__q0);
  const page = await renderPage(pathname);
  if (page.status === 200 && !page.redirect) {
    __dynCache.set(key, { page, expires: Date.now() + cfg.seconds * 1000 });
    if (__dynCache.size > 300) {
      __dynCache.delete(__dynCache.keys().next().value as string);
    }
  }
  return page;
}

// Pages/_middleware.rose: a Web-standard request handler that runs before every render on the server (pages, POSTs, api calls alike).
export const middleware = ${middlewareIdx >= 0 ? "middlewareMod.handle ?? null" : "null"};

// Routes whose DOCUMENTS ship without the client bundle ( decided by the compiler since #29): HTML + CSS only - no runtime, no state script.
export const noJsRoutes = [
  ${pages.filter(({ i }) => routeNoJs(i)).map(({ info }) => `'${info.pattern}'`).join(",\n  ")}
];

export function isNoJs(pathname) {
  return routeClass(pathname).noJs;
}

// P0-2 (bug report): routes that exported "buffer = true".
export function isBuffered(pathname) {
  return routeClass(pathname).buffered;
}


export const routeHeaders = [
  ${pages.filter(({ i }) => compiled[i].headers).map(({ info, i }) => `{ pattern: '${info.pattern}', headers: ${JSON.stringify(compiled[i].headers)} }`).join(",\n  ")}
];

export function headersFor(pathname) {
  return routeClass(pathname).headers;
}


export const cspNonceRoutes = [
  ${pages.filter(({ i }) => compiled[i].cspNonce).map(({ info }) => `'${info.routePath}'`).join(",\n  ")}
];

export function cspNonce(pathname) {
  return routeClass(pathname).nonce;
}

// A Web-standard Request from whatever the host provides: the edge adapter passes one already; the Node server passes its IncomingMessage (plus).
function toWebRequest(raw, form) {
  if (raw instanceof Request) return raw;
  const init = { method: raw.method || 'GET', headers: new Headers(raw.headers || {}) };
  if (form) init.body = form;
  let u = raw.url || '/';
  if (u.startsWith('http://') || u.startsWith('https://')) {
    try { const p = new URL(u); u = p.pathname + p.search; } catch { u = '/'; }
  }
  return new Request('http://' + (raw.headers?.host || 'localhost') + u, init);
}


export async function runMiddleware(rawReq, form) {
  resetRequestContext();
  if (!middleware || !rawReq) return null;
  const res = await middleware(toWebRequest(rawReq, form));
  return res || null;
}

const routes = [
  ${serverRoutes}
];

// API routes (pages/api/*.rose): pattern -> HTTP-method handlers. They never render HTML and never reach the client bundle.
const apiRoutes = [
  ${apiRoutes.map(({ info, i }) => {
    const handlers = (compiled[i].apiMethods ?? []).map((n) => `${n}: ${n}_${i}`).join(", ");
    return `{ pattern: '${info.pattern}', path: '${info.routePath}', handlers: { ${handlers} } }`;
  }).join(",\n  ")}
];

// Not-found pages, deepest segment first: the root 404.rose ('/') and any
// pages/<seg>/_notfound.rose, each already composed with its layout chain.
// notFoundFor picks the nearest one up the path - an /admin miss answers
// the admin 404, a public miss the site's - and notFoundPage is the whole
// answer (real 404 status, or the built-in plain 404 when the app has none).
const notFoundRoutes = ${notFoundTable};
const notFoundFor = (pathname) => {
  for (const [prefix, render] of notFoundRoutes) {
    if (prefix === '/' || pathname === prefix || pathname.startsWith(prefix + '/')) return render;
  }
  return null;
};

const notFoundFlags = (pathname) => {
  for (const [prefix, render, flags] of notFoundRoutes) {
    if (prefix === '/' || pathname === prefix || pathname.startsWith(prefix + '/')) return flags || null;
  }
  return null;
};
const notFoundPage = async (pathname) => {
  const nf = notFoundFor(pathname);
  if (nf) {
    const flags = notFoundFlags(pathname) || {};
    // A zero-JS not-found document carries no state script (the shell drops it)
    const noJs = flags.csr === false;
    const page = await renderFallback(pathname, nf, noJs);
    // __notFound stamps the document so the client boot paints THIS route instead of re-rendering the matched one: a catch-all whose resolver threw.
    return { ...page, ...flags, status: 404, state: noJs ? '{}' : JSON.stringify({ __notFound: true, ...JSON.parse(page.state) }) };
  }
  return { html: '<h1>404</h1><p>Page not found</p>', state: JSON.stringify({ __route: pathname, __notFound: true }), head: [], status: 404, ...docAttrs(pathname) };
};


const errorPage = ${errorRender};


export function docAttrs(pathname) {
  const c = routeClass(pathname);
  return { lang: c.lang, dir: c.dir };
}

// Paint a fallback page (404/500) and serialize its state.
async function renderFallback(pathname, render, noJs = false) {
  // Split mode: the not-found entry's render is a loader object \u2014 resolve it through getRender (which memoizes the composed function) exactly like.
  let fn = render;
  if (typeof fn !== 'function' && fn && typeof fn.load === 'function') {
    
    fn = (await fn.load()).render;
  }
  const { html, head } = extractHead(await fn([], ''));
  const state = noJs ? '{}' : JSON.stringify({ __route: pathname, ...JSON.parse(serializeState()) });
  return { html, state, head, ...docAttrs(pathname) };
}

export function matchRoute(pattern, pathname) {
  // Q0 (bug report): one canonical URL per route.
  pathname = pathname.replace(/\\/+$/, '') || '/';
  const patternParts = pattern.split('/');
  const pathParts = pathname.split('/');
  
  const last = patternParts[patternParts.length - 1];
  if (last && (last.startsWith('*') || last.startsWith('**'))) {
    const fixed = patternParts.slice(0, -1);
    if (pathParts.length < fixed.length) return false;
    if (last.startsWith('*') && !last.startsWith('**') && pathParts.length === fixed.length) return false;
    for (let i = 0; i < fixed.length; i++) {
      if (fixed[i].startsWith(':')) continue;
      if (fixed[i] !== pathParts[i]) return false;
    }
    return true;
  }
  if (patternParts.length !== pathParts.length) return false;
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) continue;
    if (patternParts[i] !== pathParts[i]) return false;
  }
  return true;
}

// Every predicate the servers ask before a render - canStream, isNoJs, isBuffered, shellOff, cspNonce, headersFor, docAttrs.
function routeClass(pathname) {
  let c = __routeClass.get(pathname);
  if (c) return c;
  let route = null;
  let stream = false;
  let buffered = false;
  let shell = false;
  let lang = defaultLocale;
  let dir = localeDir(defaultLocale);
  let first = true;
  for (const r of routes) {
    if (!matchRoute(r.pattern, pathname)) continue;
    if (route === null) route = r;
    if (r.shell === false) shell = true;
    if (r.buffer || r.signal) buffered = true;
    const langIdx = r.pattern.split('/').indexOf(':lang');
    if (langIdx < 0) {
      stream = true;
    } else if (isLocale(pathname.split('/')[langIdx])) {
      stream = true;
      // docAttrs answers from the FIRST matching route alone: its locale, or
      if (first) {
        const l = pathname.split('/')[langIdx];
        lang = l;
        dir = localeDir(l);
      }
    }
    first = false;
  }
  let noJs = false;
  for (const p of noJsRoutes) if (matchRoute(p, pathname)) { noJs = true; break; }
  let nonce = false;
  for (const p of cspNonceRoutes) if (matchRoute(p, pathname)) { nonce = true; break; }
  let headers = null;
  for (const r of routeHeaders) if (matchRoute(r.pattern, pathname)) { headers = r.headers; break; }
  let cache = null;
  for (const r of routeCaches) if (matchRoute(r.pattern, pathname)) { cache = r; break; }
  c = { route, stream, buffered, shell, noJs, nonce, headers, cache, lang, dir };
  if (__routeClass.size >= 2000) {
    const oldest = __routeClass.keys().next().value;
    if (oldest !== undefined) __routeClass.delete(oldest);
  }
  __routeClass.set(pathname, c);
  return c;
}
const __routeClass = new Map();

// Head blocks (one per component in the route chain) are pulled out of the page html: the shell injects them into <head>.
function extractHead(rendered) {
  const head = [];
  const html = rendered.replace(/<!--\u27E6h:(\\d+)\u27E7-->([\\s\\S]*?)<!--\u27E6\\/h:\\1\u27E7-->/g, (_, id, content) => {
    head.push(content);
    return '<!--\u27E6h:' + id + '\u27E7--><!--\u27E6/h:' + id + '\u27E7-->';
  });
  return { html, head };
}

// Form: the submitted FormData of a progressive-enhancement POST.
export async function renderPage(pathname, form) {
  // Renders DO overlap in one process: prod-server warms every route in the background at startup.
  return isolateRender(() => renderPageIsolated(pathname, form));
}

async function renderPageIsolated(pathname, form) {
  clearRequestState();
  // Cold-start readiness gate (xoboe #8): await the app's published DB-ready promise before any $data() read.
  const appReady = globalThis.__rosespanAppReady;
  if (appReady) await appReady;
  const route = routeClass(pathname).route;
  if (route) {
      const patternParts = route.pattern.split('/');
      const pathParts = pathname.split('/');
      for (let i = 0; i < patternParts.length; i++) {
        const seg = patternParts[i];
        if (seg.startsWith(':')) setState(seg.slice(1), pathParts[i]);
        
        else if (seg.startsWith('*')) setState(seg.replace(/^\\*+/, ''), pathParts.slice(i));
      }
 // I18n: a [lang] segment naming no dictionary is a 404 - the URL is the contract.
      const langIdx = patternParts.indexOf(':lang');
      if (langIdx >= 0 && !isLocale(pathParts[langIdx])) {
  
        return await notFoundPage(pathname);
      }
 
      const docLang = langIdx >= 0 ? pathParts[langIdx] : defaultLocale;
 // The action dispatch. The page's guard (exported beforeAction) runs FIRST and vetoes with an ActionError - the action-level permission check.
      let actionStatus = 0;
      if (form && route.actions) {
        const actionName = form.get('__action') || 'action';
        const fn = route.actions[actionName];
        if (fn) {
          try {
            if (route.guard) await route.guard(actionName, form);
            const patch = await fn(form);
            if (patch && typeof patch === 'object') {
              for (const key of Object.keys(patch)) {
                const v = patch[key];
                // An incremental patch is RECORDED, not applied: the render's own state declarations apply.
                if (v instanceof StateDelta) setStateDelta(key, v);
                else setState(key, v);
              }
            }
          } catch (err) {
            if (err instanceof ActionError) {
              setState('actionError', { action: actionName, message: err.message, code: err.code, field: err.field });
              actionStatus = err.code;
            } else if (err && err.__rosespan === 'redirect') {
              
              return { redirect: err.path, status: err.status ?? 303, ...docAttrs(pathname) };
            } else if (err && err.__rosespan === 'notFound') {
  
              return await notFoundPage(pathname);
            } else {
              throw err;
            }
          }
        }
      }
      let rendered;
      try {
        rendered = extractHead(await route.render([], ''));
      } catch (err) {
        // The control-flow pair: redirect() and notFound() are THROWN from inside the render (a $data body resolving a slug that no longer exists).
        const signal = err && err.__rosespan;
        if (signal === 'redirect') {
          return { redirect: err.path, status: err.status ?? 307, ...docAttrs(pathname) };
        }
        if (signal === 'notFound') {
          return await notFoundPage(pathname);
        }
        
        console.error('RoseSpan: render failed for', pathname, err instanceof Error ? err.message : err);
        // F10: in dev the response body carries the real error \u2014 message, file:line and the fix hint.
        let devDetail = '';
        if (process.env.ROSESPAN_DEV === '1' && err) {
          const msg = esc(err instanceof Error ? err.message : String(err));
          const file = esc(String(err.file || ''));
          const line = err.line != null ? esc(String(err.line)) : '';
          const hint = esc(String(err.hint || ''));
          const stack = esc(err instanceof Error ? (err.stack || '').split('\\n').slice(1, 7).join('\\n') : '');
          devDetail = '<div style="margin:24px auto;max-width:860px;font:13px/1.6 ui-monospace,monospace;background:#1b1b1f;color:#e6e6ea;border:1px solid #3a3a42;border-radius:10px;padding:20px 24px;text-align:left;white-space:pre-wrap;word-break:break-word">'
            + '<div style="font:600 15px/1.4 system-ui,sans-serif;color:#ff8b8b">Render failed: ' + esc(pathname) + '</div>'
            + '<div style="margin:10px 0 0;color:#ffd479">' + msg + '</div>'
            + (file ? '<div style="margin:6px 0 0;color:#9ad1ff">' + file + (line ? ':' + line : '') + '</div>' : '')
            + (hint ? '<div style="margin:10px 0 0;color:#9fe8b0">Fix: ' + hint + '</div>' : '')
            + (stack ? '<pre style="margin:12px 0 0;color:#8f8f9a">' + stack + '</pre>' : '')
            + '</div>';
        }
        if (errorPage) {
          // ErrorNoJs is a compile-time constant (see the errorNoJs declaration beside errorRender): a zero-JS site's 500 carries no state script.
          const fb = await renderFallback(pathname, errorPage, ${errorNoJs});
          return { ...fb, html: fb.html + devDetail, status: 500${errorNoJs ? ", csr: false" : ""} };
        }
        return { html: '<h1>500</h1><p>Something went wrong rendering this page.</p>' + devDetail, state: '{}', head: [], status: 500, ...docAttrs(pathname) };
      }
      // __route tells the bootstrap which route this document was rendered for.
    const noJs = route.csr === false;
    let state = '{}';
    if (!noJs || actionStatus !== 0) {
      const s = serializeState();
      state = '{"__route":' + JSON.stringify(pathname) + (s.length > 2 ? ',' + s.slice(1) : '}');
    }
 // Csr ( auto since #29): false when the compiler found nothing in the route's chain that needs the client (or the route asserted csr = false) .
      return { html: rendered.html, state, head: rendered.head, status: actionStatus || 200, csr: route.csr !== false, shell: route.shell !== false, lang: docLang, dir: localeDir(docLang) };
  }
  return await notFoundPage(pathname);
}

// Would renderPageStream handle this path? (matched route = stream, anything
export function canStream(pathname) {
  return routeClass(pathname).stream;
}


export function shellOff(pathname) {
  return routeClass(pathname).shell;
}

// === API routes === The /api namespace answers JSON, never HTML: an API client that hits an unknown path must not receive the SPA shell.
export function isApi(pathname) {
  return pathname === '/api' || pathname.startsWith('/api/');
}

function toResponse(out) {
  if (out instanceof Response) return out;
  if (out === undefined || out === null) return new Response(null, { status: 204 });
  return new Response(JSON.stringify(out), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

export async function handleApi(method, pathname, request) {
  for (const route of apiRoutes) {
    if (matchRoute(route.pattern, pathname)) {
      const fn = route.handlers[method];
      if (!fn) {
        return new Response(JSON.stringify({ error: 'method not allowed' }), {
          status: 405,
          headers: { 'content-type': 'application/json', allow: Object.keys(route.handlers).join(', ') },
        });
      }
      try {
        return toResponse(await fn(request));
      } catch (err) {
        
        const signal = err && err.__rosespan;
        if (signal === 'redirect') {
          return new Response(JSON.stringify({ error: 'redirect', location: err.path }), {
            status: err.status ?? 307,
            headers: { 'content-type': 'application/json', location: err.path },
          });
        }
        if (signal === 'notFound') {
          return new Response(JSON.stringify({ error: 'not found' }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          });
        }
        throw err;
      }
    }
  }
  return new Response(JSON.stringify({ error: 'not found' }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  });
}

// === Streaming SSR === The static shell (doctype, <head>, body + container open) flushes BEFORE the - possibly slow - render completes: the first byte.
export async function renderPageStream(pathname, write, shellOpen, clientTag) {
  // Isolated for the same reason as renderPage: a streaming render awaits inside route.render()
  return isolateRender(() => renderPageStreamIsolated(pathname, write, shellOpen, clientTag));
}

async function renderPageStreamIsolated(pathname, write, shellOpen, clientTag) {
  clearRequestState();
  // Cold-start readiness gate (xoboe #8): same contract as renderPage \u2014 await the app's published DB-ready promise before streaming the shell.
  const appReady = globalThis.__rosespanAppReady;
  if (appReady) await appReady;
  const route = routeClass(pathname).route;
  if (route) {
      const patternParts = route.pattern.split('/');
      const pathParts = pathname.split('/');
      for (let i = 0; i < patternParts.length; i++) {
        const seg = patternParts[i];
        if (seg.startsWith(':')) setState(seg.slice(1), pathParts[i]);
        
        else if (seg.startsWith('*')) setState(seg.replace(/^\\*+/, ''), pathParts.slice(i));
      }
      // i18n: an unknown locale must 404 BEFORE the shell flushes - a
      const langIdx = patternParts.indexOf(':lang');
      if (langIdx >= 0 && !isLocale(pathParts[langIdx])) return 404;
      write(shellOpen);
      let html;
      try {
        // nonce routes: an un-nonced inline <style> would be CSP-blocked, so strip to markers (applyHead re-injects under the nonce). Otherwise keep the head content in the streamed body so page/layout <style> applies on first paint (no FOUC) and no-JS routes stay styled.
        html = routeClass(pathname).nonce ? extractHead(await route.render([], '')).html : await route.render([], '');
      } catch (err) {
        console.error('RoseSpan: render failed for', pathname, err instanceof Error ? err.message : err);
        // F10: dev carries the real error in the body here too \u2014 the shell
        let devDetail = '';
        if (process.env.ROSESPAN_DEV === '1' && err) {
          const msg = esc(err instanceof Error ? err.message : String(err));
          const file = esc(String(err.file || ''));
          const line = err.line != null ? esc(String(err.line)) : '';
          const hint = esc(String(err.hint || ''));
          const stack = esc(err instanceof Error ? (err.stack || '').split('\\n').slice(1, 7).join('\\n') : '');
          devDetail = '<div style="margin:24px auto;max-width:860px;font:13px/1.6 ui-monospace,monospace;background:#1b1b1f;color:#e6e6ea;border:1px solid #3a3a42;border-radius:10px;padding:20px 24px;text-align:left;white-space:pre-wrap;word-break:break-word">'
            + '<div style="font:600 15px/1.4 system-ui,sans-serif;color:#ff8b8b">Render failed: ' + esc(pathname) + '</div>'
            + '<div style="margin:10px 0 0;color:#ffd479">' + msg + '</div>'
            + (file ? '<div style="margin:6px 0 0;color:#9ad1ff">' + file + (line ? ':' + line : '') + '</div>' : '')
            + (hint ? '<div style="margin:10px 0 0;color:#9fe8b0">Fix: ' + hint + '</div>' : '')
            + (stack ? '<pre style="margin:12px 0 0;color:#8f8f9a">' + stack + '</pre>' : '')
            + '</div>';
        }
        html = errorPage ? (routeClass(pathname).nonce ? extractHead(await errorPage([], '')).html : await errorPage([], '')) + devDetail : '<h1>500</h1><p>Something went wrong rendering this page.</p>' + devDetail;
      }
      write(html);
 // Csr: false ( auto since #29): a no-JS route's document ends here - no state script, no inlined bundle.
      if (route.csr === false) {
        write('</div>\\n</body>\\n</html>');
        return 200;
      }
      const state = JSON.stringify({ __route: pathname, ...JSON.parse(serializeState()) });
      // P1-6 (bug report): the JSON data block is embedded in the document.
      const stateSafe = state.replace(/</g, '\\\\u003c');
      write('</div>\\n  <script type="application/json" id="__rosespan_state">' + stateSafe + '</script>\\n  ' + clientTag + '\\n</body>\\n</html>');
      return 200;
  }
  return 404;
}
// Prevent tree-shaking of invalidateRenderCache (called from prod-server.ts / edge.ts on non-GET writes).
void invalidateRenderCache;

// Same reason, for the per-request context store: prod-server.ts installs an AsyncLocalStorage adapter.
export { installContextStore };
`;
  try {
    const patterns = [...pages, ...apiRoutes].map(({ info }) => info.pattern);
    const uniq = [...new Set(patterns)].sort();
    const lit = uniq.map((p) => JSON.stringify(p)).join(" | ") || "'/'";
    const paramsOf = (pattern) => (pattern.match(/:[\w]+|\*\*[\w]+|\*[\w]+/g) ?? []).map((m) => m.replace(/^[*:]+/, ""));
    const paramSig = uniq.map((p) => {
      const ps = paramsOf(p);
      if (!ps.length) return "";
      return "  " + JSON.stringify(p) + ": { " + ps.map((n) => n + ": string | number").join("; ") + " };\n";
    }).join("");
    const outDirTs = path3.join(root, "src", ".rosespan");
    await fs4.promises.mkdir(outDirTs, { recursive: true });
    const srcLines = [
      "// GENERATED by rosespan build - do not edit.",
      "export type RoutePath = " + lit + ";",
      "export const routePatterns = " + JSON.stringify(uniq) + " as const;",
      "export type RouteParams = {",
      paramSig,
      "};",
      "/** Build a URL from a route pattern and its params. */",
      "export function url(",
      "  path: RoutePath,",
      "  params: RouteParams[keyof RouteParams] = {} as never,",
      "): string {",
      "  let out = path as string;",
      "  for (const [k, v] of Object.entries(params as Record<string, string | number>)) {",
      "    out = out.replace(new RegExp('[:*]+' + k, 'g'), String(v));",
      "  }",
      "  return out;",
      "}"
    ].join("\n") + "\n";
    await fs4.promises.writeFile(path3.join(outDirTs, "routes.ts"), srcLines);
  } catch {
  }
  await fs4.promises.writeFile(path3.join(buildDir, "server-entry.js"), serverEntry);
  await runtimeBuild;
  const bundleBuilds = runEsbuild(path3.join(buildDir, "server-entry.js"), {
    entryPoints: [path3.join(buildDir, "server-entry.js")],
    bundle: true,
    outfile: path3.join(outDir, "server.js"),
    format: "esm",
    platform: "node",
    write: true,
    ...TS_LOADER,
    ...minify ? { minify: true, keepNames: true } : {}
  }, incremental);
  bundleBuilds.catch(() => {
  });
  const clientImports = split ? "" : compiled.map((_, i) => ({ i })).filter(({ i }) => !infos[i].isApi && !infos[i].isMiddleware && reachable.has(i)).map(({ i }) => `import { render as render_${i} } from './comp-${i}.client.js';`).join("\n");
  const clientRoutes = pages.map(({ info, i }) => split ? `{ pattern: '${info.pattern}', ${loaderInner(i)} }` : `{ pattern: '${info.pattern}', render: ${compose(i)} }`).join(",\n  ");
  const prefetchMode = compiled.find((c) => c.prefetch)?.prefetch ?? "all";
  const lazyHydrationFlag = compiled.find((c) => c.lazyHydration)?.lazyHydration ?? false;
  const vitalsOn = compiled.some((c) => c.vitals === true);
  const vitalsBlock = vitalsOn ? `


reportVitals();
` : "";
  const hasLang = infos.some((i) => i.pattern.includes(":lang"));
  const langDirBlock = hasLang ? `      
      
      
      
      
 
      // (dist/mount.js) renders into a foreign page, whose language and
      
      const seg = langIdx >= 0 ? pathname.split('/')[langIdx] : '';
      const known = !seg || isLocale(seg);
      if (container === document.getElementById('app')) {
        const docLang = known && seg ? seg : __defLocale;
        document.documentElement.lang = docLang;
        const docDir = localeDir(docLang);
        if (docDir) document.documentElement.setAttribute('dir', docDir);
        else document.documentElement.removeAttribute('dir');
      }
      if (!known) {` : `      if (langIdx >= 0 && !isLocale(pathname.split('/')[langIdx])) {`;
  const clientEntry = `
${clientImports}
import { state, setState, resumeState, clearRequestState, resetEffects, wire, isolateStateAsync, restoreState, setRefreshHook, clearMounts, flushMounts, adoptCleanups, handlers, setActionDispatcher, setLocales, setLocalePacks, ensureLocale, isLocale, localeDir, setPrefetchOverride, serializeState, setFxOwner, resetContainerFx, esc, applyStorePatch } from './runtime.js';
${compiled.some((c) => c.usesStore) ? `
// Live store channel: an app that reads a shared $store() keeps one EventSource to
// /__rosespan_store. A server-side write ($store.set/update from a network listener,
// a job, or an action) is pushed here as an {name,value} patch; applyStorePatch
// writes it into the reactive store box, re-running the wire() effects that render
// {store.get()} / {#each store.get()}. No store in the app - no connection.
if (typeof window !== 'undefined' && typeof EventSource !== 'undefined') {
  try {
    var __storeEs = new EventSource('/__rosespan_store');
    __storeEs.addEventListener('store', function (m) {
      try { var p = JSON.parse(m.data); applyStorePatch(p.name, p.value); } catch (e) {}
    });
  } catch (e) {}
}` : ""}

// I18n: the dictionaries baked at build time - the client renders any PRELOADED locale from the bundle.
setLocales(${clientLocalesJson}, '${defaultLocale}');
setLocalePacks(${JSON.stringify(packed)});
${hasLang ? `// the default locale, kept beside setLocales' own copy so <html lang> can
// follow a route that carries no [lang] segment (a non-i18n page)
const __defLocale = '${defaultLocale}';` : ""}
${vitalsOn ? `// the app asked for web-vitals. The import is what keeps
// reportVitals alive through minification and tree-shaking; the call is one
// statement at boot, before the first render.
import { reportVitals } from './runtime.js';` : ""}
// Lazy hydration: when the app opts in (export const lazyHydration = true in
// the root _layout.rose), the bootstrap defers the initial wire() to
// requestIdleCallback. The flag is set here (module eval runs before the
// bootstrap's start() call) so the bootstrap can read it without a second channel.
if (typeof window !== 'undefined') window.__rosespanLazy = ${JSON.stringify(lazyHydrationFlag)};
// The two pack doors, re-exported for an app that wants to warm a language before its visitor asks for it (ensureLocale) or to feed a dictionary.
export { ensureLocale, loadLocale } from './runtime.js';
${vitalsBlock}

const routes = [
  ${clientRoutes}
];

// === Mode B: lazy route chunks === Split mode's registry entries arrive without a render function: loadChain loads the route's module graph (the page).
const loadChain = async (loaders) => {
  const mods = await Promise.all(loaders.map((load) => load()));
  let expr = (closes, children) => mods[0].render(closes, children);
  for (let k = 1; k < mods.length; k++) {
    const inner = expr;
    const outer = mods[k].render;
    expr = async (closes, children) => await outer(closes, await inner(closes, children));
  }
  return { render: expr };
};
const getRender = async (route) => {
  if (typeof route === 'function') return route; 
  // inline mode: the render itself
  return (route.render ??= (await route.load()).render);
};

// Not-found pages, deepest segment first (the server's table, client half): the root 404.rose ('/') and any pages/<seg>/_notfound.rose.
const notFoundRoutes = ${notFoundTable};
const notFoundFor = (pathname) => {
  for (const [prefix, render] of notFoundRoutes) {
    if (prefix === '/' || pathname === prefix || pathname.startsWith(prefix + '/')) return render;
  }
  return null;
};

// whose render throws degrades to this instead of failing the response.
const errorPage = ${errorRender};

// Paint a fallback page (404/500) into the container, wired like any render.
async function paintFallback(container, page, builtin, keepState = false) {
  if (!keepState) __navReset(container);
  clearMounts(); 
  // a failed render leaves stale mounts behind
  const render = page ? await getRender(page) : null;
  if (render) {
        // a packed locale's dictionary lands before the render
    const closes = [];
    await __withOwner(container, async () => {
        
      const html = await render(closes, '');
      container.innerHTML = html;
      wire(container, closes);
      bindEvents(container);
      flushMounts();
    });
        
    return;
  }
  container.innerHTML = builtin;
}


export async function startNotFound(container, pathname) {
  const el = document.getElementById('__rosespan_state');
  if (el) resumeState(el.textContent);
  await paintFallback(container, notFoundFor(pathname), '<h1>404</h1><p>Page not found</p>', true);
}

export function matchRoute(pattern, pathname) {
  // Q0 (bug report): one canonical URL per route.
  pathname = pathname.replace(/\\/+$/, '') || '/';
  const patternParts = pattern.split('/');
  const pathParts = pathname.split('/');
  
  const last = patternParts[patternParts.length - 1];
  if (last && (last.startsWith('*') || last.startsWith('**'))) {
    const fixed = patternParts.slice(0, -1);
    if (pathParts.length < fixed.length) return false;
    if (last.startsWith('*') && !last.startsWith('**') && pathParts.length === fixed.length) return false;
    for (let i = 0; i < fixed.length; i++) {
      if (fixed[i].startsWith(':')) continue;
      if (fixed[i] !== pathParts[i]) return false;
    }
    return true;
  }
  if (patternParts.length !== pathParts.length) return false;
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) continue;
    if (patternParts[i] !== pathParts[i]) return false;
  }
  return true;
}

// === Link prefetch === Hover / focus / touch an internal link and the target route renders NOW - $data included - against a throwaway signal map.
let prefetchMode = ${JSON.stringify(prefetchMode)};
export function setPrefetchMode(mode) { prefetchMode = mode; }
const PREFETCH_BUDGET = 8;
const PREFETCH_MAX_CACHED = 4;
const prefetchCache = new Map(); 

let prefetchQueue = Promise.resolve();
let prefetchPending = 0;


async function applyParams(route, pathname) {
  const patternParts = route.pattern.split('/');
  const pathParts = pathname.split('/');
  for (let i = 0; i < patternParts.length; i++) {
    const seg = patternParts[i];
    if (seg.startsWith(':')) setState(seg.slice(1), pathParts[i]);
        
    else if (seg.startsWith('*')) setState(seg.replace(/^\\*+/, ''), pathParts.slice(i));
  }
      // streamed response cannot change its status afterwards
  const langIdx = patternParts.indexOf(':lang');
  if (langIdx >= 0) await ensureLocale(pathParts[langIdx]);
}


function __netOk() {
  const c = navigator.connection;
  if (!c) return true;
  if (c.saveData) return false;
  const t = c.effectiveType;
  return t !== 'slow-2g' && t !== '2g';
}

export function prefetch(pathname, source = 'hover') {
  if (prefetchMode === 'off') return;
  if (prefetchMode === 'hover' && source !== 'hover') return;
  if (prefetchMode === 'viewport' && source !== 'viewport') return;
  if (!__netOk()) return; 
  // save-data / 2g: no bytes before the click
  if (prefetchCache.has(pathname)) return;
  if (pathname === location.pathname) return; 
  
  const route = routes.find((r) => matchRoute(r.pattern, pathname));
  if (!route) return;
  if (prefetchPending >= PREFETCH_BUDGET) return; 
  // Budget spent: drop it, a later hover retries P0-1: the link may carry a query (/search?q=cats).
  const qi = pathname.indexOf('?');
  const qOverride = qi >= 0 ? Object.fromEntries(new URLSearchParams(pathname.slice(qi))) : null;
  const p = prefetchQueue.then(async () => {
    try {
      setPrefetchOverride(qOverride);
      // The isolated render also captures the onMount callbacks the route queued and the onCleanup disposers it registered: the paint that consumes.
      const { result, state, mounts, cleanups } = await isolateStateAsync(async () => {
        await applyParams(route, pathname); 
        const closes = [];
        const render = await getRender(route); 
        const html = await render(closes, '');
        return { html, closes };
      });
      const entry = { ...result, state, mounts, cleanups };
      prefetchCache.set(pathname, entry); 
      // Promise -> result evict oldest-first; in-flight promises are never evicted (evicting one would only force a duplicate render)
      while (prefetchCache.size > PREFETCH_MAX_CACHED) {
        const oldest = prefetchCache.keys().next().value;
        if (prefetchCache.get(oldest) instanceof Promise) break;
        prefetchCache.delete(oldest);
      }
      return entry;
    } catch {
      prefetchCache.delete(pathname); 
      return null;
    } finally {
      setPrefetchOverride(null);
      prefetchPending--;
    }
  });
  prefetchPending++;
  prefetchCache.set(pathname, p);
  prefetchQueue = p;
}

export function prefetchStats() {
  return { cached: prefetchCache.size, pending: prefetchPending, mode: prefetchMode, network: __netOk() };
}

// One delegated listener per event type on the app container: survives DOM swaps and cloned blocks, so handlers never need re-binding.
const DELEGATED = ['click', 'input', 'change', 'submit'];
function bindEvents(container) {
  if (container.__rosespan_bound) return;
  container.__rosespan_bound = true;
  for (const ev of DELEGATED) {
    container.addEventListener(ev, (e) => {
      const el = e.target.closest('[data-on-' + ev + ']');
      if (!el || !container.contains(el)) return;
      const fn = el.getAttribute('data-on-' + ev);
      if (fn.startsWith('$action:')) return $action(fn.slice(8), e);
      const h = handlers[fn];
      if (h) h(e);
    });
  }
}

// === Server actions from any event === POST the body to the current route and adopt the response in place: the server runs the selected action.
async function postForm(body, container, pathname) {
 
  const box = container || document.getElementById('app');
  const route = pathname || location.pathname;
  const res = await fetch(route, { method: 'POST', body });
  const html = await res.text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const next = doc.getElementById('app');
  const st = doc.getElementById('__rosespan_state');
  const paint = () => {
    adopt(box, next ? next.innerHTML : '', st ? st.textContent : '{}', route);
  };
  if (document.startViewTransition) document.startViewTransition(paint);
  else paint();
}

// Call a page's server action by name from any event handler: <button on:click={like}> compiles to $action('like').
export async function $action(name, e) {
  if (e && e.preventDefault) e.preventDefault();
  // F34: the pending flag is ordinary signal state - {#if $actionPending()}
  const [__rvPending, __rvSetPending] = state('actionPending', false);
  __rvSetPending(true);
  const body = new FormData();
  body.append('__action', name);
 // An event inside a mount belongs to that mount - the attribute is kept in step with what is currently mounted.
  const box = e && e.target && e.target.closest ? e.target.closest('[data-rosespan]') : null;
  try {
    return await postForm(body, box || undefined, box ? box.getAttribute('data-rosespan') : undefined);
  } finally {
    __rvSetPending(false);
  }
}
// F17: hand the dispatcher to the runtime, so wire() can serve a server action bound to a non-delegated event (on:keydown="$action:save") the same way.
setActionDispatcher($action);

export { postForm };

// The live signal graph as JSON - the same serializeState the zero-hydration resume uses.
export { serializeState };


// Initial=true: adopt the SSR DOM (zero hydration) - wire reactive markers to the existing nodes and bind events.
function __ownsDoc(container) {
  return container === document.getElementById('app');
}
function __navReset(container) {
  if (__ownsDoc(container)) {
    resetEffects();
    clearRequestState();
  } else {
    resetContainerFx(container);
  }
}
// Attribute everything a render creates (state keys, effects, onCleanups) to
async function __withOwner(container, fn) {
  if (__ownsDoc(container)) return fn();
  setFxOwner(container);
  try {
    return await fn();
  } finally {
    setFxOwner(null);
  }
}
// View Transition on SPA swaps (B9): the DOM swap rides one cross-fade when the browser supports it; reduced-motion users and environments without.
async function __swap(container, html) {
  const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (typeof document.startViewTransition === 'function' && !reduce) {
    const vt = document.startViewTransition(() => { container.innerHTML = html; });
    await vt.updateCallbackDone.catch(() => {});
  } else {
    container.innerHTML = html;
  }
}

export async function start(container, pathname, initial) {
  clearMounts(); 
  // stale mounts from a failed render never fire
  if (initial) {
    const el = document.getElementById('__rosespan_state');
    if (el) resumeState(el.textContent);
  }
  for (const route of routes) {
    if (matchRoute(route.pattern, pathname)) {
      // I18n: an unknown locale paints the 404 page, same as the server (before the prefetch check: a cached entry for a bogus locale is discarded).
      const langIdx = route.pattern.split('/').indexOf(':lang');
${langDirBlock}
        
        await paintFallback(container, notFoundFor(pathname), '<h1>404</h1><p>Page not found</p>');
          
        return;
      }
      // Prefetched on hover/focus/touch: the render already ran, so paint its HTML and adopt its signal entries - events then patch the very nodes we.
      let hit = initial ? undefined : prefetchCache.get(pathname);
      if (hit && typeof hit.then === 'function') hit = await hit; 
      // in-flight: land it first
      if (hit) {
        prefetchCache.delete(pathname); 
        
        __navReset(container);
        restoreState(hit.state);
        await __swap(container, hit.html);
        await __withOwner(container, () => {
          wire(container, hit.closes);
          bindEvents(container);
          hit.mounts.forEach((fn) => fn()); 
          adoptCleanups(hit.cleanups); 
        });
          
        return;
      }
      if (!initial) __navReset(container);
      let broken = false;
      let signal = null;
      await __withOwner(container, async () => {
        await applyParams(route, pathname);
        const closes = [];
        let html;
        try {
          const render = await getRender(route); 
          
          html = await render(closes, '');
        } catch (err) {
          
          if (err && err.__rosespan === 'notFound') { signal = 'notFound'; return; }
          if (err && err.__rosespan === 'redirect') { signal = err.path; return; }
          
          console.error('RoseSpan: client render failed for', pathname, err instanceof Error ? err.message : err);
          broken = true;
          return;
        }
        if (!initial) await __swap(container, html);
        wire(container, closes);
        bindEvents(container);
        flushMounts();
      });
      if (signal === 'notFound') {
        if (!initial) { try { location.assign(pathname); return; } catch {  } }
        await paintFallback(container, notFoundFor(pathname), '<h1>404</h1><p>Page not found</p>');
        return;
      }
      if (signal) {
        location.href = signal; 
        return;
      }
      if (broken) {
        await paintFallback(container, errorPage, '<h1>500</h1><p>Something went wrong rendering this page.</p>');
      }
      return;
    }
  }
  // Unmatched route: the nearest not-found page renders (with its head + interactivity) - a segment's _notfound.rose or the root 404.rose - else //.
${hasLang ? ` // the same app-root gate as above - a mount never touches the
  // host document's language or direction.
  if (container === document.getElementById('app')) {
    document.documentElement.lang = __defLocale;
    document.documentElement.removeAttribute('dir');
  }` : ""}
  await paintFallback(container, notFoundFor(pathname), '<h1>404</h1><p>Page not found</p>');
}

// Adopt a server-rendered response in place - the JS-enabled half of progressive-enhancement forms: the bootstrap POSTs a <form method="POST">.
export async function adopt(container, html, stateJson, pathname) {
 
  const route0 = pathname || location.pathname;
  __navReset(container);
  clearMounts(); 
  // stale mounts from a failed render never fire
  resumeState(stateJson);
  container.innerHTML = html;
  
  const st = document.getElementById('__rosespan_state');
  if (st) st.textContent = stateJson;
  for (const route of routes) {
    if (matchRoute(route.pattern, route0)) {
      await __withOwner(container, async () => {
        await applyParams(route, route0);
        const closes = [];
        try {
          const render = await getRender(route); 
          
          await render(closes, '');
        } catch {
          return;
        }
        wire(container, closes);
        bindEvents(container);
        flushMounts();
      });
      return;
    }
  }
}
// === refresh() implementation === Re-render the current route in place: the client half of router.refresh() (a router refresh) / (a full invalidation).
setRefreshHook(async () => {
  prefetchCache.delete(location.pathname);
  await start(document.getElementById('app'), location.pathname, false);
});
`;
  await fs4.promises.writeFile(path3.join(buildDir, "client-entry.js"), clientEntry);
  const clientBuild = split ? (async () => {
    await rmTreeParallel(path3.join(outDir, "chunks"));
    return runEsbuild(path3.join(buildDir, "client-entry.js") + ":split", {
      entryPoints: [path3.join(buildDir, "client-entry.js")],
      bundle: true,
      format: "esm",
      platform: "browser",
      minify: true,
      splitting: true,
      outdir: outDir,
      entryNames: "client",
      chunkNames: "chunks/[name]-[hash]",
      write: true,
      ...TS_LOADER
    }, incremental);
  })() : runEsbuild(path3.join(buildDir, "client-entry.js"), {
    entryPoints: [path3.join(buildDir, "client-entry.js")],
    bundle: true,
    outfile: path3.join(outDir, "client.js"),
    format: "esm",
    platform: "browser",
    minify: true,
    write: true,
    ...TS_LOADER
  }, incremental);
  await Promise.all([bundleBuilds, clientBuild, prodBuild]);
  let mountEntry = MOUNT_ENTRY;
  try {
    const cb = fs4.readFileSync(path3.join(outDir, "client.js"));
    mountEntry = MOUNT_ENTRY.replace("from '/client.js'", `from '/client.js?v=${fnv1a32(cb)}'`);
  } catch {
  }
  await fs4.promises.writeFile(path3.join(outDir, "mount.js"), mountEntry);
  const publicDir = path3.join(root, "public");
  if (fs4.existsSync(publicDir)) {
    await fs4.promises.cp(publicDir, path3.join(outDir, "public"), { recursive: true });
  }
  console.log("RoseSpan zero-JS report:");
  for (const line of buildReport(infos, compiled)) console.log("  " + line);
  const warnGroups = /* @__PURE__ */ new Map();
  for (const { info, i } of pages) {
    if (!routeShipsNoJs(infos, compiled, i)) continue;
    for (const ci of [i, ...layoutsOf(infos, i)]) {
      for (const w of compiled[ci].jsWarnings ?? []) {
        let g = warnGroups.get(w);
        if (!g) {
          g = { why: w, files: /* @__PURE__ */ new Map() };
          warnGroups.set(w, g);
        }
        const file = path3.relative(root, infos[ci].filePath).replace(/\\/g, "/");
        let routes = g.files.get(file);
        if (!routes) {
          routes = /* @__PURE__ */ new Set();
          g.files.set(file, routes);
        }
        routes.add(info.routePath);
      }
    }
  }
  for (const g of warnGroups.values()) {
    const allRoutes = /* @__PURE__ */ new Set();
    for (const routes of g.files.values()) for (const r of routes) allRoutes.add(r);
    const parts = [...g.files.entries()].sort((a, b) => b[1].size - a[1].size).map(([file, routes]) => `${file} (${routes.size === 1 ? [...routes][0] : `${routes.size} routes`})`);
    const shown = parts.slice(0, 4).join(", ");
    const more = parts.length > 4 ? `, +${parts.length - 4} more files` : "";
    console.warn(`RoseSpan warning: ${allRoutes.size} routes ship zero JavaScript while their chain contains ${g.why} - ${shown}${more}`);
  }
  return { routes: pages.map(({ info }) => info), bundle: bundleMode, config };
}
async function scanRoseFiles(root) {
  const pagesDir = path3.join(root, "src", "pages");
  if (!fs4.existsSync(pagesDir)) return [];
  async function scan(dir) {
    const entries = await fs4.promises.readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      const full = path3.join(dir, entry.name);
      if (entry.isDirectory()) files.push(...await scan(full));
      else if (entry.name.endsWith(".rose")) files.push(full);
    }
    return files;
  }
  return scan(pagesDir);
}
async function scanComponentFiles(root) {
  const compDir = path3.join(root, "src", "components");
  if (!fs4.existsSync(compDir)) return [];
  async function scan(dir) {
    const entries = await fs4.promises.readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      const full = path3.join(dir, entry.name);
      if (entry.isDirectory()) files.push(...await scan(full));
      else if (entry.name.endsWith(".rose")) files.push(full);
    }
    return files;
  }
  return scan(compDir);
}
function isAncestorDir(layoutPath, pagePath) {
  const layoutDir = path3.dirname(layoutPath);
  const pageDir = path3.dirname(pagePath);
  return pageDir === layoutDir || pageDir.startsWith(layoutDir + path3.sep);
}
function getRouteInfo(filePath2, root) {
  const pagesDir = path3.join(root, "src", "pages");
  const relative2 = path3.relative(pagesDir, filePath2).replace(/\\/g, "/");
  const withoutExt = relative2.replace(/\.rose$/, "");
  const base = path3.posix.basename(withoutExt);
  const isComponent = filePath2.replace(/\\/g, "/").includes("/src/components/");
  const isLayout = !isComponent && base === "_layout";
  const isNotFound = !isComponent && (base === "404" || base === "_notfound");
  const isError = !isComponent && base === "500";
  const isApi = !isComponent && (withoutExt === "api" || withoutExt.startsWith("api/"));
  const isMiddleware = !isComponent && withoutExt === "_middleware";
  let parts = withoutExt.split("/").filter((p) => p !== "_layout" && p !== "_notfound");
  if (parts.length > 1 && parts[parts.length - 1] === "index") parts = parts.slice(0, -1);
  const CATCH_ALL = /^\[\.\.\.(\w+)\]$/;
  const OPTIONAL_CATCH_ALL = /^\[\[\.\.\.(\w+)\]\]$/;
  const routeParts = parts.map((part) => {
    const optional = OPTIONAL_CATCH_ALL.exec(part);
    if (optional) return `**${optional[1]}`;
    const catchAll = CATCH_ALL.exec(part);
    if (catchAll) return `*${catchAll[1]}`;
    return part.startsWith("[") && part.endsWith("]") ? `:${part.slice(1, -1)}` : part;
  });
  let routePath;
  if (routeParts.length === 0 || routeParts.length === 1 && routeParts[0] === "index") {
    routePath = "/";
  } else {
    routePath = "/" + routeParts.join("/");
  }
  return {
    filePath: filePath2,
    routePath,
    pattern: routePath,
    paramNames: parts.flatMap((p) => {
      const optional = OPTIONAL_CATCH_ALL.exec(p);
      if (optional) return [optional[1]];
      const catchAll = CATCH_ALL.exec(p);
      if (catchAll) return [catchAll[1]];
      return p.startsWith("[") && p.endsWith("]") ? [p.slice(1, -1)] : [];
    }),
    isLayout,
    isNotFound,
    isError,
    isApi,
    isMiddleware,
    isComponent
  };
}
function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
export {
  RoseError,
  buildProject,
  buildReport,
  codeFrame,
  compileComponent,
  errorInfo,
  extractExports,
  lineAt,
  lineOf,
  loadConfig,
  loadPlugins,
  scanComponentFiles,
  scanRoseFiles,
  scopeCss,
  scriptOf,
  templateExprSpans
};
