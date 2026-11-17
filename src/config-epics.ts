import { EPIC_FOLLOWS, EPICS_MODES, type SourceConfig, type Stage } from './types.js';

// A source's epics keys in hive.config.json (#30), out of config.ts, which is over 400 lines. The prefix is config.ts's CONFIG_FILE,
// written out: config.ts calls this file, so importing it back would make the two import each other.
const FILE = 'hive.config.json';

export type SourceEpics = Pick<SourceConfig, 'epics' | 'epicFollows' | 'switchAt'>;

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (!allowed.includes(value as T)) throw new Error(`${FILE}: "${field}" must be one of: ${allowed.join(', ')}`);
  return value as T;
}

/** The three epics keys both source types carry, required whatever the mode (#30): one message for missing and unknown. switchAt is judged
 * against the stages by requireSwitchAt, where they are known. */
export function parseEpicKeys(raw: Record<string, unknown>, field: string): SourceEpics {
  const epics = oneOf(raw.epics, EPICS_MODES, `${field}.epics`);
  const epicFollows = oneOf(raw.epicFollows, EPIC_FOLLOWS, `${field}.epicFollows`);
  if (raw.switchAt === undefined) throw new Error(`${FILE}: "${field}.switchAt" is required`);
  if (typeof raw.switchAt !== 'string' || raw.switchAt === '') throw new Error(`${FILE}: "${field}.switchAt" must be a non-empty string`);
  return { epics, epicFollows, switchAt: raw.switchAt };
}

/** #856: a GitHub source's own key. A Jira epic never deletes its activity (#820), so the jira member has no such key. */
export function parseEpicDeleteActivity(raw: Record<string, unknown>, field: string): boolean {
  if (typeof raw.epicDeleteActivity !== 'boolean') throw new Error(`${FILE}: "${field}.epicDeleteActivity" must be a boolean`);
  return raw.epicDeleteActivity;
}

/** Every source's switchAt names a stage of the flow (#30). Stage names are unique and compared exactly; both members carry
 * switchAt. */
export function requireSwitchAt(sources: readonly SourceConfig[], stages: readonly Stage[]): void {
  const i = sources.findIndex((s) => !stages.some((stage) => stage.name === s.switchAt));
  if (i !== -1) throw new Error(`${FILE}: "comb.sources[${i}].switchAt" is "${sources[i].switchAt}", which is not a stage of the flow`);
}

/** The old top-level key (#30): no compat path. Its meanings swap, so the message says where it went and what each old value is now. */
export function refuseTopLevelEpics(raw: Record<string, unknown>): void {
  if (raw.epics !== undefined) {
    throw new Error(`${FILE}: "epics" moved into each source (comb.sources[].epics); the old "ignore" is now "hide" and the old "queue" is now "ignore"`);
  }
}
