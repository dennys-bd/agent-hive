// Syntax packages in Monaco (#780): the first file of a language whose package is installed loads oniguruma's wasm once, then the package's
// grammar and language configuration from the daemon, and sets a TextMate tokens provider in place of Monarch. A package not installed
// answers 404 for its package.json, and Monarch stays.
import type * as Monaco from 'monaco-editor';
import { createOnigScanner, createOnigString, loadWASM } from 'vscode-oniguruma';
import onigUrl from 'vscode-oniguruma/release/onig.wasm?url';
import { type IGrammar, INITIAL, parseRawGrammar, Registry, type StateStack } from 'vscode-textmate';
import { grammarFor, languageConfigurationOf, manifestOf, type PackageManifest, parseJsonc } from '@/lib/syntax-package';
import type { SyntaxId } from '../../types';

type Api = Pick<typeof Monaco.languages, 'setTokensProvider' | 'setLanguageConfiguration'>;

let onig: Promise<void> | undefined;
// A failure is not kept: the next file opened retries instead of finding the rejected promise for good
const loadOnig = (): Promise<void> => {
  onig ??= fetch(onigUrl).then((res) => res.arrayBuffer()).then((data) => loadWASM(data)).catch((err: unknown) => { onig = undefined; throw err; });
  return onig;
};
const applied = new Set<string>(); // Monaco language ids a package paints, or is being loaded for

const fileUrl = (id: SyntaxId, path: string): string => `/editor/syntax/${encodeURIComponent(id)}/${path.split('/').map(encodeURIComponent).join('/')}`;
async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.text();
}

class TokenState implements Monaco.languages.IState {
  readonly stack: StateStack;
  constructor(stack: StateStack) { this.stack = stack; }
  clone(): TokenState { return new TokenState(this.stack); }
  equals(other: Monaco.languages.IState): boolean { return other instanceof TokenState && other.stack.equals(this.stack); }
}

// The innermost scope of each token is Monaco's token: the theme matches it by its dotted prefix (keyword.control.python → keyword)
const tokensProvider = (grammar: IGrammar): Monaco.languages.TokensProvider => ({
  getInitialState: () => new TokenState(INITIAL),
  tokenize: (line, state) => {
    const result = grammar.tokenizeLine(line, (state as TokenState).stack);
    return { tokens: result.tokens.map((t) => ({ startIndex: t.startIndex, scopes: t.scopes.at(-1) ?? '' })), endState: new TokenState(result.ruleStack) };
  },
});

async function grammarOf(id: SyntaxId, manifest: PackageManifest, scopeName: string): Promise<IGrammar | null> {
  await loadOnig();
  const registry = new Registry({
    onigLib: Promise.resolve({ createOnigScanner, createOnigString }),
    loadGrammar: async (scope) => {
      const grammar = manifest.grammars.find((g) => g.scopeName === scope);
      return grammar ? parseRawGrammar(await fetchText(fileUrl(id, grammar.path)), grammar.path) : null; // a scope the package lacks stays plain
    },
  });
  return registry.loadGrammar(scopeName);
}

/** Paints `monacoLanguage` with syntax package `id`'s grammar for `ext` (#780), once per Monaco language; a failure leaves Monarch and the
 * next file tries again. */
export async function applySyntax(api: Api, id: SyntaxId, monacoLanguage: string, ext: string): Promise<void> {
  if (applied.has(monacoLanguage)) return;
  applied.add(monacoLanguage);
  try {
    const manifest = manifestOf(JSON.parse(await fetchText(fileUrl(id, 'package.json'))));
    const grammar = grammarFor(manifest, ext);
    if (grammar === undefined) return;
    const loaded = await grammarOf(id, manifest, grammar.scopeName);
    if (loaded) api.setTokensProvider(monacoLanguage, tokensProvider(loaded));
    const configuration = manifest.languages.find((l) => l.id === grammar.language)?.configuration;
    if (configuration) api.setLanguageConfiguration(monacoLanguage, languageConfigurationOf(parseJsonc(await fetchText(fileUrl(id, configuration)))));
  } catch {
    applied.delete(monacoLanguage);
  }
}
