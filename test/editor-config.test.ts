import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEditorConfig } from '../src/editor-config.js';
import { EDITOR_DEFAULTS } from '../src/types.js';

const W = ['hive', 'web'];
const SQL = { name: 'sqlfluff', command: 'sqlfluff format -', extensions: ['.sql'], workspaces: 'all' };
const withLanguages = (languages: unknown): unknown => ({ ...EDITOR_DEFAULTS, languages });

test('parseEditorConfig keeps a valid config, rebuilt: custom extensions trimmed and lowercased, a stray key dropped (#780)', () => {
  const raw = withLanguages({
    python: { server: { workspaces: ['hive'] }, formatters: { ruff: { enabled: false, args: ['--x'], workspaces: ['web'], stray: 1 } } },
    sql: { custom: [{ ...SQL, extensions: [' .SQL'] }] },
  });
  assert.deepEqual(parseEditorConfig(raw, W), {
    formatOnSave: { enabled: true, workspaces: 'all' },
    languages: { python: { server: { workspaces: ['hive'] }, formatters: { ruff: { enabled: false, args: ['--x'], workspaces: ['web'] } } }, sql: { custom: [SQL] } },
  });
  assert.deepEqual(parseEditorConfig(EDITOR_DEFAULTS, W), EDITOR_DEFAULTS);
});

test('parseEditorConfig answers the first problem with its key (#780)', () => {
  const cases: [unknown, RegExp][] = [
    [undefined, /^editor is required/],
    [{ formatOnSave: { enabled: 'yes', workspaces: 'all' }, languages: {} }, /^editor\.formatOnSave must be/],
    [{ formatOnSave: { enabled: true, workspaces: ['gone'] }, languages: {} }, /^editor\.formatOnSave\.workspaces names workspace gone, which is not in comb\.workspaces$/],
    [{ formatOnSave: { enabled: true, workspaces: ['hive', 'hive'] }, languages: {} }, /^editor\.formatOnSave\.workspaces names hive twice$/],
    [withLanguages({ cobol: {} }), /^editor\.languages\.cobol is not a language \(known: typescript, python/],
    [withLanguages({ markdown: { server: { workspaces: 'all' } } }), /^editor\.languages\.markdown\.server: markdown has no language server$/],
    [withLanguages({ python: { formatters: { eslint: { enabled: true, args: [], workspaces: 'all' } } } }), /^editor\.languages\.python\.formatters\.eslint is not a supported formatter/],
    [withLanguages({ python: { formatters: { prettier: { enabled: true, args: [], workspaces: 'all' } } } }), /^editor\.languages\.python\.formatters\.prettier: prettier does not format python$/],
    [withLanguages({ python: { formatters: { ruff: { enabled: true, args: '--x', workspaces: 'all' } } } }), /^editor\.languages\.python\.formatters\.ruff must be/],
    [withLanguages({ sql: { custom: [{ ...SQL, name: 'my sql' }] } }), /^editor\.languages\.sql\.custom\[0\]\.name must be/],
    [withLanguages({ sql: { custom: [{ ...SQL, name: 'ruff' }] } }), /^editor\.languages\.sql\.custom\[0\]\.name must be/],
    [withLanguages({ sql: { custom: [{ ...SQL, command: ' ' }] } }), /^editor\.languages\.sql\.custom\[0\]\.command must be a non-empty string$/],
    [withLanguages({ sql: { custom: [{ ...SQL, extensions: ['sql'] }] } }), /^editor\.languages\.sql\.custom\[0\]\.extensions must be/],
    [withLanguages({ sql: { custom: [{ ...SQL, workspaces: ['gone'] }] } }), /^editor\.languages\.sql\.custom\[0\]\.workspaces names workspace gone/],
    [withLanguages({ sql: { custom: [SQL, SQL] } }), /^editor\.languages\.sql\.custom\[1\]\.name must be unique in its language$/],
  ];
  for (const [raw, message] of cases) assert.match(String(parseEditorConfig(raw, W)), message, JSON.stringify(raw));
});

test('a custom formatter\'s name repeats across languages (#780)', () => {
  const parsed = parseEditorConfig(withLanguages({ sql: { custom: [SQL] }, other: { custom: [{ ...SQL, extensions: ['.proto'] }] } }), W);
  assert.equal(typeof parsed, 'object');
});

test('checkers parse as the formatters do: kept rebuilt, an unknown id and a checker of another language refused with their key (#782)', () => {
  const mypy = { enabled: false, args: ['--strict'], workspaces: ['hive'] };
  assert.deepEqual(parseEditorConfig(withLanguages({ python: { checkers: { mypy: { ...mypy, stray: 1 } } } }), W), { ...EDITOR_DEFAULTS, languages: { python: { checkers: { mypy } } } });
  const cases: [unknown, RegExp][] = [
    [withLanguages({ python: { checkers: [] } }), /^editor\.languages\.python\.checkers must be an object keyed by checker id$/],
    [withLanguages({ python: { checkers: { flake8: mypy } } }), /^editor\.languages\.python\.checkers\.flake8 is not a supported checker \(known: biome, eslint/],
    [withLanguages({ python: { checkers: { tsc: mypy } } }), /^editor\.languages\.python\.checkers\.tsc: tsc does not check python$/],
    [withLanguages({ python: { checkers: { mypy: { ...mypy, args: '--strict' } } } }), /^editor\.languages\.python\.checkers\.mypy must be/],
    [withLanguages({ python: { checkers: { mypy: { ...mypy, workspaces: ['gone'] } } } }), /^editor\.languages\.python\.checkers\.mypy\.workspaces names workspace gone/],
  ];
  for (const [raw, message] of cases) assert.match(String(parseEditorConfig(raw, W)), message, JSON.stringify(raw));
});
