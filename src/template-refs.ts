// The skill, agent and script references in a template's body (#312). The lint (1.3) and the map's chips (1.2) both read them from
// here, so an annotation and a chip always agree on what a reference is. Node-free like src/template.ts: the UI imports it as is.
import type { ParsedTemplate } from './template.js';

export type RefKind = 'hive' | 'bare' | 'script';
export interface TemplateRef {
  line: number;
  kind: RefKind;
  name: string;
  text: string;
}

// hive:<name>, with or without the slash, never inside a word: agent-hive:x is no reference
const HIVE_REF = /(?<![\w-])\/?hive:([A-Za-z0-9][\w-]*)/g;
// The plugin's root scripts/, alone or under ${CLAUDE_PLUGIN_ROOT}/; dist/scripts/x is another folder, a sentence's final dot not the file's
const SCRIPT_REF = /(?:\$\{CLAUDE_PLUGIN_ROOT\}\/|(?<![\w./-]))(scripts\/[\w-]+(?:\.[\w-]+)*)/g;
// Only inside inline code, so a prose path such as /tmp never is one; it starts the span or a word and is not a path, a namespace or a file
const BARE_REF = /(?<![^\s(])\/([A-Za-z0-9][\w-]*)(?![\w:/.-])/g;
const INLINE_CODE = /(`+)(.+?)\1/g;
// Claude Code's own commands are never an item
const CLAUDE_COMMANDS = new Set([
  'add-dir', 'agents', 'bug', 'clear', 'compact', 'config', 'context', 'cost', 'doctor', 'exit', 'export', 'help', 'hooks', 'ide',
  'init', 'install-github-app', 'login', 'logout', 'mcp', 'memory', 'model', 'output-style', 'permissions', 'plugin', 'pr-comments',
  'privacy-settings', 'release-notes', 'resume', 'review', 'rewind', 'security-review', 'status', 'statusline', 'terminal-setup',
  'todos', 'upgrade', 'usage', 'vim',
]);

type Found = Omit<TemplateRef, 'line'> & { index: number };

const toFound = (kind: RefKind, match: RegExpExecArray, offset = 0): Found => ({
  index: offset + match.index,
  kind,
  name: match[1],
  text: match[0],
});

function bareRefs(line: string): Found[] {
  return [...line.matchAll(INLINE_CODE)].flatMap((span) =>
    [...span[2].matchAll(BARE_REF)]
      .filter((match) => !CLAUDE_COMMANDS.has(match[1]))
      .map((match) => toFound('bare', match, span.index + span[1].length)),
  );
}

function lineRefs(line: string): Found[] {
  const hive = [...line.matchAll(HIVE_REF)].map((match) => toFound('hive', match));
  const scripts = [...line.matchAll(SCRIPT_REF)].map((match) => toFound('script', match));
  return [...hive, ...scripts, ...bareRefs(line)].sort((a, b) => a.index - b.index);
}

/** Every reference of the body, by line then column. Lines are the file's, the same as the parse's. */
export function templateRefs(parsed: ParsedTemplate): TemplateRef[] {
  return parsed.body
    .split('\n')
    .flatMap((text, index) => lineRefs(text).map(({ kind, name, text: written }) => ({ line: parsed.bodyLine + index, kind, name, text: written })));
}
