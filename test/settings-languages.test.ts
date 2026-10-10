import { test } from 'node:test';
import assert from 'node:assert/strict';
import { languageDef } from '../src/languages.js';
import { attentionCount, detectionOf, isInstalledLanguage, languageStatus, listOf, matchesLanguage, shownLanguages, summaryOf, toggleScope, withInstallEvent } from '../src/ui/lib/settings-languages.js';
import { type EditorInstalls, type InstallState, SERVER_IDS, SYNTAX_IDS } from '../src/types.js';

const ABSENT: InstallState = { state: 'absent' };
const installs = (patch: { servers?: Partial<EditorInstalls['servers']>; syntaxes?: Partial<EditorInstalls['syntaxes']> } = {}): EditorInstalls => ({
  servers: { ...Object.fromEntries(SERVER_IDS.map((id) => [id, ABSENT])), ...patch.servers } as EditorInstalls['servers'],
  syntaxes: { ...Object.fromEntries(SYNTAX_IDS.map((id) => [id, ABSENT])), ...patch.syntaxes } as EditorInstalls['syntaxes'],
});
const name = (id: string): string => ({ typescript: 'TypeScript e JavaScript', python: 'Python', cpp: 'C e C++' } as Record<string, string>)[id] ?? id;

test('a language\'s status word, most urgent first: installing › failed › requires › update (#780)', () => {
  const python = languageDef('python');
  assert.equal(languageStatus(python, installs()), undefined);
  assert.deepEqual(languageStatus(python, installs({ servers: { pyright: { state: 'installed', version: '1', latest: '2' } } })), { kind: 'update' });
  assert.deepEqual(languageStatus(python, installs({ servers: { pyright: { state: 'requires', tool: 'node' } }, syntaxes: { 'vscode.python': { state: 'failed', version: '1', step: 'download', log: 'x' } } })), { kind: 'failed' });
  assert.deepEqual(languageStatus(python, installs({ servers: { pyright: { state: 'installing', percent: 5 } }, syntaxes: { 'vscode.python': { state: 'failed', version: '1', step: 'download', log: 'x' } } })), { kind: 'installing' });
  assert.equal(attentionCount(installs({ servers: { pyright: { state: 'requires', tool: 'node' } } })), 1);
});

test('installed means a builtin syntax, or an installed syntax or server; the summary lists the server and the formatters found (#780)', () => {
  assert.equal(isInstalledLanguage(languageDef('typescript'), installs()), true);
  assert.equal(isInstalledLanguage(languageDef('python'), installs()), false);
  const done = installs({ servers: { pyright: { state: 'installed', version: '1.2.3' } } });
  assert.equal(isInstalledLanguage(languageDef('python'), done), true);
  assert.deepEqual(summaryOf(languageDef('python'), done, [{ id: 'ruff', found: ['hive'] }, { id: 'black', found: [] }]), ['pyright', 'ruff']);
});

test('the filter matches name, extension, server, syntax package and formatter, accents and case aside; the toggle narrows (#780)', () => {
  assert.equal(matchesLanguage(languageDef('typescript'), 'TypeScript e JavaScript', 'TYPÉSCRIPT'), true);
  assert.equal(matchesLanguage(languageDef('rust'), 'Rust', '.rs'), true);
  assert.equal(matchesLanguage(languageDef('python'), 'Python', 'pyright'), true);
  assert.equal(matchesLanguage(languageDef('python'), 'Python', 'ruff'), true);
  assert.equal(matchesLanguage(languageDef('python'), 'Python', 'clangd'), false);
  assert.deepEqual(shownLanguages('c++', 'all', installs(), name).map((d) => d.id), ['cpp']);
  assert.deepEqual(shownLanguages('', 'attention', installs({ servers: { gopls: { state: 'requires', tool: 'go' } } }), name).map((d) => d.id), ['go']);
  assert.ok(shownLanguages('', 'installed', installs(), name).every((d) => d.syntax === 'builtin'));
});

test('toggleScope: unticking one from all gives the list without it; a list keeps the workspaces\' order; ticking every one stays a list (#780)', () => {
  const names = ['hive', 'web', 'api'];
  assert.deepEqual(toggleScope('all', 'web', false, names), ['hive', 'api']);
  assert.deepEqual(toggleScope(['api'], 'hive', true, names), ['hive', 'api']);
  assert.deepEqual(toggleScope(['hive', 'api'], 'web', true, names), ['hive', 'web', 'api']);
  assert.deepEqual(toggleScope(['hive'], 'hive', false, names), []);
});

test('detectionOf: found in the scope\'s workspaces, not found, or off everywhere for empty chips; listOf joins with and (#780)', () => {
  assert.deepEqual(detectionOf({ id: 'ruff', found: ['hive', 'web'] }, ['web']), { kind: 'found', workspaces: ['web'] });
  assert.deepEqual(detectionOf({ id: 'ruff', found: ['hive'] }, ['web']), { kind: 'notFound' });
  assert.deepEqual(detectionOf({ id: 'ruff', found: ['hive'] }, []), { kind: 'off' });
  assert.deepEqual(detectionOf(undefined, 'all'), { kind: 'unknown' });
  assert.deepEqual([listOf(['a'], 'e'), listOf(['a', 'b', 'c'], 'e')], ['a', 'a, b e c']);
});

test('withInstallEvent replaces one item\'s state (#780)', () => {
  const next = withInstallEvent(installs(), { kind: 'syntax', id: 'vscode.go', state: { state: 'installing', percent: 40 } });
  assert.deepEqual(next.syntaxes['vscode.go'], { state: 'installing', percent: 40 });
  assert.deepEqual(next.servers.gopls, ABSENT);
});
