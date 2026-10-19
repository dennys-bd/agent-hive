// The structural lint of a skill or agent template (#312, node 1.3 of #309): the annotations the editor shows on every change (4.1).
// Pure and node-free like src/template.ts: it reads the parse and what the caller gives, never the disk, so the UI runs the same code.
import { Liquid, type StaticAnalysis } from 'liquidjs';
import { liquidError, type ParsedTemplate, renderTemplate, type TemplateVariable } from './template.js';
import { type TemplateRef, templateRefs } from './template-refs.js';
import type { ItemKind } from './types.js';

export type Severity = 'yellow' | 'red';
export type LintCheck = 'parse' | 'render' | 'undeclared' | 'unused' | 'required' | 'reference' | 'callRequired' | 'heading';
export interface LintAnnotation {
  line: number;
  severity: Severity;
  check: LintCheck;
  title: string;
  body: string;
  workspaces?: string[];
  fix?: string;
}
export interface LintItem {
  origin: string;
  kind: ItemKind;
  name: string;
  variables: TemplateVariable[];
}
export interface LintInput {
  self: { origin: string; kind: ItemKind; name: string };
  catalogue: LintItem[];
  workspaces: string[];
  scripts: string[];
}

const BUILT_IN = 'workspace';
const RENDER_BUDGET_MS = 1000; // the render limit of src/template.ts: one runaway render's worth per lint
// item-sources.ts names the plugin's origin too, but it reads the disk, so the lint cannot import it
const HIVE_ORIGIN = 'hive';
const HEADER_BODY = 'The header must parse before anything else is checked.';
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]|$)/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

// Parses and analyses, never renders. The strict settings of template.ts's engine make a parse error here the one a render meets;
// templates: {} keeps a partial off the disk
const engine = new Liquid({ strictVariables: true, strictFilters: true, ownPropertyOnly: true, templates: {} });

const finding = (line: number, severity: Severity, check: LintCheck, title: string, body: string, workspaces?: string[]): LintAnnotation =>
  workspaces === undefined ? { line, severity, check, title, body } : { line, severity, check, title, body, workspaces };

// ponytail: quadratic, fine for one template's findings
const uniqueBy = <T>(list: T[], key: (item: T) => string): T[] =>
  list.filter((item, index) => list.findIndex((other) => key(other) === key(item)) === index);

// A required variable has no default (template.ts refuses one): only its workspaces: entry counts, and an explicit null is no value
const missingIn = (variable: TemplateVariable, workspaces: string[]): string[] =>
  variable.required
    ? workspaces.filter((workspace) => (Object.hasOwn(variable.workspaces, workspace) ? variable.workspaces[workspace] : null) === null)
    : [];

function analyse(parsed: ParsedTemplate): StaticAnalysis | LintAnnotation {
  try {
    // partials: false: a partial has nothing to load, and the render reports it
    return engine.analyzeSync(engine.parse(parsed.body), { partials: false });
  } catch (err) {
    const { line, message } = liquidError(err, parsed.bodyLine);
    return finding(line, 'red', 'parse', message, 'The body is not valid Liquid; its variables are checked once it parses.');
  }
}

// The analysis walks every branch, where a render only walks the one it takes, so a use in an {% else %} counts
function variableFindings(parsed: ParsedTemplate): LintAnnotation[] {
  const analysis = analyse(parsed);
  if (!('globals' in analysis)) return [analysis];
  const declared = new Set(parsed.variables.map((variable) => variable.name));
  const undeclared = Object.entries(analysis.globals)
    .filter(([name]) => name !== BUILT_IN && !declared.has(name))
    .flatMap(([name, uses]) =>
      uses.map((use) =>
        finding(parsed.bodyLine + use.location.row - 1, 'red', 'undeclared', `undeclared variable ${name}`, `"${name}" is used here but not declared under variables: in the header.`),
      ),
    );
  const unused = parsed.variables
    .filter((variable) => !Object.hasOwn(analysis.globals, variable.name))
    .map((variable) => finding(variable.line, 'yellow', 'unused', `unused variable ${variable.name}`, `"${variable.name}" is declared but the body never uses it.`));
  return [...uniqueBy(undeclared, (annotation) => `${annotation.line} ${annotation.title}`), ...unused];
}

/** The file lines where the body uses a variable (#321, decision 17): the same analysis the unused check walks, so a use in an {% else %}
 * counts. 1-based, ascending, each line once; none when the body is not valid Liquid. */
export function variableUses(parsed: ParsedTemplate, name: string): number[] {
  const analysis = analyse(parsed);
  if (!('globals' in analysis) || !Object.hasOwn(analysis.globals, name)) return [];
  const lines = analysis.globals[name].map((use) => parsed.bodyLine + use.location.row - 1);
  return [...new Set(lines)].sort((a, b) => a - b);
}

// One annotation per variable, naming every workspace that misses it: the editor keys annotations by line
function requiredFindings(parsed: ParsedTemplate, workspaces: string[]): LintAnnotation[] {
  return parsed.variables.flatMap((variable) => {
    const missing = missingIn(variable, workspaces);
    if (missing.length === 0) return [];
    const names = missing.join(', ');
    return [finding(variable.line, 'red', 'required', `missing ${variable.name} · ${names}`, `"${variable.name}" is required and has no value for ${names}.`, missing)];
  });
}

// What a reference reaches: a Hive item, whose required variables the call needs; 'other' (a script, a workspace skill, the template
// itself, whose own required variables are the required check's); or nothing
function target(ref: TemplateRef, input: LintInput): LintItem | 'other' | undefined {
  if (ref.kind === 'script') return input.scripts.includes(ref.name) ? 'other' : undefined;
  if (input.self.origin === HIVE_ORIGIN && input.self.name === ref.name) return 'other';
  const hive = input.catalogue.find((item) => item.origin === HIVE_ORIGIN && item.name === ref.name);
  if (hive !== undefined || ref.kind === 'hive') return hive;
  const isWorkspaceSkill = input.catalogue.some((item) => item.origin !== HIVE_ORIGIN && item.kind === 'skill' && item.name === ref.name);
  return isWorkspaceSkill ? 'other' : undefined;
}

// The called item's own value is read: a name declared in two skills is two variables
function callFindings(ref: TemplateRef, item: LintItem, workspaces: string[]): { key: string; annotation: LintAnnotation }[] {
  return item.variables.flatMap((variable) => {
    const missing = missingIn(variable, workspaces);
    if (missing.length === 0) return [];
    const names = missing.join(', ');
    const title = `missing ${variable.name} · ${ref.text} · ${names}`;
    const body = `${ref.text} requires "${variable.name}", which has no value for ${names}.`;
    return [{ key: `${ref.line} ${ref.name} ${variable.name}`, annotation: finding(ref.line, 'red', 'callRequired', title, body, missing) }];
  });
}

function referenceFindings(parsed: ParsedTemplate, input: LintInput): LintAnnotation[] {
  const refs = templateRefs(parsed).map((ref) => ({ ref, reached: target(ref, input) }));
  const unknown = refs
    .filter(({ reached }) => reached === undefined)
    .map(({ ref }) =>
      finding(ref.line, 'yellow', 'reference', `unknown skill, agent or script ${ref.text}`, `${ref.text} is not a Hive skill or agent, a workspace's skill or one of the plugin's scripts.`),
    );
  const calls = refs.flatMap(({ ref, reached }) => (typeof reached === 'object' ? callFindings(ref, reached, input.workspaces) : []));
  return [...uniqueBy(unknown, (annotation) => `${annotation.line} ${annotation.title}`), ...uniqueBy(calls, (call) => call.key).map((call) => call.annotation)];
}

interface RenderError {
  line: number;
  message: string;
  workspace: string;
}

// Each render may take the engine's whole limit, and the lint runs on every change: past the budget the remaining workspaces are not
// rendered, so a runaway loop costs one limit per lint, not one per workspace.
// ponytail: a skipped workspace's own render error shows only once the others render faster; a worker if that ever matters
function renderWithin(parsed: ParsedTemplate, workspaces: string[]): RenderError[] {
  const deadline = Date.now() + RENDER_BUDGET_MS;
  const errors: RenderError[] = [];
  for (const workspace of workspaces) {
    if (Date.now() > deadline) break;
    const result = renderTemplate(parsed, workspace);
    if (!result.ok) errors.push(...result.errors.map((error) => ({ line: error.line, message: error.message, workspace })));
  }
  return errors;
}

// Catches what only a render shows (a partial, the render limit) without repeating a static finding or a workspace's same error
function renderFindings(parsed: ParsedTemplate, workspaces: string[], statics: LintAnnotation[]): LintAnnotation[] {
  const redLines = new Set(statics.filter((annotation) => annotation.severity === 'red').map((annotation) => annotation.line));
  // A workspace missing a required variable is already reported; its render would only say it again
  const renderable = workspaces.filter((workspace) => parsed.variables.every((variable) => missingIn(variable, [workspace]).length === 0));
  const errors = renderWithin(parsed, renderable).filter((error) => !redLines.has(error.line));
  const keyOf = (error: { line: number; message: string }): string => `${error.line}\n${error.message}`;
  return uniqueBy(errors, keyOf).map((first) => {
    const failing = errors.filter((error) => keyOf(error) === keyOf(first)).map((error) => error.workspace);
    return finding(first.line, 'red', 'render', first.message, `The render for ${failing.join(', ')} fails here.`, failing);
  });
}

interface Fence {
  mark: string;
  length: number;
}
interface HeadingWalk {
  fence: Fence | null;
  previous: number | null;
  findings: LintAnnotation[];
}

// CommonMark's rule: the same mark, at least as long, nothing after it; so a ```` block can quote a ``` one
function closes(fence: Fence, text: string): boolean {
  const match = FENCE.exec(text);
  return match !== null && match[1][0] === fence.mark && match[1].length >= fence.length && text.slice(match[0].length).trim() === '';
}

// A fence often quotes another file's headings, so they are not this file's levels
function headingStep(walk: HeadingWalk, text: string, line: number): HeadingWalk {
  if (walk.fence !== null) return closes(walk.fence, text) ? { ...walk, fence: null } : walk;
  const fence = FENCE.exec(text);
  if (fence !== null) return { ...walk, fence: { mark: fence[1][0], length: fence[1].length } };
  const heading = HEADING.exec(text);
  if (heading === null) return walk;
  const level = heading[1].length;
  const { previous } = walk;
  if (previous === null || level <= previous + 1) return { ...walk, previous: level };
  const body = `An h${level} right under an h${previous} skips a level; the block map nests it as an h${previous + 1}.`;
  return { ...walk, previous: level, findings: [...walk.findings, finding(line, 'yellow', 'heading', `skipped level: h${previous} to h${level}`, body)] };
}

function headingFindings(parsed: ParsedTemplate): LintAnnotation[] {
  const start: HeadingWalk = { fence: null, previous: null, findings: [] };
  return parsed.body.split('\n').reduce((walk, text, index) => headingStep(walk, text, parsed.bodyLine + index), start).findings;
}

const SEVERITY_RANK: Record<Severity, number> = { red: 0, yellow: 1 };
// Code-unit order, not the locale's: the editor's counter and the tests need the same order everywhere
const compareText = (a: string, b: string): number => Number(a > b) - Number(a < b);
const byPosition = (a: LintAnnotation, b: LintAnnotation): number =>
  a.line - b.line || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || compareText(a.title, b.title);

export function lintTemplate(parsed: ParsedTemplate, input: LintInput): LintAnnotation[] {
  // Every other check reads the header's variables, so a header that does not parse is answered alone
  if (parsed.errors.length > 0) return parsed.errors.map((error) => finding(error.line, 'red', 'parse', error.message, HEADER_BODY)).sort(byPosition);
  const statics = [...variableFindings(parsed), ...requiredFindings(parsed, input.workspaces), ...referenceFindings(parsed, input)];
  return [...statics, ...renderFindings(parsed, input.workspaces, statics), ...headingFindings(parsed)].sort(byPosition);
}
