import { type DeclaredViewport, DESIGN_VIEWPORT_PX, type DesignTweakValue } from './types.js';

// A design's tweaks (#241): the props of a .hv.html screen its hv-tweaks block declares. The frame's content is untrusted, so the pane parses
// the raw block here; the review routes check a comment's values by the same limits. assets/plugin/scripts/check-hv.mjs carries a copy of
// these rules, since the plugin is copied out of the repository; test/plugin-scripts.test.ts keeps the two in step.

/** A tweak's name (#241): it becomes the data-tweak-<name> attribute. */
export const TWEAK_NAME = /^[a-z][a-z0-9-]*$/;
/** The most tweaks a block, and so a comment's anchor, holds (#241). */
export const TWEAKS_MAX = 32;
/** The longest text value (#241), so an anchor stays small. */
export const TWEAK_TEXT_MAX = 200;
/** The longest tweak name and the most options of an enum (#241), so an anchor stays small. */
export const TWEAK_NAME_MAX = 64;
export const TWEAK_OPTIONS_MAX = 64;

/** A tweak's condition (#1034): tweak name → the values under which it is shown; it holds when every key's value is one of its values. */
export type TweakWhen = Readonly<Record<string, readonly DesignTweakValue[]>>;
type Common = { group?: string; when?: TweakWhen };
export type TweakDef =
  | ({ type: 'enum'; options: string[]; default: string } & Common)
  | ({ type: 'boolean'; default: boolean } & Common)
  | ({ type: 'text'; default: string } & Common)
  | ({ type: 'number'; default: number; min?: number; max?: number; step?: number } & Common);
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** A definition without its default (#241): all fitValue reads, so a default is checked before it is kept. */
export type TweakShape = DistributiveOmit<TweakDef, 'default'>;
/** The block in declared order (#241). */
export type TweakSchema = ReadonlyArray<{ name: string } & TweakDef>;
export type ParsedTweaks = { ok: true; schema: TweakSchema; viewports: DeclaredViewport[] } | { ok: false; reason: string };
type Bounds = { min?: number; max?: number; step?: number };

const BOUNDS = ['min', 'max', 'step'] as const;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** `value` as `def` takes it (#241); undefined when it does not fit. */
export function fitValue(def: TweakShape, value: unknown): DesignTweakValue | undefined {
  if (def.type === 'enum') return typeof value === 'string' && def.options.includes(value) ? value : undefined;
  if (def.type === 'boolean') return typeof value === 'boolean' ? value : undefined;
  if (def.type === 'text') return typeof value === 'string' && value.length <= TWEAK_TEXT_MAX ? value : undefined;
  return isNumber(value) && value >= (def.min ?? Number.NEGATIVE_INFINITY) && value <= (def.max ?? Number.POSITIVE_INFINITY) ? value : undefined;
}

function optionsOf(raw: unknown): string[] | string {
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every((option): option is string => typeof option === 'string' && option !== '')) {
    return 'options must be a non-empty list of non-empty strings';
  }
  if (raw.length > TWEAK_OPTIONS_MAX) return `at most ${TWEAK_OPTIONS_MAX} options`;
  if (raw.some((option) => option.length > TWEAK_TEXT_MAX)) return `an option is at most ${TWEAK_TEXT_MAX} characters`;
  return new Set(raw).size === raw.length ? raw : 'options must be unique';
}

function boundsOf(raw: Record<string, unknown>): Bounds | string {
  const present = BOUNDS.filter((key) => raw[key] !== undefined);
  if (!present.every((key) => isNumber(raw[key]))) return 'min, max and step must be numbers';
  const bounds = Object.fromEntries(present.map((key) => [key, raw[key]])) as Bounds;
  if (bounds.min !== undefined && bounds.max !== undefined && bounds.min > bounds.max) return 'min must not be above max';
  return bounds.step !== undefined && bounds.step <= 0 ? 'step must be above 0' : bounds;
}

// A definition's shape, its default checked after: an enum is written without a type
function shapeOf(raw: Record<string, unknown>): TweakShape | string {
  const { type, group } = raw;
  if (group !== undefined && typeof group !== 'string') return 'group must be a string';
  if (group !== undefined && group.length > TWEAK_TEXT_MAX) return `group is at most ${TWEAK_TEXT_MAX} characters`;
  const grouped = group === undefined ? {} : { group };
  if (type === undefined || type === 'enum') {
    const options = optionsOf(raw.options);
    return typeof options === 'string' ? options : { type: 'enum', options, ...grouped };
  }
  if (type === 'boolean' || type === 'text') return { type, ...grouped };
  if (type !== 'number') return `unknown type ${JSON.stringify(type)}`;
  const bounds = boundsOf(raw);
  return typeof bounds === 'string' ? bounds : { type, ...bounds, ...grouped };
}

// One key of a when (#1034): a tweak declared above, with a non-empty list of unique values it takes; a single value is a list of one
function conditionOf(other: string, raw: unknown, above: TweakSchema): [string, DesignTweakValue[]] | string {
  const def = above.find((tweak) => tweak.name === other);
  if (def === undefined) return `when names "${other.slice(0, TWEAK_NAME_MAX)}", not a tweak declared above it`;
  const values: unknown[] = Array.isArray(raw) ? raw : [raw];
  if (values.length === 0 || values.length > TWEAK_OPTIONS_MAX || new Set(values).size !== values.length) {
    return `when: ${other}'s values must be a non-empty list of unique values, at most ${TWEAK_OPTIONS_MAX}`;
  }
  const fitted = values.map((value) => fitValue(def, value));
  const misfit = fitted.indexOf(undefined);
  if (misfit !== -1) return `when: ${JSON.stringify(values[misfit])} does not fit ${other}`;
  return [other, fitted.filter((value): value is DesignTweakValue => value !== undefined)];
}

// A condition that can never hold is refused rather than silently hiding a control (#1034)
function whenOf(raw: unknown, above: TweakSchema): TweakWhen | string {
  if (!isRecord(raw) || Object.keys(raw).length === 0) return 'when must be a non-empty object of tweak name to value';
  const conditions = Object.entries(raw).map(([other, values]) => conditionOf(other, values, above));
  const reason = conditions.find((condition): condition is string => typeof condition === 'string');
  return reason ?? Object.fromEntries(conditions.filter((condition) => typeof condition !== 'string'));
}

function defOf(name: string, raw: unknown, above: TweakSchema): ({ name: string } & TweakDef) | string {
  if (!TWEAK_NAME.test(name)) return `"${name}" is not a tweak name: [a-z][a-z0-9-]*`;
  if (name.length > TWEAK_NAME_MAX) return `"${name.slice(0, 16)}…" is longer than ${TWEAK_NAME_MAX} characters`;
  if (!isRecord(raw)) return `${name}: a definition is an object`;
  const shape = shapeOf(raw);
  if (typeof shape === 'string') return `${name}: ${shape}`;
  const value = fitValue(shape, raw.default);
  if (value === undefined) return `${name}: the default does not fit`;
  const when = raw.when === undefined ? undefined : whenOf(raw.when, above);
  if (typeof when === 'string') return `${name}: ${when}`;
  return { name, ...shape, default: value, ...(when === undefined ? {} : { when }) } as { name: string } & TweakDef;
}

// Each definition checked against those declared above it (#1034): a when names only an earlier tweak, so no cycle can form
function defsOf(entries: [string, unknown][]): TweakSchema | string {
  return entries.reduce<TweakSchema | string>((above, [name, raw]) => {
    if (typeof above === 'string') return above;
    const def = defOf(name, raw, above);
    return typeof def === 'string' ? def : above.concat(def);
  }, []);
}

const isDeclared = (value: string): value is DeclaredViewport => Object.hasOwn(DESIGN_VIEWPORT_PX, value);

// The reserved key (#341): the fixed viewports the screen lays out at. Not a tweak: no control, no attribute, not counted toward TWEAKS_MAX
function viewportsOf(raw: unknown): DeclaredViewport[] | string {
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every((item): item is string => typeof item === 'string')) {
    return 'viewports must be a non-empty list of desktop, tablet, mobile';
  }
  const foreign = raw.find((item) => !isDeclared(item));
  if (foreign !== undefined) return `viewports: unknown viewport ${JSON.stringify(foreign)}`;
  return new Set(raw).size === raw.length ? raw.filter(isDeclared) : 'viewports must be unique';
}

/** The hv-tweaks block (#241): an object of name → definition, in declared order, and its reserved viewports (#341), or the first reason
 *  it is refused. */
export function parseTweaks(raw: unknown): ParsedTweaks {
  if (!isRecord(raw)) return { ok: false, reason: 'the block is an object of name to definition' };
  const { viewports: declared, ...tweaks } = raw;
  const viewports: DeclaredViewport[] | string = declared === undefined ? [] : viewportsOf(declared);
  if (typeof viewports === 'string') return { ok: false, reason: viewports };
  const entries = Object.entries(tweaks);
  if (entries.length > TWEAKS_MAX) return { ok: false, reason: `at most ${TWEAKS_MAX} tweaks` };
  const schema = defsOf(entries);
  return typeof schema === 'string' ? { ok: false, reason: schema } : { ok: true, schema, viewports };
}

/** Every tweak of `schema` with its value from `values` when it fits, else its default (#241); names outside the schema are dropped. */
export function settle(schema: TweakSchema, values: Readonly<Record<string, DesignTweakValue>>): Record<string, DesignTweakValue> {
  return Object.fromEntries(schema.map((tweak) => [tweak.name, (Object.hasOwn(values, tweak.name) ? fitValue(tweak, values[tweak.name]) : undefined) ?? tweak.default]));
}

/** True when `a` and `b` settle to the same values (#241): a name the schema no longer has is ignored. */
export function sameState(schema: TweakSchema, a: Readonly<Record<string, DesignTweakValue>>, b: Readonly<Record<string, DesignTweakValue>>): boolean {
  const [left, right] = [settle(schema, a), settle(schema, b)];
  return schema.every(({ name }) => left[name] === right[name]);
}

/** The tweaks shown on `values` (#1034), settled first: one pass in declared order, so a tweak whose when names a tweak not shown is not
 *  shown either. A hidden tweak's value stays applied; only its control is hidden. */
export function shownTweaks(schema: TweakSchema, values: Readonly<Record<string, DesignTweakValue>>): ReadonlySet<string> {
  const settled = settle(schema, values);
  const holds = (when: TweakWhen, shown: ReadonlySet<string>): boolean =>
    Object.entries(when).every(([other, allowed]) => shown.has(other) && allowed.includes(settled[other]));
  return schema.reduce<ReadonlySet<string>>((shown, { name, when }) => (when === undefined || holds(when, shown) ? new Set(shown).add(name) : shown), new Set());
}
