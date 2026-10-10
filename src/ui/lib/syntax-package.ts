// A syntax package's data as the page uses it (#780): its manifest's grammars and languages, and its language configuration (JSON with
// comments, regexes as strings) as Monaco takes it. Pure: node:test checks it.

export interface PackageGrammar { language?: string; scopeName: string; path: string }
export interface PackageLanguage { id: string; extensions: string[]; configuration?: string }
export interface PackageManifest { grammars: PackageGrammar[]; languages: PackageLanguage[] }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const records = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter(isRecord) : []);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : []);
const clean = (path: string): string => path.replace(/^(\.\/)+/, ''); // served relative to extension/

/** The grammars and languages a package's package.json contributes (#780). */
export function manifestOf(raw: unknown): PackageManifest {
  const contributes = isRecord(raw) && isRecord(raw.contributes) ? raw.contributes : {};
  const grammars = records(contributes.grammars).flatMap((g) => (typeof g.scopeName === 'string' && typeof g.path === 'string'
    ? [{ scopeName: g.scopeName, path: clean(g.path), ...(typeof g.language === 'string' ? { language: g.language } : {}) }] : []));
  const languages = records(contributes.languages).flatMap((l) => (typeof l.id === 'string'
    ? [{ id: l.id, extensions: strings(l.extensions).map((e) => e.toLowerCase()), ...(typeof l.configuration === 'string' ? { configuration: clean(l.configuration) } : {}) }] : []));
  return { grammars, languages };
}

/** The grammar for a file's extension (#780): the one of the package language whose extensions take it. */
export function grammarFor(manifest: PackageManifest, ext: string): PackageGrammar | undefined {
  const language = manifest.languages.find((l) => l.extensions.includes(ext.toLowerCase()))?.id;
  return language === undefined ? undefined : manifest.grammars.find((g) => g.language === language);
}

/** JSON with // and block comments and trailing commas, as VS Code's configuration files are (#780). */
export function parseJsonc(text: string): unknown {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      out += char;
      if (char === '\\') { out += text[i + 1] ?? ''; i += 1; } else if (char === '"') inString = false;
    } else if (char === '"') { inString = true; out += char; }
    else if (char === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i += 1; out += '\n'; }
    else if (char === '/' && text[i + 1] === '*') { i = text.indexOf('*/', i + 2); if (i < 0) break; i += 1; }
    else out += char;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

type Pair = { open: string; close: string; notIn?: string[] };
/** A language configuration in Monaco's shape (#780): the parts a package gives that the editor uses. */
export interface LanguageConfigurationData {
  comments?: { lineComment?: string; blockComment?: [string, string] };
  brackets?: [string, string][];
  autoClosingPairs?: Pair[];
  surroundingPairs?: Pair[];
  wordPattern?: RegExp;
  indentationRules?: { increaseIndentPattern: RegExp; decreaseIndentPattern: RegExp };
  folding?: { markers: { start: RegExp; end: RegExp } };
}

// A regex given as a string or { pattern, flags }; undefined for one JavaScript cannot build
function regexOf(raw: unknown): RegExp | undefined {
  const [pattern, flags] = typeof raw === 'string' ? [raw, undefined] : isRecord(raw) && typeof raw.pattern === 'string' ? [raw.pattern, typeof raw.flags === 'string' ? raw.flags : undefined] : [undefined, undefined];
  if (pattern === undefined) return undefined;
  try { return new RegExp(pattern, flags); } catch { return undefined; }
}

const pairOf = (raw: unknown): Pair | undefined => {
  if (Array.isArray(raw) && typeof raw[0] === 'string' && typeof raw[1] === 'string') return { open: raw[0], close: raw[1] };
  if (!isRecord(raw) || typeof raw.open !== 'string' || typeof raw.close !== 'string') return undefined;
  const notIn = strings(raw.notIn);
  return { open: raw.open, close: raw.close, ...(notIn.length > 0 ? { notIn } : {}) };
};
const pairsOf = (raw: unknown): Pair[] | undefined => (Array.isArray(raw) ? raw.map(pairOf).filter((p): p is Pair => p !== undefined) : undefined);
const tupleOf = (raw: unknown): [string, string] | undefined => (Array.isArray(raw) && typeof raw[0] === 'string' && typeof raw[1] === 'string' ? [raw[0], raw[1]] : undefined);

function commentsOf(raw: unknown): LanguageConfigurationData['comments'] {
  if (!isRecord(raw)) return undefined;
  const block = tupleOf(raw.blockComment);
  return { ...(typeof raw.lineComment === 'string' ? { lineComment: raw.lineComment } : {}), ...(block ? { blockComment: block } : {}) };
}

function indentationOf(raw: unknown): LanguageConfigurationData['indentationRules'] {
  const [increase, decrease] = isRecord(raw) ? [regexOf(raw.increaseIndentPattern), regexOf(raw.decreaseIndentPattern)] : [];
  return increase && decrease ? { increaseIndentPattern: increase, decreaseIndentPattern: decrease } : undefined;
}

function foldingOf(raw: unknown): LanguageConfigurationData['folding'] {
  const markers = isRecord(raw) && isRecord(raw.markers) ? raw.markers : undefined;
  const [start, end] = markers ? [regexOf(markers.start), regexOf(markers.end)] : [];
  return start && end ? { markers: { start, end } } : undefined;
}

/** A package's language-configuration.json as Monaco's setLanguageConfiguration takes it (#780). */
export function languageConfigurationOf(raw: unknown): LanguageConfigurationData {
  if (!isRecord(raw)) return {};
  const parts: LanguageConfigurationData = {
    comments: commentsOf(raw.comments), brackets: Array.isArray(raw.brackets) ? raw.brackets.map(tupleOf).filter((b): b is [string, string] => b !== undefined) : undefined,
    autoClosingPairs: pairsOf(raw.autoClosingPairs), surroundingPairs: pairsOf(raw.surroundingPairs), wordPattern: regexOf(raw.wordPattern),
    indentationRules: indentationOf(raw.indentationRules), folding: foldingOf(raw.folding),
  };
  return Object.fromEntries(Object.entries(parts).filter(([, value]) => value !== undefined)) as LanguageConfigurationData;
}
