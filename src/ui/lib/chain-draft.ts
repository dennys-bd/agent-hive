// The condition form's draft (#322, node 3.8 of #309): what the chain card and the condition popover edit, read from a chain of the map and
// written back as the ChainSpec the text edits take. Pure, so the rules are tested without React; the root tsc compiles it too.
import { type ChainSpec, type Condition, type ConditionOp, type ConditionTerm, conditionProblem } from '../../template-condition.js';
import type { ChainBlock } from '../../template-preview.js';
import type { ParsedTemplate, TemplateVariable, VariableKind } from '../../template.js';

export type DraftOp = ConditionOp | 'isOneOf';
export interface DraftTerm { variable?: string; op?: DraftOp; values: string[] } // values: one for is / isNot / contains, several for isOneOf
export interface DraftBlock { connective: 'and' | 'or'; terms: DraftTerm[] }
export interface Draft { blocks: DraftBlock[]; else: boolean } // blocks[0] is the if
/** A variable the form offers (decision 8): the header's, and the built-in workspace as a list of the configured workspaces. */
export interface FormVariable { name: string; kind: VariableKind; values: readonly string[] }
type Variables = readonly FormVariable[];

export const BUILT_IN = 'workspace';
// The handoff's operators per kind (decision 6); a yes/no's hasValue is "is yes", its isNo "is no"
const OPS: Record<VariableKind, readonly DraftOp[]> = {
  text: ['is', 'isNot', 'contains', 'hasValue', 'isBlank'],
  list: ['is', 'isNot', 'isOneOf'],
  boolean: ['hasValue', 'isNo'],
};
const SINGLE: readonly DraftOp[] = ['is', 'isNot', 'contains'];

export const opsFor = (kind: VariableKind): readonly DraftOp[] => OPS[kind];
/** "is one of…" writes or, so a condition of several terms offers it only as an or (decision 5). */
export const offeredOps = (kind: VariableKind, block: DraftBlock): readonly DraftOp[] =>
  OPS[kind].filter((op) => op !== 'isOneOf' || block.terms.length === 1 || block.connective === 'or');
export const takesValue = (op: DraftOp | undefined): boolean => op !== undefined && (op === 'isOneOf' || SINGLE.includes(op));
export const newTerm = (): DraftTerm => ({ values: [] });
export const newBlock = (): DraftBlock => ({ connective: 'and', terms: [newTerm()] });
export const emptyDraft = (): Draft => ({ blocks: [newBlock()], else: false });

export function formVariables(variables: readonly TemplateVariable[], workspaces: readonly string[]): FormVariable[] {
  return [...variables.map(({ name, kind, values }) => ({ name, kind, values: values ?? [] })), { name: BUILT_IN, kind: 'list', values: workspaces }];
}

/** A value the edits would refuse (a line break, a Liquid delimiter, both quotes): the field says so first (decision 7). */
export const isValueRefused = (value: string): boolean =>
  conditionProblem({ connective: 'and', terms: [{ variable: 'v', op: 'is', value }] }) !== undefined;

/** An operator change keeps what still fits: every value for "is one of…", the first for a one-value operator, none otherwise. */
export function withOp(term: DraftTerm, op: DraftOp): DraftTerm {
  if (op === 'isOneOf') return { ...term, op };
  return { ...term, op, values: SINGLE.includes(op) ? term.values.slice(0, 1) : [] };
}

// "+ and / or" (decision 4): beside an "is one of…" the condition can only be an or
export const addTerm = (block: DraftBlock): DraftBlock => ({
  connective: block.terms.some((term) => term.op === 'isOneOf') ? 'or' : block.connective,
  terms: [...block.terms, newTerm()],
});

// and cannot hold an "is one of…" of several terms: its operator clears, so ok waits for another (decisions 5, 9)
export const withConnective = (block: DraftBlock, connective: 'and' | 'or'): DraftBlock => ({
  connective,
  terms: connective === 'or' ? block.terms : block.terms.map((term) => (term.op === 'isOneOf' ? { variable: term.variable, values: [] } : term)),
});

export const updateBlock = (draft: Draft, index: number, change: (block: DraftBlock) => DraftBlock): Draft =>
  ({ ...draft, blocks: draft.blocks.map((block, at) => (at === index ? change(block) : block)) });
export const updateTerm = (block: DraftBlock, index: number, change: (term: DraftTerm) => DraftTerm): DraftBlock =>
  ({ ...block, terms: block.terms.map((term, at) => (at === index ? change(term) : term)) });

const kindOf = (variables: Variables, name: string | undefined): VariableKind | undefined => variables.find((v) => v.name === name)?.kind;

// A term the form can show as it is, or null: an undeclared variable, an operator its kind lacks, a non-text value or a list value it does not
// declare would be rewritten
function termOf(term: ConditionTerm, variables: Variables): DraftTerm | null {
  const variable = variables.find((v) => v.name === term.variable);
  if (variable === undefined || !OPS[variable.kind].includes(term.op)) return null;
  if (!SINGLE.includes(term.op)) return { variable: term.variable, op: term.op, values: [] };
  if (typeof term.value !== 'string') return null;
  // a list's select shows only its declared values: an undeclared one would be rewritten unseen
  return variable.kind === 'list' && !variable.values.includes(term.value) ? null : { variable: term.variable, op: term.op, values: [term.value] };
}

// Decision 5: an or run of is on one list variable reads back as one "is one of…" at its first term's place
function folded(terms: DraftTerm[], variables: Variables): DraftTerm[] {
  return terms.flatMap((term): DraftTerm[] => {
    if (term.op !== 'is' || kindOf(variables, term.variable) !== 'list') return [term];
    const run = terms.filter((other) => other.op === 'is' && other.variable === term.variable);
    if (run.length < 2) return [term];
    return run[0] === term ? [{ variable: term.variable, op: 'isOneOf', values: run.flatMap((other) => other.values) }] : [];
  });
}

function blockOf(condition: Condition | null, variables: Variables): DraftBlock | null {
  if (condition === null) return null;
  const read = condition.terms.map((term) => termOf(term, variables));
  const terms = read.filter((term): term is DraftTerm => term !== null);
  if (terms.length !== read.length) return null;
  return { connective: condition.connective, terms: condition.connective === 'or' ? folded(terms, variables) : terms };
}

/** A chain of the map as the form shows it, or null for decision 14's raw view. */
export function draftOf(chain: ChainBlock, variables: Variables): Draft | null {
  const read = chain.branches.filter((branch) => branch.marker !== 'else').map((branch) => blockOf(branch.condition, variables));
  const blocks = read.filter((block): block is DraftBlock => block !== null);
  return blocks.length === read.length ? { blocks, else: chain.branches.some((branch) => branch.marker === 'else') } : null;
}

function termsOf({ variable, op, values }: DraftTerm, variables: Variables): ConditionTerm[] | null {
  const kind = kindOf(variables, variable);
  if (variable === undefined || kind === undefined || op === undefined || !OPS[kind].includes(op)) return null;
  if (op === 'isOneOf') return values.length > 0 ? values.map((value): ConditionTerm => ({ variable, op: 'is', value })) : null;
  if (!SINGLE.includes(op)) return [{ variable, op }];
  return values.length === 1 && values[0] !== '' ? [{ variable, op, value: values[0] }] : null;
}

function conditionOf(block: DraftBlock, variables: Variables): Condition | null {
  const read = block.terms.map((term) => termsOf(term, variables));
  if (read.some((terms) => terms === null)) return null;
  const isLone = block.terms.length === 1;
  if (!isLone && block.connective === 'and' && block.terms.some((term) => term.op === 'isOneOf')) return null;
  const terms = read.filter((t): t is ConditionTerm[] => t !== null).flat();
  const condition: Condition = { connective: isLone && terms.length > 1 ? 'or' : block.connective, terms };
  return conditionProblem(condition) === undefined ? condition : null;
}

/** The chain insert and ok write, or null while a term is incomplete or refused (decisions 7, 9); "is one of…" expands to or'ed is terms. */
export function specOf(draft: Draft, variables: Variables): ChainSpec | null {
  const read = draft.blocks.map((block) => conditionOf(block, variables));
  const branches = read.filter((condition): condition is Condition => condition !== null);
  return branches.length === read.length && branches.length > 0 ? { branches, else: draft.else } : null;
}

/** A chain's markers as its text writes them (decision 14): the raw view's reach reads these. */
export const rawMarkers = (chain: ChainBlock): string[] => [
  ...chain.branches.map((branch) => (branch.marker === 'else' ? '{% else %}' : `{% ${branch.marker} ${branch.conditionText} %}`)),
  `{% end${chain.tag} %}`,
];

/** The trailing "+"'s line (decision 10): the one after the body's last, insertChain's upper bound. */
export function appendLine({ body, bodyLine }: ParsedTemplate): number {
  return bodyLine + (body === '' ? 0 : body.split('\n').length - (body.endsWith('\n') ? 1 : 0));
}
