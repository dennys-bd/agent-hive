import type { InstallKind, LanguageId, ServerId, SyntaxId, WorkspaceScope } from './types.js';
import { LANGUAGE_IDS, SERVER_IDS, SYNTAX_IDS } from './types.js';

// The editor's catalog (#780): its languages, the language servers the Hive installs and the syntax packages it extracts, as the catalog check
// confirmed them against the registries (docs/agent/hive/plans/2026-10-06-editor-languages/catalog-check.md). No I/O and no node import: the
// daemon, the parser and the page all read it.

export type Arch = 'arm64' | 'x64';
/** A server's process: the program and its argv. */
export interface Launch { command: string; args: string[] }
/** Where a server is installed and which version: what its launch reads. */
export interface Installed { dir: string; arch: Arch; version: string }
/** One language: its extensions (lowercase, with the dot), its syntax (a package, Monaco's own, or none for other), its server if any. */
export interface LanguageDef { id: LanguageId; extensions: readonly string[]; syntax?: SyntaxId | 'builtin'; server?: ServerId }
/** One server's recipe. source: npm's package, GitHub's owner/repo, the Go module, or a system server's tool (#782). binaries: the programs a
 * page may ask for (web has three); a process runs one. args: what follows the binary at launch, a checker's project copy included (#782). */
export interface ServerDef {
  id: ServerId;
  install: Exclude<InstallKind, 'openvsx'>;
  source: string;
  packages?: readonly string[]; // npm: every package the prefix gets, the server's own first; an entry with its own @spec is installed as written
  requires?: string; // toolchain: the tool its install needs on PATH; system: the tool it is (#782)
  binaries: readonly string[];
  args: readonly string[];
  asset?(version: string, arch: Arch): string; // github: the release asset for this Mac
  launch(at: Installed, binary: string): Launch;
}
export interface SyntaxDef { id: SyntaxId; namespace: string; name: string }

const lang = (id: LanguageId, extensions: string, syntax?: SyntaxId | 'builtin', server?: ServerId): LanguageDef =>
  ({ id, extensions: extensions.split(' '), ...(syntax === undefined ? {} : { syntax }), ...(server === undefined ? {} : { server }) });

export const LANGUAGES: readonly LanguageDef[] = [
  lang('typescript', '.ts .tsx .js .jsx .mjs .cjs', 'builtin', 'typescript-language-server'),
  lang('python', '.py .pyi', 'vscode.python', 'pyright'),
  lang('go', '.go', 'vscode.go', 'gopls'),
  lang('rust', '.rs', 'vscode.rust', 'rust-analyzer'),
  lang('cpp', '.c .h .cc .cpp .hpp', 'vscode.cpp', 'clangd'),
  lang('objective-c', '.m .mm', 'vscode.objective-c', 'clangd'),
  lang('lua', '.lua', 'vscode.lua', 'lua-language-server'),
  lang('toml', '.toml', 'tamasfe.even-better-toml', 'taplo'),
  lang('yaml', '.yaml .yml', 'builtin', 'yaml-language-server'),
  lang('shell', '.sh .bash', 'vscode.shellscript', 'bash-language-server'),
  lang('web', '.html .css .scss .less .json .jsonc', 'builtin', 'vscode-langservers-extracted'),
  lang('markdown', '.md', 'builtin'),
  lang('sql', '.sql .psql', 'builtin'),
  lang('swift', '.swift', 'vscode.swift'),
  lang('dart', '.dart', 'builtin'),
  lang('elixir', '.ex .exs .heex', 'elixir-lsp.elixir-ls'),
  lang('kotlin', '.kt .kts', 'builtin'),
  lang('terraform', '.tf .tfvars', 'hashicorp.terraform'),
  lang('zig', '.zig', 'ziglang.vscode-zig'),
  lang('other', '.vue .graphql'),
];

const MAC_ARCH: Record<Arch, string> = { arm64: 'aarch64', x64: 'x86_64' }; // rust-analyzer's and taplo's names for the two Macs

// An npm server runs with node from PATH on its .bin script, so the install needs no shebang lookup of its own
const npm = (id: ServerId, packages: string[], binaries: string[], args: string[]): ServerDef => ({
  id, install: 'npm', source: packages[0], packages, binaries, args, launch: (at, binary) => ({ command: 'node', args: [`${at.dir}/node_modules/.bin/${binary}`, ...args] }),
});
// A GitHub binary: path is where its archive puts it (a lone .gz goes to bin/<binary>); ruff's folder names the Mac's arch (#782)
const github = (id: ServerId, repo: string, asset: (version: string, arch: Arch) => string, path: (version: string, arch: Arch) => string, args: string[] = []): ServerDef => ({
  id, install: 'github', source: repo, binaries: [id], args, asset, launch: (at) => ({ command: `${at.dir}/${path(at.version, at.arch)}`, args }),
});
// A server that ships with its SDK (#782): its tool from PATH, never installed by the Hive
const system = (id: ServerId, tool: string, args: string[]): ServerDef => ({
  id, install: 'system', source: tool, requires: tool, binaries: [tool], args, launch: () => ({ command: tool, args }),
});
const TFLINT_ARCH: Record<Arch, string> = { arm64: 'arm64', x64: 'amd64' };

export const SERVERS: readonly ServerDef[] = [
  // typescript 7 ships no tsserver, and the server refuses to start without one: stay on 6
  npm('typescript-language-server', ['typescript-language-server', 'typescript@6'], ['typescript-language-server'], ['--stdio']),
  npm('pyright', ['pyright'], ['pyright-langserver'], ['--stdio']),
  { id: 'gopls', install: 'toolchain', source: 'golang.org/x/tools/gopls', requires: 'go', binaries: ['gopls'], args: [], launch: (at) => ({ command: `${at.dir}/bin/gopls`, args: [] }) },
  github('rust-analyzer', 'rust-lang/rust-analyzer', (_v, arch) => `rust-analyzer-${MAC_ARCH[arch]}-apple-darwin.gz`, () => 'bin/rust-analyzer'),
  github('clangd', 'clangd/clangd', (v) => `clangd-mac-${v}.zip`, (v) => `clangd_${v}/bin/clangd`),
  github('lua-language-server', 'LuaLS/lua-language-server', (v, arch) => `lua-language-server-${v}-darwin-${arch}.tar.gz`, () => 'bin/lua-language-server'),
  github('taplo', 'tamasfe/taplo', (_v, arch) => `taplo-darwin-${MAC_ARCH[arch]}.gz`, () => 'bin/taplo', ['lsp', 'stdio']),
  npm('yaml-language-server', ['yaml-language-server'], ['yaml-language-server'], ['--stdio']),
  npm('bash-language-server', ['bash-language-server'], ['bash-language-server'], ['start']),
  npm('vscode-langservers-extracted', ['vscode-langservers-extracted'], ['vscode-html-language-server', 'vscode-css-language-server', 'vscode-json-language-server'], ['--stdio']),
  // #782: the checkers' own servers. eslint's is vscode-langservers-extracted again, in its own folder: one install row per checker
  npm('biome', ['@biomejs/biome'], ['biome'], ['lsp-proxy']),
  npm('eslint', ['vscode-langservers-extracted'], ['vscode-eslint-language-server'], ['--stdio']),
  npm('oxlint', ['oxlint'], ['oxlint'], ['--lsp']),
  github('ruff', 'astral-sh/ruff', (_v, arch) => `ruff-${MAC_ARCH[arch]}-apple-darwin.tar.gz`, (_v, arch) => `ruff-${MAC_ARCH[arch]}-apple-darwin/ruff`, ['server']),
  github('tflint', 'terraform-linters/tflint', (_v, arch) => `tflint_darwin_${TFLINT_ARCH[arch]}.zip`, () => 'tflint', ['--langserver']),
  system('dart', 'dart', ['language-server', '--protocol=lsp']),
];

export const SYNTAXES: readonly SyntaxDef[] = SYNTAX_IDS.map((id) => {
  const dot = id.indexOf('.');
  return { id, namespace: id.slice(0, dot), name: id.slice(dot + 1) };
});

const byId = <T extends { id: string }>(list: readonly T[]): Record<string, T> => Object.fromEntries(list.map((item) => [item.id, item]));
const LANGUAGE_BY_ID = byId(LANGUAGES) as Record<LanguageId, LanguageDef>;
const SERVER_BY_ID = byId(SERVERS) as Record<ServerId, ServerDef>;
const SYNTAX_BY_ID = byId(SYNTAXES) as Record<SyntaxId, SyntaxDef>;
export const languageDef = (id: LanguageId): LanguageDef => LANGUAGE_BY_ID[id];
export const serverDef = (id: ServerId): ServerDef => SERVER_BY_ID[id];
export const syntaxDef = (id: SyntaxId): SyntaxDef => SYNTAX_BY_ID[id];
export const isLanguageId = (id: string): id is LanguageId => (LANGUAGE_IDS as readonly string[]).includes(id);
export const isServerId = (id: string): id is ServerId => (SERVER_IDS as readonly string[]).includes(id);
export const isSyntaxId = (id: string): id is SyntaxId => (SYNTAX_IDS as readonly string[]).includes(id);

/** The file's extension, lowercased (#749): after the last dot of a name that does not start with one (`.env` has none); '' for none. */
export function extensionOf(file: string): string {
  const name = file.split('/').at(-1) ?? file;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

/** The file's language (#780) by its lowercased extension; other also takes `extra`, the extensions its custom formatters list. */
export function languageOf(file: string, extra: readonly string[] = []): LanguageId | undefined {
  const ext = extensionOf(file);
  if (ext === '') return undefined;
  return LANGUAGES.find((l) => l.extensions.includes(ext))?.id ?? (extra.includes(ext) ? 'other' : undefined);
}

/** Whether a scope covers `workspace` (#780): all covers every one, the ones added later included. */
export const inScope = (scope: WorkspaceScope, workspace: string): boolean => scope === 'all' || scope.includes(workspace);

// web's three servers, by the extension each serves
const WEB_BINARY: Record<string, string> = {
  '.html': 'vscode-html-language-server', '.css': 'vscode-css-language-server', '.scss': 'vscode-css-language-server', '.less': 'vscode-css-language-server',
  '.json': 'vscode-json-language-server', '.jsonc': 'vscode-json-language-server',
};

/** The server of a language and the binary for `ext` (#780): one binary per server, but web's by extension. */
export function serverFor(language: LanguageId, ext: string): { server: ServerDef; binary: string } | undefined {
  const id = LANGUAGE_BY_ID[language].server;
  if (id === undefined) return undefined;
  const server = SERVER_BY_ID[id];
  const binary = server.binaries.length === 1 ? server.binaries[0] : WEB_BINARY[ext.toLowerCase()];
  return binary === undefined ? undefined : { server, binary };
}

/** The languages a server serves (#780): clangd serves cpp and objective-c. */
export const languagesOfServer = (id: ServerId): LanguageId[] => LANGUAGES.filter((l) => l.server === id).map((l) => l.id);

/** What a server's install needs on PATH (#780): npm's node and npm, a toolchain's tool; a GitHub binary nothing; a system server its tool (#782). */
export function requiredTools(server: ServerDef): string[] {
  if (server.install === 'npm') return ['node', 'npm'];
  return server.install === 'toolchain' || server.install === 'system' ? [server.requires ?? server.source] : [];
}

/** What a server's process needs on PATH to run (#780): node for an npm one, its own tool for a system one (#782). */
export function runtimeTools(server: ServerDef): string[] {
  if (server.install === 'npm') return ['node'];
  return server.install === 'system' ? [server.requires ?? server.source] : [];
}

// The LSP languageId where it is not the catalog language's own id
const LSP_LANGUAGE: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescriptreact', '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascriptreact',
  '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.hpp': 'cpp', '.m': 'objective-c', '.mm': 'objective-cpp', '.sh': 'shellscript', '.bash': 'shellscript',
  '.html': 'html', '.css': 'css', '.scss': 'scss', '.less': 'less', '.json': 'json', '.jsonc': 'jsonc',
};

/** A file's LSP languageId for didOpen (#780). */
export const lspLanguageId = (file: string): string => LSP_LANGUAGE[extensionOf(file)] ?? languageOf(file) ?? 'plaintext';
