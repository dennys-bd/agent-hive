// Pure string → HTML for the worker's output: no DOM, so node:test covers it. Every character that came from the
// worker goes through esc() before any markup is added around it; the panel renders the result with innerHTML.

const FENCE = /^```(\w*)\s*$/;
const INLINE_CODE = /`([^`\n]+)`/g;
const COMMENT = String.raw`\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/`;
const STRING = String.raw`'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|` + '`[^`]*`';
const NUMBER = String.raw`\b\d+(?:\.\d+)?\b`;
// Short list shared by TS/JS, Python, Go, Rust and shell: enough to give a block some shape, no grammar per language.
const KEYWORDS = [
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'import', 'export', 'from', 'class', 'new',
  'async', 'await', 'def', 'fn', 'pub', 'struct', 'impl', 'match', 'type', 'interface', 'true', 'false', 'null', 'None',
  'self', 'this', 'then', 'fi', 'do', 'done', 'echo',
];
// One alternation, one pass, left to right: the earliest match owns its span, so a `//` inside a string stays a string.
const TOKEN = new RegExp(
  [COMMENT, STRING, NUMBER, String.raw`\b(?:${KEYWORDS.join('|')})\b`].map((group) => `(${group})`).join('|'), 'g',
);
const TOKEN_CLASS = ['comment', 'string', 'number', 'keyword']; // same order as the groups above
const DIFF_CLASS: [string, string][] = [['+', 'add'], ['-', 'del'], ['@@', 'hunk']];

interface Fence {
  lang: string;
  body: string[];
}

export function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

function diffLines(body: string): string {
  return body.split('\n').map((line) => {
    const cls = DIFF_CLASS.find(([prefix]) => line.startsWith(prefix))?.[1];
    return cls ? `<span class="${cls}">${esc(line)}</span>` : esc(line);
  }).join('\n');
}

function tokenize(body: string): string {
  let out = '';
  let last = 0;
  for (const m of body.matchAll(TOKEN)) {
    const cls = TOKEN_CLASS[m.slice(1).findIndex((group) => group !== undefined)];
    out += `${esc(body.slice(last, m.index))}<span class="${cls}">${esc(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  return out + esc(body.slice(last));
}

/** The body of one fence as HTML: `diff` by line prefix, anything else by the token regex. The result is already escaped. */
export function highlight(lang: string, body: string): string {
  return lang === 'diff' ? diffLines(body) : tokenize(body);
}

function block({ lang, body }: Fence): string {
  return `<pre class="code" data-lang="${esc(lang)}">${highlight(lang, body.join('\n'))}</pre>`;
}

function inline(line: string): string {
  return esc(line).replace(INLINE_CODE, '<code>$1</code>');
}

/** The panel's HTML: fenced blocks become <pre class="code">, everything else is escaped text with `inline` as <code>. */
export function renderOutput(lines: string[]): string {
  const out: string[] = [];
  let fence: Fence | undefined;
  for (const line of lines.join('\n').split('\n')) {
    const mark = FENCE.exec(line);
    if (fence && mark) {
      out.push(block(fence));
      fence = undefined;
    } else if (fence) {
      fence.body.push(line);
    } else if (mark) {
      fence = { lang: mark[1], body: [] };
    } else {
      out.push(inline(line));
    }
  }
  if (fence) out.push(block(fence)); // still open at the end: the worker is mid-block, show what is there
  return out.join('\n');
}
