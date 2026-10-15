// Liquid conditions as data (#311, node 1.2 of #309): what the condition popover edits, parsed from a marker's text and written back to
// it. Node-free, like src/template.ts, so the editor and the server read a condition the same way.

export type ConditionOp = 'is' | 'isNot' | 'contains' | 'hasValue' | 'isBlank' | 'isNo';
export type ConditionValue = string | boolean | null;

export interface ConditionTerm {
  variable: string;
  op: ConditionOp;
  value?: ConditionValue; // is, isNot and contains only
}

export interface Condition {
  connective: 'and' | 'or'; // 'and' for a single term
  terms: ConditionTerm[];
}

export interface ChainSpec {
  branches: Condition[]; // branches[0] is the if, the rest elsif
  else: boolean;
}

const VARIABLE = '[A-Za-z_][A-Za-z0-9_]*';
const LITERAL = `"[^"]*"|'[^']*'|true|false|nil|null|blank`;
const BARE = new RegExp(`^${VARIABLE}$`);
const COMPARISON = new RegExp(`^(${VARIABLE})\\s*(==|!=)\\s*(${LITERAL})$`);
const CONTAINS = new RegExp(`^(${VARIABLE})\\s+contains\\s+(${LITERAL})$`);
// Liquid words that read like a variable and are not one
const KEYWORDS = ['true', 'false', 'nil', 'null', 'blank', 'empty', 'and', 'or', 'contains'];
const QUOTED = /"[^"]*"|'[^']*'/g;
// The quoted alternatives consume strings first, so an " and " inside a value is never taken for a connective.
const CONNECTIVE = /"[^"]*"|'[^']*'|\s+(and|or)\s+/g;
const BLANK = Symbol('blank');

type Literal = ConditionValue | typeof BLANK;

function literal(text: string): Literal {
  if (text === 'blank') return BLANK;
  if (text === 'true' || text === 'false') return text === 'true';
  if (text === 'nil' || text === 'null') return null;
  return text.slice(1, -1); // a quoted string: Liquid has no escapes inside one
}

function parseTerm(text: string): ConditionTerm | null {
  const term = text.trim();
  if (BARE.test(term)) return KEYWORDS.includes(term) ? null : { variable: term, op: 'hasValue' };
  const contains = CONTAINS.exec(term);
  if (contains !== null) {
    const value = literal(contains[2]);
    return value === BLANK ? null : { variable: contains[1], op: 'contains', value };
  }
  const compared = COMPARISON.exec(term);
  if (compared === null || KEYWORDS.includes(compared[1])) return null;
  const [, variable, operator, raw] = compared;
  const value = literal(raw);
  if (operator === '==' && value === BLANK) return { variable, op: 'isBlank' };
  if (operator === '==' && value === false) return { variable, op: 'isNo' };
  if (value === BLANK) return null; // != blank has no op of its own
  return { variable, op: operator === '==' ? 'is' : 'isNot', value };
}

export function parseCondition(text: string): Condition | null {
  // Liquid has no parentheses: a text holding one means something the model cannot write back
  if (/[()]/.test(text.replace(QUOTED, ''))) return null;
  const cuts = [...text.matchAll(CONNECTIVE)].filter((match) => match[1] !== undefined);
  const connectives = new Set(cuts.map((match) => match[1]));
  // mixed and/or: Liquid reads it right to left with no parentheses, a trap the visual editor must not write
  if (connectives.size > 1) return null;
  const starts = [0, ...cuts.map((match) => (match.index ?? 0) + match[0].length)];
  const ends = [...cuts.map((match) => match.index ?? 0), text.length];
  const parsed = starts.map((start, index) => parseTerm(text.slice(start, ends[index])));
  const terms = parsed.filter((term): term is ConditionTerm => term !== null);
  if (terms.length !== parsed.length) return null;
  return { connective: connectives.has('or') ? 'or' : 'and', terms };
}

function formatValue(value: ConditionValue | undefined): string {
  if (typeof value === 'string') return value.includes('"') ? `'${value}'` : `"${value}"`;
  return value === undefined || value === null ? 'nil' : String(value);
}

function formatTerm({ variable, op, value }: ConditionTerm): string {
  switch (op) {
    case 'hasValue':
      return variable;
    case 'isBlank':
      return `${variable} == blank`;
    case 'isNo':
      return `${variable} == false`;
    case 'is':
      return `${variable} == ${formatValue(value)}`;
    case 'isNot':
      return `${variable} != ${formatValue(value)}`;
    case 'contains':
      return `${variable} contains ${formatValue(value)}`;
  }
}

export const formatCondition = (condition: Condition): string => condition.terms.map(formatTerm).join(` ${condition.connective} `);

// unless is the root design's way of writing "is no" on a first branch; anywhere else isNo is written v == false
const unlessVariable = (condition: Condition | undefined): string | undefined =>
  condition?.terms.length === 1 && condition.terms[0].op === 'isNo' ? condition.terms[0].variable : undefined;

/** The marker lines of a chain, so insert and replace write the same text. */
export function chainMarkers(chain: ChainSpec): string[] {
  if (chain.branches.length === 0) return [];
  const [first, ...rest] = chain.branches;
  const unless = unlessVariable(first);
  return [
    unless === undefined ? `{% if ${formatCondition(first)} %}` : `{% unless ${unless} %}`,
    ...rest.map((condition) => `{% elsif ${formatCondition(condition)} %}`),
    ...(chain.else ? ['{% else %}'] : []),
    unless === undefined ? '{% endif %}' : '{% endunless %}',
  ];
}
