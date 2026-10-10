import { extensionOf, inScope, serverDef } from './languages.js';
import { CHECKER_IDS, type CheckerId, CLI_CHECKER_IDS, type CliCheckerId, type EditorConfig, type LanguageId, type ServerId } from './types.js';

// The checkers (#782): those with their own language server, which the Hive installs as it installs a language's (src/languages.ts holds
// their servers' recipes), and the command-line ones, which only the project or the PATH provides and which run on save. No I/O, no node import:
// the daemon, the parser and the page read it. The rows are the ones docs/agent/hive/plans/2026-10-06-error-checkers/catalog-check.md confirmed.

/** How a command-line checker's report reads (#782): one parser each in src/checker-parse*.ts. gnu is `path:line:col: [severity] message`. */
export type CheckFormat =
  | 'tsc' | 'mypy' | 'pylint' | 'golangci' | 'staticcheck' | 'cargo' | 'selene' | 'gnu' | 'stylelint' | 'htmlhint' | 'markdownlint' | 'sqlfluff'
  | 'swiftlint' | 'dart' | 'credo' | 'ktlint' | 'sarif';
/** What a command-line checker's run covers (#782): the saved file alone, or the whole activity. */
export type CheckScope = 'file' | 'project';
export interface LspCheckerDef {
  kind: 'lsp'; id: Exclude<CheckerId, CliCheckerId>; languages: readonly LanguageId[]; server: ServerId;
  project: readonly string[]; // the project's copy, under the activity's folder: Settings' detection, and the launch when launchesProject
  launchesProject: boolean; // false for eslint: its server is always the Hive's, and loads the project's eslint itself
}
export interface CliCheckerDef {
  kind: 'cli'; id: CliCheckerId; languages: readonly LanguageId[];
  extensions?: readonly string[]; // only these of its languages' extensions: web's stylesheets for stylelint, its pages for htmlhint
  candidates: readonly string[]; // as a formatter's: one with a slash under the activity's folder, a bare name on PATH
  sub: readonly string[]; // the binary's fixed subcommand, before the extra args
  flags(file: string, report: string): string[]; // after the extra args; report: detekt's SARIF file in a temp folder
  scope: CheckScope;
  format: CheckFormat;
  output?: 'stderr' | 'file'; // where the report is; stdout when absent
}
export type CheckerDef = LspCheckerDef | CliCheckerDef;

const languagesOf = (text: string): LanguageId[] => text.split(' ') as LanguageId[];
const lsp = (id: LspCheckerDef['id'], languages: string, project: string[], launchesProject = true): LspCheckerDef =>
  ({ kind: 'lsp', id, languages: languagesOf(languages), server: id, project, launchesProject });
type CliRow = Omit<CliCheckerDef, 'kind' | 'languages'> & { languages: string };
const cli = (row: CliRow): CliCheckerDef => ({ ...row, kind: 'cli', languages: languagesOf(row.languages) });
const onFile = (...flags: string[]) => (file: string): string[] => [...flags, file];
const fixed = (...flags: string[]) => (): string[] => flags;
const NO_SUB: readonly string[] = [];

export const CHECKERS: readonly CheckerDef[] = [
  lsp('biome', 'typescript web', ['node_modules/.bin/biome']),
  lsp('eslint', 'typescript', ['node_modules/.bin/eslint'], false),
  lsp('oxlint', 'typescript', ['node_modules/.bin/oxlint']),
  lsp('ruff', 'python', ['.venv/bin/ruff']),
  lsp('tflint', 'terraform', []),
  lsp('dart', 'dart', []),
  cli({ id: 'tsc', languages: 'typescript', candidates: ['node_modules/.bin/tsc', 'tsc'], sub: NO_SUB, flags: fixed('--noEmit', '--pretty', 'false'), scope: 'project', format: 'tsc' }),
  cli({ id: 'mypy', languages: 'python', candidates: ['.venv/bin/mypy', 'mypy'], sub: NO_SUB, flags: onFile('--show-column-numbers', '-O', 'json'), scope: 'file', format: 'mypy' }),
  cli({ id: 'pylint', languages: 'python', candidates: ['.venv/bin/pylint', 'pylint'], sub: NO_SUB, flags: onFile('--output-format=json2'), scope: 'file', format: 'pylint' }),
  cli({ id: 'golangci-lint', languages: 'go', candidates: ['golangci-lint'], sub: ['run'], flags: fixed('--output.json.path=stdout', './...'), scope: 'project', format: 'golangci' }),
  cli({ id: 'staticcheck', languages: 'go', candidates: ['staticcheck'], sub: NO_SUB, flags: fixed('-f', 'json', './...'), scope: 'project', format: 'staticcheck' }),
  cli({ id: 'clippy', languages: 'rust', candidates: ['cargo'], sub: ['clippy'], flags: fixed('--message-format=json'), scope: 'project', format: 'cargo' }),
  cli({ id: 'selene', languages: 'lua', candidates: ['selene'], sub: NO_SUB, flags: onFile('--display-style', 'json2'), scope: 'file', format: 'selene' }),
  cli({ id: 'luacheck', languages: 'lua', candidates: ['luacheck'], sub: NO_SUB, flags: onFile('--formatter', 'plain', '--codes', '--ranges'), scope: 'file', format: 'gnu' }),
  cli({ id: 'yamllint', languages: 'yaml', candidates: ['.venv/bin/yamllint', 'yamllint'], sub: NO_SUB, flags: onFile('-f', 'parsable'), scope: 'file', format: 'gnu' }),
  // stylelint 16 prints its problems on stderr
  cli({ id: 'stylelint', languages: 'web', extensions: ['.css', '.scss', '.less'], candidates: ['node_modules/.bin/stylelint', 'stylelint'], sub: NO_SUB, flags: onFile('-f', 'json'), scope: 'file', format: 'stylelint', output: 'stderr' }),
  cli({ id: 'htmlhint', languages: 'web', extensions: ['.html'], candidates: ['node_modules/.bin/htmlhint', 'htmlhint'], sub: NO_SUB, flags: onFile('-f', 'json'), scope: 'file', format: 'htmlhint' }),
  cli({ id: 'markdownlint', languages: 'markdown', candidates: ['node_modules/.bin/markdownlint', 'markdownlint'], sub: NO_SUB, flags: onFile('--json'), scope: 'file', format: 'markdownlint', output: 'stderr' }),
  cli({ id: 'sqlfluff', languages: 'sql', candidates: ['.venv/bin/sqlfluff', 'sqlfluff'], sub: ['lint'], flags: onFile('--format', 'json'), scope: 'file', format: 'sqlfluff' }),
  cli({ id: 'swiftlint', languages: 'swift', candidates: ['swiftlint'], sub: ['lint'], flags: onFile('--reporter', 'json'), scope: 'file', format: 'swiftlint' }),
  cli({ id: 'dart-analyze', languages: 'dart', candidates: ['dart'], sub: ['analyze'], flags: fixed('--format=json'), scope: 'project', format: 'dart' }),
  cli({ id: 'credo', languages: 'elixir', candidates: ['mix'], sub: ['credo'], flags: fixed('--format', 'json'), scope: 'project', format: 'credo' }),
  cli({ id: 'ktlint', languages: 'kotlin', candidates: ['ktlint'], sub: NO_SUB, flags: onFile('--reporter=json'), scope: 'file', format: 'ktlint' }),
  cli({ id: 'detekt', languages: 'kotlin', candidates: ['detekt'], sub: NO_SUB, flags: (file, report) => ['--input', file, '--report', `sarif:${report}`], scope: 'file', format: 'sarif', output: 'file' }),
  cli({ id: 'zig-ast-check', languages: 'zig', candidates: ['zig'], sub: ['ast-check'], flags: onFile(), scope: 'file', format: 'gnu', output: 'stderr' }),
];

const BY_ID = Object.fromEntries(CHECKERS.map((def) => [def.id, def])) as Record<CheckerId, CheckerDef>;
export const checkerDef = (id: CheckerId): CheckerDef => BY_ID[id];
export const cliCheckerDef = (id: CliCheckerId): CliCheckerDef => BY_ID[id] as CliCheckerDef;
export const isCheckerId = (id: string): id is CheckerId => (CHECKER_IDS as readonly string[]).includes(id);
export const isCliCheckerId = (id: string): id is CliCheckerId => (CLI_CHECKER_IDS as readonly string[]).includes(id);

/** A language's checkers (#782), in the catalog's order: its language-server ones, then its command-line ones. */
export const checkersOf = (language: LanguageId): CheckerDef[] => CHECKERS.filter((def) => def.languages.includes(language));
export const lspCheckersOf = (language: LanguageId): LspCheckerDef[] => checkersOf(language).filter((def): def is LspCheckerDef => def.kind === 'lsp');

/** The command-line checkers that read `file` (#782): its language's, a checker that names extensions only on those. */
export const cliCheckersFor = (language: LanguageId, file: string): CliCheckerDef[] =>
  checkersOf(language).filter((def): def is CliCheckerDef => def.kind === 'cli' && (def.extensions === undefined || def.extensions.includes(extensionOf(file))));

/** The checker whose own server `id` is (#782); undefined for a language's server. */
export const checkerOfServer = (id: ServerId): LspCheckerDef | undefined => CHECKERS.find((def): def is LspCheckerDef => def.kind === 'lsp' && def.server === id);

/** Whether a checker runs for `workspace` (#782): absent from the config it is on everywhere; else its switch and its scope. */
export function checkerOn(editor: EditorConfig, language: LanguageId, id: CheckerId, workspace: string): boolean {
  const setting = editor.languages[language]?.checkers?.[id];
  return setting === undefined || (setting.enabled && inScope(setting.workspaces, workspace));
}

/** A command-line checker's argv (#782): the subcommand, the user's extra args, then the catalog's flags. */
export const checkArgv = (def: CliCheckerDef, args: readonly string[], file: string, report: string): string[] => [...def.sub, ...args, ...def.flags(file, report)];

/** The command Settings shows (#782), display only and never run by a shell: the file as "$FILE"; a server's binary with its args, then the extra ones. */
export function shownCommand(def: CheckerDef, args: readonly string[]): string {
  if (def.kind === 'lsp') {
    const server = serverDef(def.server);
    return [server.binaries[0], ...server.args, ...args].join(' ');
  }
  const name = def.candidates.at(-1)?.split('/').at(-1) ?? def.id;
  return [name, ...checkArgv(def, args, '"$FILE"', '<report>')].join(' ');
}
