import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { parseConfig } from '../src/config.js';
import { editorDir } from '../src/editor-install.js';
import { type Launch, serverDef } from '../src/languages.js';
import { EDITOR_DEFAULTS, type EditorConfig, type ServerId } from '../src/types.js';
import { createWorkerLsp, hiveLaunch, renderWorkerLsp, settles, workerLaunches, workerLspPath } from '../src/worker-lsp.js';
import { combConfig, fakeLog, LOCAL_STAGES, WORKSPACE } from './fakes.js';
import { tempDir } from './temp-dir.js';

// The language servers for the workers (#803): the launch the LSP host and the workers share, the .lsp.json, the writer and run.spawned's field.

const NODE_DIR = dirname(process.execPath); // a PATH that holds node, whatever machine runs the tests

// A server's install record: all hiveLaunch reads of an installed server, as the LSP host's own resolution does
async function installServer(home: string, id: ServerId, version = '1.0.0'): Promise<void> {
  const dir = editorDir(home, { kind: 'server', id });
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'installed.json'), JSON.stringify({ version, installedAt: '2026-10-09T00:00:00.000Z' }));
}

test('hiveLaunch answers an installed server\'s launch, "not installed" without its record and "requires <tool>" when its runtime is not on PATH (#803)', async (t) => {
  const home = await tempDir(t, 'wlsp-home-');
  await installServer(home, 'pyright');
  const pyright = serverDef('pyright');
  const script = join(editorDir(home, { kind: 'server', id: 'pyright' }), 'node_modules', '.bin', 'pyright-langserver');
  assert.deepEqual(await hiveLaunch(home, pyright, 'pyright-langserver', NODE_DIR, 'arm64'), { command: 'node', args: [script, '--stdio'] }, 'the host keeps its bare node');
  assert.deepEqual(await hiveLaunch(home, pyright, 'pyright-langserver', '', 'arm64'), { reason: 'requires node' });
  assert.deepEqual(await hiveLaunch(home, serverDef('gopls'), 'gopls', NODE_DIR, 'arm64'), { reason: 'not installed' });
});

const launch = (command: string): Launch => ({ command, args: ['--stdio'] });
const editor = (languages: EditorConfig['languages'] = {}): { editor: EditorConfig } => ({ editor: { ...EDITOR_DEFAULTS, languages } });
// Every binary a test may launch, a checker's two among them: those must never reach a worker
const ALL: ReadonlyMap<string, Launch> = new Map([
  ['typescript-language-server/typescript-language-server', launch('/n/node')],
  ['clangd/clangd', launch('/h/clangd')],
  ['vscode-langservers-extracted/vscode-html-language-server', launch('/n/html')],
  ['vscode-langservers-extracted/vscode-css-language-server', launch('/n/css')],
  ['vscode-langservers-extracted/vscode-json-language-server', launch('/n/json')],
  ['biome/biome', launch('/n/biome')],
  ['eslint/vscode-eslint-language-server', launch('/n/eslint')],
]);

test('workerLaunches keys each language server binary that would launch, node as an absolute path; a server not installed, one missing its runtime and a checker\'s server are left out (#803)', async (t) => {
  const home = await tempDir(t, 'wlsp-home-');
  await installServer(home, 'pyright');
  await installServer(home, 'gopls');
  await installServer(home, 'biome'); // a checker's server: no language's own
  const launches = await workerLaunches(home, NODE_DIR, 'arm64');
  assert.deepEqual([...launches.keys()].sort(), ['gopls/gopls', 'pyright/pyright-langserver']);
  assert.equal(launches.get('pyright/pyright-langserver')?.command, join(NODE_DIR, 'node'), 'the node the editor\'s host would run');
  assert.equal(launches.get('gopls/gopls')?.command, join(editorDir(home, { kind: 'server', id: 'gopls' }), 'bin', 'gopls'));
  assert.deepEqual([...(await workerLaunches(home, '', 'arm64')).keys()], ['gopls/gopls'], 'no node on PATH: the npm server goes, the binary stays');
});

test('renderWorkerLsp: one entry per binary, named after it, each extension mapped to the languageId the editor sends; .tsx is typescriptreact; web splits over its three binaries; clangd\'s two languages merge; no checker (#803)', () => {
  const file = renderWorkerLsp(editor(), WORKSPACE, ALL);
  assert.deepEqual(Object.keys(file ?? {}).sort(), ['clangd', 'typescript-language-server', 'vscode-css-language-server', 'vscode-html-language-server', 'vscode-json-language-server']);
  assert.deepEqual(file?.['typescript-language-server'], {
    command: '/n/node', args: ['--stdio'],
    extensionToLanguage: { '.ts': 'typescript', '.tsx': 'typescriptreact', '.js': 'javascript', '.jsx': 'javascriptreact', '.mjs': 'javascript', '.cjs': 'javascript' },
  });
  assert.deepEqual(file?.clangd.extensionToLanguage, { '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.hpp': 'cpp', '.m': 'objective-c', '.mm': 'objective-cpp' });
  assert.deepEqual(file?.['vscode-html-language-server'].extensionToLanguage, { '.html': 'html' });
  assert.deepEqual(file?.['vscode-css-language-server'].extensionToLanguage, { '.css': 'css', '.scss': 'scss', '.less': 'less' });
  assert.deepEqual(file?.['vscode-json-language-server'].extensionToLanguage, { '.json': 'json', '.jsonc': 'jsonc' });
});

test('renderWorkerLsp follows each language\'s server scope: a workspace outside it gets none of that language\'s extensions; nothing left, or nothing installed, is no file (#803)', () => {
  const objcOnSite = editor({ 'objective-c': { server: { workspaces: ['site'] } } });
  assert.deepEqual(Object.keys(renderWorkerLsp(objcOnSite, WORKSPACE, ALL)?.clangd.extensionToLanguage ?? {}), ['.c', '.h', '.cc', '.cpp', '.hpp']);
  assert.equal(renderWorkerLsp(objcOnSite, 'site', ALL)?.clangd.extensionToLanguage['.m'], 'objective-c');
  const none = { workspaces: [] as string[] };
  const off = editor({ typescript: { server: none }, cpp: { server: none }, 'objective-c': { server: none }, web: { server: none } });
  assert.equal(renderWorkerLsp(off, WORKSPACE, ALL), undefined, 'every installed server out of scope');
  assert.equal(renderWorkerLsp(editor(), WORKSPACE, new Map()), undefined, 'nothing installed');
});

test('settles: a server\'s installed, absent, failed or requires state rewrites the plugins; an installing tick and a syntax package do not (#803)', () => {
  const pyright = { kind: 'server', id: 'pyright' } as const;
  const settled = [{ state: 'installed', version: '1' }, { state: 'absent' }, { state: 'failed', version: '1', step: 'npm', log: '' }, { state: 'requires', tool: 'node' }] as const;
  for (const state of settled) assert.equal(settles({ ...pyright, state }), true, state.state);
  assert.equal(settles({ ...pyright, state: { state: 'installing', percent: 40 } }), false);
  assert.equal(settles({ kind: 'syntax', id: 'vscode.go', state: { state: 'installed', version: '1' } }), false);
});

const TWO = [{ name: WORKSPACE, path: '/repo', env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)' }, { name: 'site', path: '/site', env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)' }];
const configOf = (languages: EditorConfig['languages'] = {}, workspaces = TWO) =>
  parseConfig(combConfig({ stages: LOCAL_STAGES, workspaces, editor: { ...EDITOR_DEFAULTS, languages } }));
const GOPLS = (home: string) => join(editorDir(home, { kind: 'server', id: 'gopls' }), 'bin', 'gopls');
const gone = (path: string): Promise<boolean> => access(path).then(() => false, () => true);

test('write gives each workspace its plugin (manifest and .lsp.json) and records its folder and entries; a workspace left with no server, and one removed from the config, lose their folder (#803)', async (t) => {
  const home = await tempDir(t, 'wlsp-home-');
  await installServer(home, 'gopls');
  const lsp = createWorkerLsp({ home, log: fakeLog().log, env: { PATH: '' }, arch: 'arm64' });
  await lsp.write(configOf());
  const dir = workerLspPath(home, WORKSPACE);
  assert.deepEqual([lsp.dir(WORKSPACE), lsp.servers(WORKSPACE)], [dir, ['gopls']]);
  assert.equal((JSON.parse(await readFile(join(dir, '.claude-plugin', 'plugin.json'), 'utf8')) as { name: string }).name, 'hive-lsp');
  assert.deepEqual(JSON.parse(await readFile(join(dir, '.lsp.json'), 'utf8')), { gopls: { command: GOPLS(home), args: [], extensionToLanguage: { '.go': 'go' } } });
  await lsp.write(configOf({ go: { server: { workspaces: ['site'] } } }));
  assert.deepEqual([lsp.dir(WORKSPACE), lsp.servers(WORKSPACE), await gone(dir)], [undefined, [], true], 'no server left in hive');
  assert.equal(lsp.dir('site'), workerLspPath(home, 'site'));
  await lsp.write(configOf({}, [TWO[0]]));
  assert.deepEqual([lsp.dir('site'), await gone(workerLspPath(home, 'site'))], [undefined, true], 'site left the config');
});

test('a workspace\'s own PATH is the one its runtimes are found on, as the LSP host resolves them (#803)', async (t) => {
  const home = await tempDir(t, 'wlsp-home-');
  await installServer(home, 'pyright');
  const lsp = createWorkerLsp({ home, log: fakeLog().log, env: { PATH: '' }, arch: 'arm64' });
  await lsp.write(configOf({}, [{ name: WORKSPACE, path: '/repo', env: { PATH: NODE_DIR }, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, benchmarkPrIn: 'worktree', color: 'oklch(0.72 0.12 25)' }, TWO[1]]));
  assert.deepEqual([lsp.servers(WORKSPACE), lsp.servers('site')], [['pyright-langserver'], []]);
});

test('a write that fails is logged by the error\'s class and keeps the previous folder and record (#803)', async (t) => {
  const home = await tempDir(t, 'wlsp-home-');
  await installServer(home, 'gopls');
  const { log, lines } = fakeLog();
  const lsp = createWorkerLsp({ home, log, env: { PATH: '' }, arch: 'arm64' });
  const config = configOf({}, [TWO[0]]);
  await lsp.write(config);
  const dir = workerLspPath(home, WORKSPACE);
  const before = await readFile(join(dir, '.lsp.json'), 'utf8');
  await mkdir(join(dir, '.lsp.json.tmp')); // a folder holds the temp file's name: the write fails
  await installServer(home, 'rust-analyzer');
  await lsp.write(config);
  assert.equal(await readFile(join(dir, '.lsp.json'), 'utf8'), before);
  assert.deepEqual([lsp.dir(WORKSPACE), lsp.servers(WORKSPACE)], [dir, ['gopls']]);
  assert.ok(lines.includes(`ERROR worker lsp ${WORKSPACE}: not written (Error)`), lines.join('\n'));
  assert.equal(lines.join('\n').includes(home), false, 'no path in the log');
});

test('two writes in flight run one at a time: the second waits for the first, and the later config is what stays on disk (#803)', async (t) => {
  const home = await tempDir(t, 'wlsp-home-');
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const gopls: ReadonlyMap<string, Launch> = new Map([['gopls/gopls', { command: '/g/gopls', args: [] }]]);
  const launches = async (): Promise<ReadonlyMap<string, Launch>> => {
    calls += 1;
    if (calls === 1) await held; // the first write is slow: without the chain the second would overtake it
    return gopls;
  };
  const lsp = createWorkerLsp({ home, log: fakeLog().log, env: { PATH: '' }, launches });
  const config = configOf({}, [TWO[0]]);
  const first = lsp.write(config);
  const second = lsp.write(configOf({ go: { server: { workspaces: [] } } }, [TWO[0]]));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(calls, 1, 'the second write has not started');
  release();
  await Promise.all([first, second]);
  assert.deepEqual([calls, lsp.dir(WORKSPACE), await gone(workerLspPath(home, WORKSPACE))], [2, undefined, true]);
});

test('workerLspPath refuses a name that would leave the lsp folder (#803)', () => {
  for (const name of ['', '.', '..']) assert.throws(() => workerLspPath('/h', name), /outside the lsp folder/);
  assert.equal(workerLspPath('/h', 'a/b'), join('/h', 'lsp', 'a%2Fb'));
});

test('workerLaunches leaves out a server whose runtime PATH finds only through a relative folder: .lsp.json needs an absolute command (#803)', async (t) => {
  const home = await tempDir(t, 'wlsp-home-');
  await installServer(home, 'pyright');
  const bin = await tempDir(t, 'wlsp-bin-');
  await writeFile(join(bin, 'node'), '#!/bin/sh\n');
  await chmod(join(bin, 'node'), 0o755);
  const launches = await workerLaunches(home, relative(process.cwd(), bin), 'arm64');
  assert.equal(launches.has('pyright/pyright-langserver'), false);
});
