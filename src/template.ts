// Skill and agent templates (#310, node 1.1 of #309): the header, its variables and basedOn, the render for one workspace, the .liquid
// name. Node-free on purpose: the server's per-workspace render and the UI's preview must run the same code, so the only imports are
// liquidjs and yaml, which both ship browser builds.
import { Liquid, LiquidError } from 'liquidjs';
import { type Document, isMap, isNode, isScalar, LineCounter, type Pair, parseDocument, type YAMLError } from 'yaml';

export type VariableKind = 'text' | 'list' | 'boolean';
export type VariableValue = string | boolean | null;

export interface TemplateVariable {
  name: string;
  kind: VariableKind;
  values?: string[]; // list only
  default: VariableValue; // null when absent
  required: boolean;
  workspaces: Record<string, VariableValue>;
  line: number; // the declaration's key
}

export interface BasedOn {
  name: string;
  repo: string;
  ref: string;
  license: string;
  url: string;
}

export interface TemplateError {
  line: number;
  message: string;
  variable?: string;
}

// Not exported: only this module reads a parse's source, so no caller can pair a text with another text's header.
const SOURCE = Symbol('source');

export interface ParsedTemplate {
  header: Record<string, unknown>;
  body: string;
  bodyLine: number;
  variables: TemplateVariable[];
  basedOn?: BasedOn;
  errors: TemplateError[];
  /** The text as given and its header's Document: a render answers the text untouched, or drops keys without parsing again. */
  readonly [SOURCE]: { text: string; doc: Document.Parsed };
}

export type RenderResult = { ok: true; text: string } | { ok: false; errors: TemplateError[] };

const FENCE = '---';
const HEADER_FIRST_LINE = 2; // the header starts right under the opening fence
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BUILT_IN = 'workspace';
const DECLARATION_KEYS = ['type', 'values', 'default', 'required', 'workspaces'];
const BASED_ON_KEYS = ['name', 'repo', 'ref', 'license', 'url'];
const YAML_POSITION = / at line \d+, column \d+:?$/;
const LIQUID_MARK = /\{\{|\{%/;
const LIQUID_POSITION = /, line:(\d+), col:\d+/;
const LIQUID_SUFFIX = '.liquid';

// The render runs synchronously on the server's event loop, so a runaway loop in a template must fail as a render error, not block it.
const RENDER_LIMIT_MS = 1000;
const MEMORY_LIMIT = 1e7;
// templates: {} gives the engine an empty in-memory file system, so include, render and layout fail as render errors instead of
// reading the server's disk; the browser build behaves the same.
const engine = new Liquid({
  strictVariables: true,
  strictFilters: true,
  ownPropertyOnly: true,
  templates: {},
  renderLimit: RENDER_LIMIT_MS,
  memoryLimit: MEMORY_LIMIT,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isValueList = (value: unknown): boolean =>
  Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string') && new Set(value).size === value.length;
const firstLine = (text: string): string => text.split('\n')[0];
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// Claude Code's frontmatter rule: a header only when the first line is a fence, up to the next fence line. The body is a suffix of the
// text, so a render can keep the header's bytes when it removes nothing.
function splitHeader(text: string): { header: string; body: string; bodyLine: number } {
  const lines = text.split('\n');
  const isFence = (line: string): boolean => line.trimEnd() === FENCE;
  const close = isFence(lines[0]) ? lines.findIndex((line, index) => index > 0 && isFence(line)) : -1;
  if (close < 0) return { header: '', body: text, bodyLine: 1 };
  // The trailing newline keeps a CRLF header's last value from ending in \r: yaml only strips \r before a line break.
  return { header: `${lines.slice(1, close).join('\n')}\n`, body: lines.slice(close + 1).join('\n'), bodyLine: close + 2 };
}

const headerLine = (lineCounter: LineCounter, node: unknown): number =>
  isNode(node) && node.range ? lineCounter.linePos(node.range[0]).line + HEADER_FIRST_LINE - 1 : HEADER_FIRST_LINE;

const topPair = (doc: Document.Parsed, key: string): Pair<unknown, unknown> | undefined =>
  isMap(doc.contents) ? doc.contents.items.find((pair) => isScalar(pair.key) && pair.key.value === key) : undefined;

// yaml's positions are the header's; the file line is one fence further down.
const yamlError = (err: YAMLError): TemplateError => ({
  line: (err.linePos?.[0].line ?? 1) + HEADER_FIRST_LINE - 1,
  message: firstLine(err.message).replace(YAML_POSITION, ''),
});

function headerData(doc: Document.Parsed): Record<string, unknown> | string {
  if (doc.contents === null) return {};
  if (!isMap(doc.contents)) return 'the header must be a YAML mapping';
  try {
    return doc.toJS() as Record<string, unknown>;
  } catch (err) {
    // toJS refuses an alias bomb (maxAliasCount), and a parse answers errors instead of throwing
    return `the header could not be read: ${messageOf(err)}`;
  }
}

function valueProblem(kind: VariableKind, values: string[], value: unknown): string | undefined {
  if (value === null) return undefined;
  if (kind === 'boolean') return typeof value === 'boolean' ? undefined : 'must be true or false';
  if (kind === 'list') return typeof value === 'string' && values.includes(value) ? undefined : `must be one of ${values.join(', ')}`;
  return typeof value === 'string' ? undefined : 'must be text';
}

function declarationProblem(raw: Record<string, unknown>): string | undefined {
  const unknownKey = Object.keys(raw).find((key) => !DECLARATION_KEYS.includes(key));
  if (unknownKey !== undefined) return `unknown key "${unknownKey}" (known: ${DECLARATION_KEYS.join(', ')})`;
  if (raw.type !== undefined && raw.type !== 'boolean') return 'type may only be boolean';
  if (raw.type === 'boolean' && raw.values !== undefined) return 'a boolean has no values';
  if (raw.values !== undefined && !isValueList(raw.values)) return 'values must be a non-empty list of distinct strings';
  if (raw.required !== undefined && typeof raw.required !== 'boolean') return 'required must be true or false';
  // required means each workspace sets it: a default would make it never missing
  if (raw.required === true && Object.hasOwn(raw, 'default')) return 'a required variable has no default';
  if (raw.workspaces !== undefined && !isRecord(raw.workspaces)) return 'workspaces must map a workspace to its value';
  return undefined;
}

// One declaration answers its first problem; every declaration of the header is still read.
function readVariable(name: string, line: number, raw: unknown): TemplateVariable | TemplateError {
  const fail = (problem: string): TemplateError => ({ line, variable: name, message: `variable "${name}": ${problem}` });
  if (!VARIABLE_NAME.test(name)) return fail('a name is a letter or _ followed by letters, digits or _');
  if (name === BUILT_IN) return fail('workspace is built in and cannot be declared');
  if (!isRecord(raw)) return fail('a declaration is a mapping');
  const problem = declarationProblem(raw);
  if (problem !== undefined) return fail(problem);
  const kind: VariableKind = raw.type === 'boolean' ? 'boolean' : Array.isArray(raw.values) ? 'list' : 'text';
  const values = Array.isArray(raw.values) ? raw.values.map(String) : [];
  const fallback = raw.default ?? null; // an absent default is null: falsy in an if
  const workspaces = isRecord(raw.workspaces) ? raw.workspaces : {};
  const checked: [string, unknown][] = [
    ['default', fallback],
    ...Object.entries(workspaces).map(([workspace, value]): [string, unknown] => [`workspaces.${workspace}`, value]),
  ];
  for (const [where, value] of checked) {
    const wrong = valueProblem(kind, values, value);
    if (wrong !== undefined) return fail(`${where} ${wrong}`);
  }
  return {
    name,
    kind,
    ...(kind === 'list' ? { values } : {}),
    default: fallback as VariableValue,
    required: raw.required === true,
    workspaces: workspaces as Record<string, VariableValue>,
    line,
  };
}

function readVariables(doc: Document.Parsed, raw: unknown, lineCounter: LineCounter): Pick<ParsedTemplate, 'variables' | 'errors'> {
  const pair = topPair(doc, 'variables');
  if (pair === undefined) return { variables: [], errors: [] };
  if (!isMap(pair.value)) {
    return { variables: [], errors: [{ line: headerLine(lineCounter, pair.key), message: 'variables must be a mapping of declarations' }] };
  }
  const declared: Record<string, unknown> = isRecord(raw) ? raw : {};
  const read = pair.value.items.map((item) => {
    const name = String(isScalar(item.key) ? item.key.value : item.key);
    return readVariable(name, headerLine(lineCounter, item.key), declared[name]);
  });
  return {
    variables: read.filter((entry): entry is TemplateVariable => 'kind' in entry),
    errors: read.filter((entry): entry is TemplateError => !('kind' in entry)),
  };
}

function readBasedOn(raw: unknown, line: number): BasedOn | TemplateError {
  const isShape =
    isRecord(raw) && Object.keys(raw).length === BASED_ON_KEYS.length && BASED_ON_KEYS.every((key) => typeof raw[key] === 'string');
  if (!isShape || !isRecord(raw)) return { line, message: `basedOn must be { ${BASED_ON_KEYS.join(', ')} }, each a string` };
  return { name: String(raw.name), repo: String(raw.repo), ref: String(raw.ref), license: String(raw.license), url: String(raw.url) };
}

export function parseTemplate(text: string): ParsedTemplate {
  const { header, body, bodyLine } = splitHeader(text);
  const lineCounter = new LineCounter();
  const doc = parseDocument(header, { lineCounter });
  const blank: Omit<ParsedTemplate, 'errors'> = { header: {}, body, bodyLine, variables: [], [SOURCE]: { text, doc } };
  if (doc.errors.length > 0) return { ...blank, errors: doc.errors.map(yamlError) };
  const data = headerData(doc);
  if (typeof data === 'string') return { ...blank, errors: [{ line: HEADER_FIRST_LINE, message: data }] };
  const { variables, errors } = readVariables(doc, data.variables, lineCounter);
  const parsed: ParsedTemplate = { ...blank, header: data, variables, errors };
  if (!Object.hasOwn(data, 'basedOn')) return parsed;
  const basedOn = readBasedOn(data.basedOn, headerLine(lineCounter, topPair(doc, 'basedOn')?.key));
  return 'message' in basedOn ? { ...parsed, errors: [...errors, basedOn] } : { ...parsed, basedOn };
}

const hasLiquid = (body: string): boolean => LIQUID_MARK.test(body);
const hasDeclarations = (header: Record<string, unknown>): boolean =>
  Object.hasOwn(header, 'variables') || Object.hasOwn(header, 'basedOn');

// An explicit null in workspaces: counts as the workspace's value.
const valueFor = (variable: TemplateVariable, workspace: string): VariableValue =>
  Object.hasOwn(variable.workspaces, workspace) ? variable.workspaces[workspace] : variable.default;

const contextFor = (variables: TemplateVariable[], workspace: string): Record<string, VariableValue> => ({
  ...Object.fromEntries(variables.map((variable) => [variable.name, valueFor(variable, workspace)])),
  workspace,
});

// liquidjs counts lines in the body it rendered; the file line is bodyLine further down.
function liquidError(err: unknown, bodyLine: number): TemplateError {
  const message = firstLine(messageOf(err));
  const inMessage = LIQUID_POSITION.exec(message);
  const tokenLine = err instanceof LiquidError && err.token ? err.token.getPosition()[0] : 1;
  const line = inMessage ? Number(inMessage[1]) : tokenLine;
  return { line: bodyLine + line - 1, message: message.replace(LIQUID_POSITION, '') };
}

function deliveredHeader(parsed: ParsedTemplate): string {
  const { text, doc } = parsed[SOURCE];
  if (!hasDeclarations(parsed.header)) return text.slice(0, text.length - parsed.body.length);
  // the clone, never the parse: the same parse renders every workspace
  const delivered = doc.clone();
  delivered.delete('variables');
  delivered.delete('basedOn');
  if (!isMap(delivered.contents) || delivered.contents.items.length === 0) return '';
  // lineWidth 0: yaml would otherwise refold long values at 80 columns; the line ending follows the source's
  const eol = text.startsWith(`${FENCE}\r\n`) ? '\r\n' : '\n';
  return `${FENCE}\n${delivered.toString({ lineWidth: 0 })}${FENCE}\n`.replace(/\n/g, eol);
}

export function renderTemplate(parsed: ParsedTemplate, workspace: string): RenderResult {
  if (parsed.errors.length > 0) return { ok: false, errors: parsed.errors };
  if (!hasDeclarations(parsed.header) && !hasLiquid(parsed.body)) return { ok: true, text: parsed[SOURCE].text };
  const missing = parsed.variables.filter((variable) => variable.required && valueFor(variable, workspace) === null);
  if (missing.length > 0) {
    const message = (name: string): string => `variable "${name}" is required and has no value for workspace "${workspace}"`;
    return { ok: false, errors: missing.map(({ name, line }) => ({ line, variable: name, message: message(name) })) };
  }
  try {
    const body: string = hasLiquid(parsed.body) ? engine.parseAndRenderSync(parsed.body, contextFor(parsed.variables, workspace)) : parsed.body;
    return { ok: true, text: `${deliveredHeader(parsed)}${body}` };
  } catch (err) {
    return { ok: false, errors: [liquidError(err, parsed.bodyLine)] };
  }
}

/** A file must be named .liquid when its body uses Liquid; a declared but unused variable alone does not (the lint flags it, 1.3). */
export const needsLiquid = (text: string): boolean => hasLiquid(splitHeader(text).body);

/** The name a template is delivered under: SKILL.md.liquid → SKILL.md. Claude Code ignores .liquid, so a raw template never reaches it. */
export const deliveredName = (path: string): string =>
  path.endsWith(LIQUID_SUFFIX) ? path.slice(0, -LIQUID_SUFFIX.length) : path;
