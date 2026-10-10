import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHECKERS, checkArgv, checkerOfServer, checkerOn, checkersOf, cliCheckerDef, cliCheckersFor, shownCommand } from '../src/checkers.js';
import { LANGUAGES, serverDef } from '../src/languages.js';
import { CHECKER_IDS, CLI_CHECKER_IDS, EDITOR_DEFAULTS, type EditorConfig, type LanguageId } from '../src/types.js';

const ids = (language: LanguageId): string[] => checkersOf(language).map((c) => c.id);

test('the catalog lists every checker id once, in their order: six language-server ones then nineteen command-line ones, each on a language of the catalog (#782)', () => {
  assert.deepEqual(CHECKERS.map((c) => c.id), [...CHECKER_IDS]);
  assert.deepEqual(CHECKERS.filter((c) => c.kind === 'cli').map((c) => c.id), [...CLI_CHECKER_IDS]);
  assert.equal(CHECKERS.filter((c) => c.kind === 'lsp').length, 6);
  assert.equal(CLI_CHECKER_IDS.length, 19);
  for (const c of CHECKERS) assert.ok(c.languages.length > 0 && c.languages.every((l) => LANGUAGES.some((d) => d.id === l)), c.id);
  for (const c of CHECKERS) if (c.kind === 'lsp') assert.equal(serverDef(c.server).id, c.server);
});

test('every language maps to its checkers; the stylesheets and pages of web each to their own; a checker server knows its row (#782)', () => {
  assert.deepEqual(ids('typescript'), ['biome', 'eslint', 'oxlint', 'tsc']);
  assert.deepEqual(ids('python'), ['ruff', 'mypy', 'pylint']);
  assert.deepEqual(ids('web'), ['biome', 'stylelint', 'htmlhint']);
  assert.deepEqual(ids('go'), ['golangci-lint', 'staticcheck']);
  assert.deepEqual(ids('dart'), ['dart', 'dart-analyze']);
  assert.deepEqual(ids('kotlin'), ['ktlint', 'detekt']);
  assert.deepEqual([ids('cpp'), ids('shell'), ids('toml'), ids('other')], [[], [], [], []]);
  assert.deepEqual(cliCheckersFor('web', '/w/a.SCSS').map((c) => c.id), ['stylelint']);
  assert.deepEqual(cliCheckersFor('web', '/w/index.html').map((c) => c.id), ['htmlhint']);
  assert.deepEqual(cliCheckersFor('web', '/w/a.json'), []);
  assert.equal(checkerOfServer('ruff')?.id, 'ruff');
  assert.equal(checkerOfServer('pyright'), undefined);
});

test('checkerOn: absent from the config a checker is on everywhere; else its switch and its scope (#782)', () => {
  const editor: EditorConfig = {
    ...EDITOR_DEFAULTS,
    languages: { python: { checkers: { mypy: { enabled: true, args: [], workspaces: ['hive'] }, pylint: { enabled: false, args: [], workspaces: 'all' } } } },
  };
  assert.deepEqual(
    [checkerOn(editor, 'python', 'ruff', 'web'), checkerOn(editor, 'python', 'mypy', 'hive'), checkerOn(editor, 'python', 'mypy', 'web'), checkerOn(editor, 'python', 'pylint', 'hive')],
    [true, true, false, false],
  );
});

test('a command line is the subcommand, the extra args, then the catalog\'s flags; Settings shows the file as "$FILE" and a server as its binary and args (#782)', () => {
  assert.deepEqual(checkArgv(cliCheckerDef('golangci-lint'), ['--fast'], '/w/a.go', ''), ['run', '--fast', '--output.json.path=stdout', './...']);
  assert.deepEqual(checkArgv(cliCheckerDef('detekt'), [], '/w/A.kt', '/t/report.sarif'), ['--input', '/w/A.kt', '--report', 'sarif:/t/report.sarif']);
  assert.equal(shownCommand(cliCheckerDef('mypy'), ['--strict']), 'mypy --strict --show-column-numbers -O json "$FILE"');
  assert.equal(shownCommand(cliCheckerDef('tsc'), []), 'tsc --noEmit --pretty false');
  assert.equal(shownCommand(cliCheckerDef('clippy'), []), 'cargo clippy --message-format=json');
  assert.equal(shownCommand(checkersOf('python')[0], []), 'ruff server');
  assert.equal(shownCommand(checkersOf('dart')[0], []), 'dart language-server --protocol=lsp');
  assert.equal(shownCommand(checkersOf('typescript')[1], ['--x']), 'vscode-eslint-language-server --stdio --x');
});
