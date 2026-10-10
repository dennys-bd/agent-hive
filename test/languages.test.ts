import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHECKERS } from '../src/checkers.js';
import { FORMATTERS } from '../src/formatters.js';
import { extensionOf, inScope, LANGUAGES, languageOf, languagesOfServer, lspLanguageId, requiredTools, runtimeTools, serverDef, SERVERS, serverFor, SYNTAXES } from '../src/languages.js';
import { LANGUAGE_IDS, SERVER_IDS, SYNTAX_IDS } from '../src/types.js';

const AT = { dir: '/h/editor/servers/x', arch: 'arm64' as const, version: '21.1.0' };

test('the catalog lists every language, server and syntax id once, in their ids\' order; every syntax package and every server belongs to a language (#780)', () => {
  assert.deepEqual(LANGUAGES.map((l) => l.id), [...LANGUAGE_IDS]);
  assert.deepEqual(SERVERS.map((s) => s.id), [...SERVER_IDS]);
  assert.deepEqual(SYNTAXES.map((s) => s.id), [...SYNTAX_IDS]);
  for (const id of SERVER_IDS) assert.ok(LANGUAGES.some((l) => l.server === id) || CHECKERS.some((c) => c.kind === 'lsp' && c.server === id), id);
  for (const id of SYNTAX_IDS) assert.ok(LANGUAGES.some((l) => l.syntax === id), id);
  assert.ok(LANGUAGES.every((l) => l.extensions.every((e) => /^\.[a-z0-9]+$/.test(e))));
});

test('every supported formatter\'s extension maps to exactly one language; .vue and .graphql to other (#780)', () => {
  for (const ext of FORMATTERS.flatMap((def) => def.extensions)) {
    assert.equal(LANGUAGES.filter((l) => l.extensions.includes(ext)).length, 1, ext);
  }
  assert.deepEqual([languageOf('/w/App.vue'), languageOf('/w/q.graphql')], ['other', 'other']);
});

test('languageOf lowercases the extension, answers undefined for one no language has, and takes other for an extension its custom formatters list (#780)', () => {
  assert.deepEqual([languageOf('/w/a.PY'), languageOf('/w/b.mm'), languageOf('/w/c.h'), languageOf('/w/Makefile')], ['python', 'objective-c', 'cpp', undefined]);
  assert.equal(languageOf('/w/a.proto'), undefined);
  assert.equal(languageOf('/w/a.proto', ['.proto']), 'other');
  assert.equal(extensionOf('/w/a.d.TS'), '.ts');
});

test('inScope: all takes any workspace, a list its own names, an empty list none (#780)', () => {
  assert.deepEqual([inScope('all', 'web'), inScope(['hive'], 'hive'), inScope(['hive'], 'web'), inScope([], 'hive')], [true, true, false, false]);
});

test('serverFor picks web\'s binary by extension; cpp and objective-c share clangd; markdown has none (#780)', () => {
  assert.equal(serverFor('web', '.css')?.binary, 'vscode-css-language-server');
  assert.equal(serverFor('web', '.SCSS')?.binary, 'vscode-css-language-server');
  assert.equal(serverFor('web', '.jsonc')?.binary, 'vscode-json-language-server');
  assert.deepEqual([serverFor('cpp', '.c')?.server.id, serverFor('objective-c', '.m')?.server.id], ['clangd', 'clangd']);
  assert.deepEqual(languagesOfServer('clangd'), ['cpp', 'objective-c']);
  assert.equal(serverFor('markdown', '.md'), undefined);
});

test('a server launches from its folder: npm through node and its .bin, GitHub binaries by their archive\'s path, gopls from GOBIN (#780)', () => {
  assert.deepEqual(serverDef('pyright').launch(AT, 'pyright-langserver'), { command: 'node', args: ['/h/editor/servers/x/node_modules/.bin/pyright-langserver', '--stdio'] });
  assert.deepEqual(serverDef('clangd').launch(AT, 'clangd'), { command: '/h/editor/servers/x/clangd_21.1.0/bin/clangd', args: [] });
  assert.deepEqual(serverDef('taplo').launch(AT, 'taplo'), { command: '/h/editor/servers/x/bin/taplo', args: ['lsp', 'stdio'] });
  assert.deepEqual(serverDef('gopls').launch(AT, 'gopls'), { command: '/h/editor/servers/x/bin/gopls', args: [] });
  assert.equal(serverDef('rust-analyzer').asset?.('2025-10-06', 'x64'), 'rust-analyzer-x86_64-apple-darwin.gz');
  assert.equal(serverDef('lua-language-server').asset?.('3.15.0', 'arm64'), 'lua-language-server-3.15.0-darwin-arm64.tar.gz');
  assert.equal(serverDef('clangd').asset?.('21.1.0', 'arm64'), 'clangd-mac-21.1.0.zip');
});

test('typescript-language-server installs typescript 6: typescript 7 ships no tsserver and the server refuses to start on it (#780 catalog check)', () => {
  assert.deepEqual(serverDef('typescript-language-server').packages, ['typescript-language-server', 'typescript@6']);
});

test('requiredTools and runtimeTools: npm needs node and npm to install, node to run; gopls needs go; a GitHub binary nothing (#780)', () => {
  assert.deepEqual([requiredTools(serverDef('pyright')), requiredTools(serverDef('gopls')), requiredTools(serverDef('clangd'))], [['node', 'npm'], ['go'], []]);
  assert.deepEqual([runtimeTools(serverDef('pyright')), runtimeTools(serverDef('gopls'))], [['node'], []]);
});

test('lspLanguageId names a file as LSP servers expect it (#780)', () => {
  assert.deepEqual(['a.tsx', 'b.mjs', 'c.h', 'd.mm', 'e.sh', 'f.yml', 'g.py', 'h.txt'].map(lspLanguageId),
    ['typescriptreact', 'javascript', 'c', 'objective-cpp', 'shellscript', 'yaml', 'python', 'plaintext']);
});

test('the checkers\' servers (#782): biome, eslint and oxlint through node, ruff and tflint from their archives, dart from PATH', () => {
  assert.deepEqual(serverDef('biome').launch(AT, 'biome'), { command: 'node', args: ['/h/editor/servers/x/node_modules/.bin/biome', 'lsp-proxy'] });
  assert.deepEqual(serverDef('eslint').binaries, ['vscode-eslint-language-server']);
  assert.deepEqual(serverDef('oxlint').args, ['--lsp']);
  assert.deepEqual(serverDef('ruff').launch(AT, 'ruff'), { command: '/h/editor/servers/x/ruff-aarch64-apple-darwin/ruff', args: ['server'] });
  assert.equal(serverDef('ruff').asset?.('0.13.2', 'x64'), 'ruff-x86_64-apple-darwin.tar.gz');
  assert.equal(serverDef('tflint').asset?.('0.59.1', 'x64'), 'tflint_darwin_amd64.zip');
  assert.deepEqual(serverDef('tflint').launch(AT, 'tflint'), { command: '/h/editor/servers/x/tflint', args: ['--langserver'] });
  assert.deepEqual(serverDef('dart').launch(AT, 'dart'), { command: 'dart', args: ['language-server', '--protocol=lsp'] });
  assert.deepEqual([requiredTools(serverDef('dart')), runtimeTools(serverDef('dart'))], [['dart'], ['dart']]);
});
