import { checkersOf, isCheckerId } from './checkers.js';
import { formattersOf, isCustomName, isExtension, isFormatterId, normalizeExtension } from './formatters.js';
import { isLanguageId, languageDef } from './languages.js';
import {
  CHECKER_IDS, type CheckerId, type CustomFormatter, type EditorConfig, FORMATTER_IDS, type FormatterId, LANGUAGE_IDS, type LanguageConfig, type LanguageFormatter,
  type LanguageId, type WorkspaceScope,
} from './types.js';

// hive.config.json's editor (#780), checked the same on boot and on POST /settings. A problem is a message naming its key, the tail of the
// parser's error (config.ts puts the file in front). Pure, as formatters.ts is. Every object is rebuilt, so a stray key never reaches the config.

const SHAPE = '{ "formatOnSave": { "enabled": true, "workspaces": "all" }, "languages": {} }';
const SCOPE = '"workspaces": "all" or [workspace names]';
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((x) => typeof x === 'string');

// "all", or names of this config's workspaces, each once. A problem is { problem }, never a bare string: "all" is one too.
type Scoped = { scope: WorkspaceScope } | { problem: string };
function parseScope(raw: unknown, key: string, workspaces: readonly string[]): Scoped {
  if (raw === 'all') return { scope: 'all' };
  if (!isStrings(raw)) return { problem: `${key} must be "all" or an array of workspace names` };
  const unknown = raw.find((name) => !workspaces.includes(name));
  if (unknown !== undefined) return { problem: `${key} names workspace ${unknown}, which is not in comb.workspaces` };
  const twice = raw.find((name, i) => raw.indexOf(name) !== i);
  return twice === undefined ? { scope: [...raw] } : { problem: `${key} names ${twice} twice` };
}

function parseFormatOnSave(raw: unknown, workspaces: readonly string[]): EditorConfig['formatOnSave'] | string {
  const key = 'editor.formatOnSave';
  if (!isRecord(raw) || typeof raw.enabled !== 'boolean') return `${key} must be { "enabled": true or false, ${SCOPE} }`;
  const scope = parseScope(raw.workspaces, `${key}.workspaces`, workspaces);
  return 'problem' in scope ? scope.problem : { enabled: raw.enabled, workspaces: scope.scope };
}

function parseFormatter(raw: unknown, key: string, workspaces: readonly string[]): LanguageFormatter | string {
  if (!isRecord(raw) || typeof raw.enabled !== 'boolean' || !isStrings(raw.args)) return `${key} must be { "enabled": true or false, "args": [strings], ${SCOPE} }`;
  const scope = parseScope(raw.workspaces, `${key}.workspaces`, workspaces);
  return 'problem' in scope ? scope.problem : { enabled: raw.enabled, args: [...raw.args], workspaces: scope.scope };
}

// The ids a language's settings may name and how its refusals read (#780, #782): formatters and checkers follow one rule
interface Catalog<T extends string> { noun: string; verb: string; known: readonly string[]; isId(id: string): id is T; serves(id: T): boolean }
const formatterCatalog = (language: LanguageId): Catalog<FormatterId> =>
  ({ noun: 'formatter', verb: 'format', known: FORMATTER_IDS, isId: isFormatterId, serves: (id) => formattersOf(language).includes(id) });
const checkerCatalog = (language: LanguageId): Catalog<CheckerId> =>
  ({ noun: 'checker', verb: 'check', known: CHECKER_IDS, isId: isCheckerId, serves: (id) => checkersOf(language).some((def) => def.id === id) });

// Supported ids only, each one that serves the language, each a formatter's setting (a checker's has the same shape)
function parseSettings<T extends string>(raw: unknown, key: string, language: LanguageId, catalog: Catalog<T>, workspaces: readonly string[]): Partial<Record<T, LanguageFormatter>> | string {
  if (!isRecord(raw)) return `${key} must be an object keyed by ${catalog.noun} id`;
  const parsed: [string, LanguageFormatter][] = [];
  for (const [id, entry] of Object.entries(raw)) {
    if (!catalog.isId(id)) return `${key}.${id} is not a supported ${catalog.noun} (known: ${catalog.known.join(', ')})`;
    if (!catalog.serves(id)) return `${key}.${id}: ${id} does not ${catalog.verb} ${language}`;
    const setting = parseFormatter(entry, `${key}.${id}`, workspaces);
    if (typeof setting === 'string') return setting;
    parsed.push([id, setting]);
  }
  return Object.fromEntries(parsed) as Partial<Record<T, LanguageFormatter>>;
}

function parseCustomEntry(raw: unknown, key: string, workspaces: readonly string[]): CustomFormatter | string {
  if (!isRecord(raw)) return `${key} must be an object { "name", "command", "extensions", "workspaces" }`;
  if (typeof raw.name !== 'string' || !isCustomName(raw.name)) {
    return `${key}.name must be a letter or digit followed by up to 39 letters, digits, ".", "_" or "-", and not a supported formatter's id`;
  }
  if (typeof raw.command !== 'string' || raw.command.trim() === '') return `${key}.command must be a non-empty string`;
  const extensions = isStrings(raw.extensions) ? raw.extensions.map(normalizeExtension) : [];
  if (extensions.length === 0 || !extensions.every(isExtension)) return `${key}.extensions must be one or more extensions, each with its dot (".sql")`;
  const scope = parseScope(raw.workspaces, `${key}.workspaces`, workspaces);
  return 'problem' in scope ? scope.problem : { name: raw.name, command: raw.command, extensions, workspaces: scope.scope };
}

// Names unique within the language; two languages may share one
function parseCustom(raw: unknown, language: LanguageId, workspaces: readonly string[]): CustomFormatter[] | string {
  const key = `editor.languages.${language}.custom`;
  if (!Array.isArray(raw)) return `${key} must be an array`;
  const parsed = raw.map((entry, i) => parseCustomEntry(entry, `${key}[${i}]`, workspaces));
  const problem = parsed.find((p): p is string => typeof p === 'string');
  if (problem !== undefined) return problem;
  const custom = parsed as CustomFormatter[];
  const twice = custom.findIndex((c, i) => custom.findIndex((d) => d.name === c.name) !== i);
  return twice === -1 ? custom : `${key}[${twice}].name must be unique in its language`;
}

function parseServer(raw: unknown, language: LanguageId, workspaces: readonly string[]): LanguageConfig['server'] | string {
  const key = `editor.languages.${language}.server`;
  if (languageDef(language).server === undefined) return `${key}: ${language} has no language server`;
  if (!isRecord(raw)) return `${key} must be { ${SCOPE} }`;
  const scope = parseScope(raw.workspaces, `${key}.workspaces`, workspaces);
  return 'problem' in scope ? scope.problem : { workspaces: scope.scope };
}

function parseLanguage(id: LanguageId, raw: unknown, workspaces: readonly string[]): LanguageConfig | string {
  const at = `editor.languages.${id}`;
  if (!isRecord(raw)) return `${at} must be an object { "server", "formatters", "custom", "checkers" }`;
  const server = raw.server === undefined ? undefined : parseServer(raw.server, id, workspaces);
  if (typeof server === 'string') return server;
  const formatters = raw.formatters === undefined ? undefined : parseSettings(raw.formatters, `${at}.formatters`, id, formatterCatalog(id), workspaces);
  if (typeof formatters === 'string') return formatters;
  const custom = raw.custom === undefined ? undefined : parseCustom(raw.custom, id, workspaces);
  if (typeof custom === 'string') return custom;
  const checkers = raw.checkers === undefined ? undefined : parseSettings(raw.checkers, `${at}.checkers`, id, checkerCatalog(id), workspaces);
  if (typeof checkers === 'string') return checkers;
  return { ...(server ? { server } : {}), ...(formatters ? { formatters } : {}), ...(custom ? { custom } : {}), ...(checkers ? { checkers } : {}) };
}

function parseLanguages(raw: unknown, workspaces: readonly string[]): EditorConfig['languages'] | string {
  if (!isRecord(raw)) return 'editor.languages must be an object keyed by language id';
  const parsed: [LanguageId, LanguageConfig][] = [];
  for (const [id, entry] of Object.entries(raw)) {
    if (!isLanguageId(id)) return `editor.languages.${id} is not a language (known: ${LANGUAGE_IDS.join(', ')})`;
    const language = parseLanguage(id, entry, workspaces);
    if (typeof language === 'string') return language;
    parsed.push([id, language]);
  }
  return Object.fromEntries(parsed);
}

/** The raw editor config (#780) against the Comb's workspace names, or the first problem as `editor…`. Required, no default. */
export function parseEditorConfig(raw: unknown, workspaces: readonly string[]): EditorConfig | string {
  if (raw === undefined) return `editor is required: ${SHAPE} formats on save in every workspace`;
  if (!isRecord(raw)) return `editor must be an object: ${SHAPE}`;
  const formatOnSave = parseFormatOnSave(raw.formatOnSave, workspaces);
  if (typeof formatOnSave === 'string') return formatOnSave;
  const languages = parseLanguages(raw.languages, workspaces);
  return typeof languages === 'string' ? languages : { formatOnSave, languages };
}
