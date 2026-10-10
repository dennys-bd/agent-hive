import { WORKSPACE_NAME } from './tasks.js';
import { extensionOf, inScope, languageDef, languageOf } from './languages.js';
import { type EditorConfig, FORMATTER_IDS, type FormatterId, type LanguageFormatter, type LanguageId } from './types.js';

export { extensionOf }; // its home is the catalog (#780); the save and its tests read it here too

// The formatters the Hive supports (#749) and the pure choice of the one a save runs. No I/O and no node import: the parser, the save and the
// Settings form all read it. Each row's flags were checked against the tool's own --help while building; a tool that cannot read stdin has no row.

/** One supported formatter: the extensions it takes, where its binary may be (a relative one under the activity's folder, then a bare name
 * on PATH), its argv after the extra args and, when the tool can refuse by its project's own config, what its stderr says then. */
export interface FormatterDef { id: FormatterId; extensions: readonly string[]; candidates: readonly string[]; argv(file: string): string[]; declines?: RegExp }

const row = (id: FormatterId, extensions: string, candidates: string[], argv: (file: string) => string[], declines?: RegExp): FormatterDef =>
  ({ id, extensions: extensions.split(' '), candidates, argv, ...(declines === undefined ? {} : { declines }) });

// biome kept as a linter only ("formatter": { "enabled": false }) exits 1 with the text unchanged: the project's choice, logged, not an error
const BIOME_DISABLED = /The content was not formatted because the formatter is currently disabled/;

/** The table, in FORMATTER_IDS order: the order a save tries them. */
export const FORMATTERS: readonly FormatterDef[] = [
  row('biome', '.js .jsx .mjs .cjs .ts .tsx .json .jsonc .css', ['node_modules/.bin/biome', 'biome'], (f) => ['format', `--stdin-file-path=${f}`], BIOME_DISABLED),
  row('prettier', '.js .jsx .mjs .cjs .ts .tsx .json .css .scss .less .md .yaml .yml .html .vue .graphql', ['node_modules/.bin/prettier', 'prettier'], (f) => ['--stdin-filepath', f]),
  row('ruff', '.py .pyi', ['.venv/bin/ruff', 'ruff'], (f) => ['format', '--stdin-filename', f, '-']),
  row('black', '.py .pyi', ['.venv/bin/black', 'black'], (f) => ['-q', '--stdin-filename', f, '-']),
  row('gofmt', '.go', ['gofmt'], () => []),
  row('rustfmt', '.rs', ['rustfmt'], () => ['--emit', 'stdout']),
  row('clang-format', '.c .h .cc .cpp .hpp .m .mm', ['clang-format'], (f) => [`--assume-filename=${f}`]),
  row('shfmt', '.sh .bash', ['shfmt'], (f) => ['--filename', f]),
  row('dart', '.dart', ['dart'], () => ['format']),
  row('swift-format', '.swift', ['swift-format'], (f) => ['format', '--assume-filename', f]),
  row('mix', '.ex .exs .heex', ['mix'], (f) => ['format', '--stdin-filename', f, '-']),
  row('terraform', '.tf .tfvars', ['terraform'], () => ['fmt', '-']),
  row('stylua', '.lua', ['stylua'], (f) => ['--stdin-filepath', f, '-']),
  row('zig', '.zig', ['zig'], () => ['fmt', '--stdin']),
  row('ktlint', '.kt .kts', ['ktlint'], () => ['--stdin', '-F', '--log-level=error']),
  row('taplo', '.toml', ['taplo'], () => ['fmt', '-']),
];

/** The formatter a save runs (#749): a custom one's shell line, or a supported one's binary and its argv for a file, the extra args first. */
export type FormatterPick =
  | { kind: 'custom'; name: string; command: string }
  | { kind: 'supported'; name: FormatterId; binary: string; argv(file: string): string[]; declines?: RegExp };

const DEFAULT_FORMATTER: LanguageFormatter = { enabled: true, args: [], workspaces: 'all' };

/** The supported formatters of a language (#780), in table order: each one that takes one of its extensions. */
export const formattersOf = (language: LanguageId): FormatterId[] =>
  FORMATTERS.filter((def) => def.extensions.some((e) => languageDef(language).extensions.includes(e))).map((def) => def.id);

/** A language's setting of a supported formatter (#780): its entry, else on with no args in every workspace. */
export const formatterSetting = (editor: EditorConfig, language: LanguageId, id: FormatterId): LanguageFormatter =>
  editor.languages[language]?.formatters?.[id] ?? DEFAULT_FORMATTER;

/** Every extension a custom formatter of other lists (#780): what languageOf adds to other's own. */
export const otherExtensions = (editor: EditorConfig): string[] => (editor.languages.other?.custom ?? []).flatMap((c) => c.extensions);

// A supported formatter that may run on the file: it takes the extension, and its language's setting is on in the workspace
const runs = (editor: EditorConfig, language: LanguageId, ext: string, workspace: string) => (def: FormatterDef): boolean => {
  const setting = formatterSetting(editor, language, def.id);
  return def.extensions.includes(ext) && setting.enabled && inScope(setting.workspaces, workspace);
};

/** The supported formatters a save may run on `file` in `workspace` (#780): the only ones it detects. */
export function candidatesFor(editor: EditorConfig, file: string, workspace: string): FormatterId[] {
  const language = languageOf(file, otherExtensions(editor));
  return language === undefined ? [] : FORMATTERS.filter(runs(editor, language, extensionOf(file), workspace)).map((def) => def.id);
}

/** What runs on `file` in `workspace` (#780): its language's first custom formatter that takes the extension in scope, else the first supported
 * one in table order that may run and has a binary in `binaries`; undefined when none does. formatOnSave is the caller's to check. */
export function pickFormatter(editor: EditorConfig, file: string, workspace: string, binaries: Partial<Record<FormatterId, string>>): FormatterPick | undefined {
  const language = languageOf(file, otherExtensions(editor));
  if (language === undefined) return undefined;
  const ext = extensionOf(file);
  const custom = (editor.languages[language]?.custom ?? []).find((c) => c.extensions.includes(ext) && inScope(c.workspaces, workspace));
  if (custom) return { kind: 'custom', name: custom.name, command: custom.command };
  const def = FORMATTERS.find((d) => binaries[d.id] !== undefined && runs(editor, language, ext, workspace)(d));
  if (def === undefined) return undefined;
  const { args } = formatterSetting(editor, language, def.id);
  return { kind: 'supported', name: def.id, binary: binaries[def.id] as string, argv: (f) => [...args, ...def.argv(f)], ...(def.declines ? { declines: def.declines } : {}) };
}

const EXTENSION = /^\.[a-z0-9_+-]+$/;
export const isFormatterId = (id: string): id is FormatterId => (FORMATTER_IDS as readonly string[]).includes(id);
/** A custom formatter's extension as stored (#749): trimmed and lowercased, so `.SQL` matches `.sql`. */
export const normalizeExtension = (text: string): string => text.trim().toLowerCase();
/** Whether a stored extension has its dot and nothing else a name's tail cannot hold (#749). */
export const isExtension = (text: string): boolean => EXTENSION.test(text);
/** A custom formatter's name (#749): WORKSPACE_NAME's shape, since it is a segment of its channel's id, and never a supported id. */
export const isCustomName = (name: string): boolean => WORKSPACE_NAME.test(name) && !isFormatterId(name);
