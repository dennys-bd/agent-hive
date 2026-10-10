import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candidatesFor, FORMATTERS, formattersOf, otherExtensions, pickFormatter } from '../src/formatters.js';
import { type CustomFormatter, EDITOR_DEFAULTS, type EditorConfig, FORMATTER_IDS, type FormatterId } from '../src/types.js';

// Every supported formatter installed at /bin/<id>: what a detection on a machine with all of them answers
const ALL: Partial<Record<FormatterId, string>> = Object.fromEntries(FORMATTER_IDS.map((id) => [id, `/bin/${id}`]));
const editor = (languages: EditorConfig['languages'] = {}): EditorConfig => ({ ...EDITOR_DEFAULTS, languages });
const off = (workspaces: EditorConfig['formatOnSave']['workspaces'] = 'all') => ({ enabled: false, args: [], workspaces });
const SQL: CustomFormatter = { name: 'sqlfluff', command: 'sqlfluff format -', extensions: ['.sql'], workspaces: 'all' };

test('the table holds every supported id once, in FORMATTER_IDS order; extensions are lowercase with their dot, the last candidate is the bare binary (#749)', () => {
  assert.deepEqual(FORMATTERS.map((d) => d.id), [...FORMATTER_IDS]);
  for (const def of FORMATTERS) {
    assert.ok(def.extensions.every((e) => /^\.[a-z0-9]+$/.test(e)), def.id);
    assert.ok(!(def.candidates.at(-1) ?? '/').includes('/'), def.id);
  }
});

test('pickFormatter takes the language\'s custom formatter in scope first, then the supported ones in table order that are on, in scope and found (#780)', () => {
  assert.deepEqual(pickFormatter(editor({ sql: { custom: [SQL] } }), '/w/q.sql', 'hive', ALL), { kind: 'custom', name: 'sqlfluff', command: 'sqlfluff format -' });
  assert.equal(pickFormatter(editor({ sql: { custom: [{ ...SQL, workspaces: ['web'] }] } }), '/w/q.sql', 'hive', ALL), undefined);
  assert.equal(pickFormatter(editor(), '/w/a.ts', 'hive', ALL)?.name, 'biome');
  assert.equal(pickFormatter(editor({ typescript: { formatters: { biome: off() } } }), '/w/a.ts', 'hive', ALL)?.name, 'prettier');
  assert.equal(pickFormatter(editor({ typescript: { formatters: { biome: { enabled: true, args: [], workspaces: ['web'] } } } }), '/w/a.ts', 'hive', ALL)?.name, 'prettier');
  assert.equal(pickFormatter(editor(), '/w/a.ts', 'hive', {}), undefined);
});

test('prettier off in Markdown stays on in TypeScript: one entry per language (#780)', () => {
  const md = editor({ markdown: { formatters: { prettier: off() } } });
  const { biome: _biome, ...noBiome } = ALL;
  assert.equal(pickFormatter(md, '/w/README.md', 'hive', ALL), undefined);
  assert.equal(pickFormatter(md, '/w/a.ts', 'hive', noBiome)?.name, 'prettier');
});

test('a formatter of the language that does not take the extension is skipped: biome takes .css, not .scss (#780)', () => {
  assert.equal(pickFormatter(editor(), '/w/a.css', 'hive', ALL)?.name, 'biome');
  assert.equal(pickFormatter(editor(), '/w/a.scss', 'hive', ALL)?.name, 'prettier');
});

test('a custom formatter of other takes an extension no language has (#780)', () => {
  const proto = editor({ other: { custom: [{ ...SQL, name: 'buf', extensions: ['.proto'] }] } });
  assert.deepEqual(otherExtensions(proto), ['.proto']);
  assert.equal(pickFormatter(proto, '/w/a.proto', 'hive', ALL)?.name, 'buf');
  assert.equal(pickFormatter(editor(), '/w/a.proto', 'hive', ALL), undefined);
});

test('a supported pick runs its binary with the extra args right after it, then the tool\'s argv with the file (#749)', () => {
  const pick = pickFormatter(editor({ python: { formatters: { ruff: { enabled: true, args: ['--line-length', '100'], workspaces: 'all' } } } }), '/w/a.py', 'hive', ALL);
  assert.ok(pick?.kind === 'supported');
  assert.equal(pick.binary, '/bin/ruff');
  assert.deepEqual(pick.argv('/w/a.py'), ['--line-length', '100', 'format', '--stdin-filename', '/w/a.py', '-']);
});

test('candidatesFor lists what a save detects: on, in scope, taking the extension; formattersOf lists a language\'s formatters, prettier serving other (#780)', () => {
  assert.deepEqual(candidatesFor(editor({ python: { formatters: { ruff: off() } } }), '/w/a.py', 'hive'), ['black']);
  assert.deepEqual(candidatesFor(editor(), '/w/notes.xyz', 'hive'), []);
  assert.deepEqual(formattersOf('typescript'), ['biome', 'prettier']);
  assert.deepEqual(formattersOf('other'), ['prettier']);
  assert.deepEqual(formattersOf('cpp'), ['clang-format']);
});
