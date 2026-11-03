import { parseTransitions, type SourcesParser } from './config-transitions.js';
import { flatten, isFlowName } from './flows.js';
import { onSource } from './tasks.js';
import { END, type Flow, type Stage } from './types.js';

// comb.flows in hive.config.json (#564), out of config.ts, which is over 400 lines. The prefix is config.ts's CONFIG_FILE, written out, and
// config.ts's own stage and source-map parsers are handed in: config.ts calls this file, so importing it back would make the two import each other.
const FILE = 'hive.config.json';

const fail = (field: string, what: string): never => {
  throw new Error(`${FILE}: "${field}" ${what}`);
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export interface FlowParsers { stage(raw: unknown, field: string): Stage; sources: SourcesParser }

interface NamedFlow { name: string; stages: Stage[] }

// Names are unique inside the flow and across flows (decision 4), so a stage name alone places a task; "end" is a transition's target
function checkStageNames(stages: Stage[], at: string, before: readonly NamedFlow[]): void {
  stages.forEach((stage, i) => {
    if (stage.name === END) fail(`${at}.stages[${i}].name`, 'cannot be "end": it names the end of the flow');
    if (stages.findIndex((s) => s.name === stage.name) !== i) fail(`${at}.stages[${i}].name`, 'must be unique');
    const holder = before.find((f) => f.stages.some((s) => s.name === stage.name));
    if (holder !== undefined) fail(`${at}.stages[${i}].name`, `"${stage.name}" is already a stage of flow "${holder.name}"`);
  });
}

// One flow's name and stages (rules 3 and 4): the transitions wait for every flow's stages, since an error names the flow that holds a stage
function parseFlowStages(raw: unknown, f: number, parse: FlowParsers, before: readonly NamedFlow[]): NamedFlow & { transitions: unknown } {
  const at = `comb.flows[${f}]`;
  if (!isRecord(raw)) return fail(at, 'must be an object');
  if (!isFlowName(raw.name)) return fail(`${at}.name`, 'must be a non-empty, trimmed string');
  const name = raw.name;
  if (before.some((other) => other.name === name)) fail(`${at}.name`, `"${name}" is already the name of another flow`);
  if (!Array.isArray(raw.stages) || raw.stages.length === 0) return fail(`${at}.stages`, 'must be a non-empty array');
  const stages = raw.stages.map((stage: unknown, i: number) => parse.stage(stage, `${at}.stages[${i}]`));
  checkStageNames(stages, at, before);
  return { name, stages, transitions: raw.transitions };
}

// A source column leads into one flow only (decision 5): two stages of one flow may share it, a stage of another flow may not
function checkDoors(flows: readonly NamedFlow[]): void {
  const doors = new Map<string, { stage: string; flow: string }>();
  for (const [f, flow] of flows.entries()) {
    for (const [i, stage] of flow.stages.entries()) {
      for (const source of Object.keys(stage.from)) {
        for (const column of onSource(stage.from, source) ?? []) {
          const key = JSON.stringify([source, column]);
          const door = doors.get(key);
          if (door === undefined) doors.set(key, { stage: stage.name, flow: flow.name });
          else if (door.flow !== flow.name) {
            fail(`comb.flows[${f}].stages[${i}].from.${source}`,
              `"${column}" already enters stage "${door.stage}" of flow "${door.flow}": stage "${stage.name}" of flow "${flow.name}" cannot enter from it too`);
          }
        }
      }
    }
  }
}

/** comb.flows (#564): required, non-empty, each flow named, with stages and transitions. */
export function parseFlows(comb: Record<string, unknown>, sourceNames: readonly string[], parse: FlowParsers): Flow[] {
  for (const flat of ['stages', 'transitions']) {
    if (comb[flat] !== undefined && comb.flows !== undefined) fail(`comb.${flat}`, 'cannot be combined with "comb.flows": the flat pair moved into the flows (#564)');
  }
  if (comb.flows === undefined) fail('comb.flows', 'is required');
  if (!Array.isArray(comb.flows) || comb.flows.length === 0) fail('comb.flows', 'must be a non-empty array');
  const parsed: Array<NamedFlow & { transitions: unknown }> = []; // each flow is judged against the ones before it
  for (const [f, raw] of (comb.flows as unknown[]).entries()) parsed.push(parseFlowStages(raw, f, parse, parsed));
  checkDoors(parsed);
  const flows = parsed.map((flow, f): Flow => {
    const others = parsed.filter((_, o) => o !== f).map((o) => ({ name: o.name, stages: o.stages, transitions: [] }));
    const scope = { field: `comb.flows[${f}].transitions`, flow: flow.name, stages: flow.stages, others };
    return { name: flow.name, stages: flow.stages, transitions: parseTransitions(flow.transitions, scope, parse.sources) };
  });
  const silent = sourceNames.find((name) => !flatten(flows).stages.some((s) => (onSource(s.from, name)?.length ?? 0) > 0));
  if (silent !== undefined) fail('comb.flows', `must have at least one stage with "from.${silent}"`);
  return flows;
}
