import { TASK_PROPS, type RuleOp, type SourceTaskProps, type TaskProps, type TaskRule } from './types.js';

// A source's task properties (#293, #688): their parser and its matcher, out of config.ts, which is over 400 lines. Node-free, so the settings form
// reads the limits too. The prefix is config.ts's CONFIG_FILE, written out: importing it would make the two files import each other.
const FILE = 'hive.config.json';

export const RULE_OPS: readonly RuleOp[] = ['equals', 'iequals', 'contains', 'icontains'];
export const RULES_MAX = 50; // bounds the matching work per item; the GitHub query does not grow with rules (they ride fieldValues, #245)
export const RULE_VALUE_MAX = 200;
export const RULE_FIELD_MAX = 100;

const MATCHES: Record<RuleOp, (have: string, want: string) => boolean> = {
  equals: (have, want) => have === want,
  iequals: (have, want) => have.toLowerCase() === want.toLowerCase(),
  contains: (have, want) => have.includes(want),
  icontains: (have, want) => have.toLowerCase().includes(want.toLowerCase()),
};

const matches = (rule: TaskRule, read: (field: string) => string[]): boolean =>
  read(rule.field).some((have) => MATCHES[rule.op](have.trim(), rule.value.trim()));

/** Per property, the `set` value of the first rule that matches and sets it (#688): a rule that sets only workspace never shadows a later one
 * that sets auto. A property no matching rule sets is absent. `read(field)` answers one item's values of that field, [] when it has none, so a rule on a missing field never matches: rule values are never empty. */
export function matchTaskProps(rules: readonly TaskRule[], read: (field: string) => string[]): Partial<TaskProps> {
  const matching = rules.filter((rule) => matches(rule, read));
  const workspace = matching.find((r) => r.set.workspace !== undefined)?.set.workspace;
  const auto = matching.find((r) => r.set.auto !== undefined)?.set.auto;
  return { ...(workspace === undefined ? {} : { workspace }), ...(auto === undefined ? {} : { auto }) };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function fail(field: string, what: string): never {
  throw new Error(`${FILE}: "${field}" ${what}`);
}

function named(value: unknown, field: string, workspaces: readonly string[]): string {
  return typeof value === 'string' && workspaces.includes(value) ? value : fail(field, 'must name one of "comb.workspaces"');
}

// Trimmed, 1 to `max` characters: an empty value would match every item under contains.
function bounded(value: unknown, field: string, max: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length >= 1 && text.length <= max ? text : fail(field, `must be 1 to ${max} characters`);
}

const SHAPE = 'must be an object like { "defaults": { "auto": true }, "rules": [] }';

const parseBoolean = (value: unknown, field: string): boolean => (typeof value === 'boolean' ? value : fail(field, 'must be true or false'));

// The defaults' or a rule's `set` (#688): only TASK_PROPS keys; workspace names one of the Comb's, auto is a boolean.
function parseProps(raw: Record<string, unknown>, field: string, workspaces: readonly string[]): Partial<TaskProps> {
  const unknown = Object.keys(raw).find((key) => !(TASK_PROPS as readonly string[]).includes(key));
  if (unknown !== undefined) fail(`${field}.${unknown}`, `is not a task property: ${TASK_PROPS.join(', ')}`);
  return {
    ...(raw.workspace === undefined ? {} : { workspace: named(raw.workspace, `${field}.workspace`, workspaces) }),
    ...(raw.auto === undefined ? {} : { auto: parseBoolean(raw.auto, `${field}.auto`) }),
  };
}

function parseTaskRule(raw: unknown, field: string, workspaces: readonly string[]): TaskRule {
  if (!isRecord(raw)) return fail(field, 'must be an object');
  const op = raw.op as RuleOp;
  const rule = {
    field: bounded(raw.field, `${field}.field`, RULE_FIELD_MAX),
    op: RULE_OPS.includes(op) ? op : fail(`${field}.op`, `must be one of: ${RULE_OPS.join(', ')}`),
    value: bounded(raw.value, `${field}.value`, RULE_VALUE_MAX),
  };
  const set = isRecord(raw.set) ? parseProps(raw.set, `${field}.set`, workspaces) : {};
  return Object.keys(set).length > 0 ? { ...rule, set } : fail(`${field}.set`, `must set 1 or more of: ${TASK_PROPS.join(', ')}`);
}

/** A source's `taskProps` (#688): required; `defaults.auto` a boolean, `defaults.workspace` optional, 0 to RULES_MAX rules. The #293 `workspace`
 * setting gets the shape message: no compat path. With no default workspace, some rule must set one. */
export function parseSourceTaskProps(raw: unknown, field: string, workspaces: readonly string[]): SourceTaskProps {
  if (!isRecord(raw) || !isRecord(raw.defaults)) return fail(field, SHAPE);
  const { workspace, auto } = parseProps(raw.defaults, `${field}.defaults`, workspaces);
  if (auto === undefined) return fail(`${field}.defaults.auto`, 'must be true or false');
  const { rules } = raw;
  if (!Array.isArray(rules) || rules.length > RULES_MAX) return fail(`${field}.rules`, `must be an array of 0 to ${RULES_MAX} rules`);
  const parsed = rules.map((rule, i) => parseTaskRule(rule, `${field}.rules[${i}]`, workspaces));
  if (workspace === undefined && !parsed.some((r) => r.set.workspace !== undefined)) {
    return fail(`${field}.defaults.workspace`, 'is required when no rule sets workspace');
  }
  return { defaults: workspace === undefined ? { auto } : { workspace, auto }, rules: parsed };
}

/** A file from before #688: a source whose `taskProps` is not an object (the #293 `workspace` setting, or nothing). Boot opens the settings
 * form with the parse error instead of dying, as it does for #180's comb.board; nothing is prefilled. */
export function predatesTaskProps(raw: unknown): boolean {
  const comb = isRecord(raw) ? raw.comb : undefined;
  const sources = isRecord(comb) ? comb.sources : undefined;
  return Array.isArray(sources) && sources.some((source) => isRecord(source) && !isRecord(source.taskProps));
}
