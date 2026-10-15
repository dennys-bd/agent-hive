// The structural lint of a skill or agent template (#312, node 1.3 of #309): the annotations the editor shows on every change (4.1).
// Pure and node-free like src/template.ts: it reads the parse and what the caller gives, never the disk, so the UI runs the same code.
import { Liquid, type StaticAnalysis } from 'liquidjs';
import { liquidError, type ParsedTemplate, type TemplateVariable } from './template.js';
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
const HEADER_BODY = 'The header must parse before anything else is checked.';

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

// One annotation per variable, naming every workspace that misses it: the editor keys annotations by line
function requiredFindings(parsed: ParsedTemplate, workspaces: string[]): LintAnnotation[] {
  return parsed.variables.flatMap((variable) => {
    const missing = missingIn(variable, workspaces);
    if (missing.length === 0) return [];
    const names = missing.join(', ');
    return [finding(variable.line, 'red', 'required', `missing ${variable.name} · ${names}`, `"${variable.name}" is required and has no value for ${names}.`, missing)];
  });
}

const byLine = (a: LintAnnotation, b: LintAnnotation): number => a.line - b.line;

export function lintTemplate(parsed: ParsedTemplate, input: LintInput): LintAnnotation[] {
  // Every other check reads the header's variables, so a header that does not parse is answered alone
  if (parsed.errors.length > 0) return parsed.errors.map((error) => finding(error.line, 'red', 'parse', error.message, HEADER_BODY)).sort(byLine);
  return [...variableFindings(parsed), ...requiredFindings(parsed, input.workspaces)].sort(byLine);
}
