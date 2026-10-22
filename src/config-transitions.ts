import { agentOf } from './agents.js';
import { hiveActionRaw, runsAgentRaw } from './config-stage-agent.js';
import { hasFixedVerdicts, runsAgent } from './stage-agent.js';
import { isGate } from './tasks.js';
import { isAutomatic, transitionKey, verdictsOf } from './transitions.js';
import { END, TRIGGERS, type AgentId, type SourceAction, type Stage, type Transition, type TransitionSession, type Trigger } from './types.js';

// comb.transitions and a stage's verdicts in hive.config.json (#134), out of config.ts, which is over 400 lines. The prefix is config.ts's
// CONFIG_FILE, written out, and the source maps are config.ts's own parser, handed in: config.ts calls this file, so importing it back would
// make the two import each other.
const FILE = 'hive.config.json';

function fail(field: string, what: string): never {
  throw new Error(`${FILE}: "${field}" ${what}`);
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** config.ts's source map of action lists, as onStart is read: a source the Comb has, a leaving action only last. */
export type SourcesParser = (raw: unknown, field: string) => Record<string, SourceAction[]>;

/** A stage's own verdicts (#134): prompt stages only, a non-empty list of distinct trimmed names. A stage with an action has fixed ones; a stage
 * with nothing to run gives none. */
export function parseVerdicts(raw: Record<string, unknown>, field: string): Pick<Stage, 'verdicts'> {
  if (raw.verdicts === undefined) return {};
  if (hiveActionRaw(raw)) fail(`${field}.verdicts`, 'cannot be combined with "action": its verdicts are fixed'); // #710: a skill stage gives its own
  if (!runsAgentRaw(raw)) fail(`${field}.verdicts`, 'needs "prompt": a stage that runs nothing gives no verdict');
  const list: unknown = raw.verdicts;
  const names = Array.isArray(list) && list.every((v): v is string => typeof v === 'string' && v !== '' && v === v.trim()) ? list : undefined;
  if (names === undefined || names.length === 0 || new Set(names).size !== names.length) return fail(`${field}.verdicts`, 'must be a non-empty array of distinct, trimmed names');
  return { verdicts: names };
}

const stageNamed = (value: unknown, field: string, stages: readonly Stage[]): Stage =>
  (typeof value === 'string' ? stages.find((s) => s.name === value) : undefined) ?? fail(field, 'names no stage');

const target = (value: unknown, field: string, stages: readonly Stage[]): string =>
  (value === END ? END : (typeof value === 'string' ? stages.find((s) => s.name === value)?.name : undefined) ?? fail(field, `names no stage nor "${END}"`));

const trigger = (value: unknown, field: string): Trigger => TRIGGERS.find((t) => t === value) ?? fail(field, 'must be "done", "approved", "feedback" or "verdict"');

// verdict goes with when verdict only and names one the origin can give: its own on a prompt stage, passed / failed on commands and wait for CI
function parseVerdict(raw: Record<string, unknown>, field: string, from: Stage, when: Trigger): Pick<Transition, 'verdict'> {
  if (when !== 'verdict') {
    if (raw.verdict !== undefined) fail(`${field}.verdict`, 'needs "when": "verdict"');
    return {};
  }
  if (typeof raw.verdict !== 'string') return fail(`${field}.verdict`, 'is required with "when": "verdict"');
  const allowed = verdictsOf(from);
  if (allowed.length === 0) fail(`${field}.verdict`, `names a verdict "${from.name}" cannot give: it has none`);
  if (!allowed.includes(raw.verdict)) fail(`${field}.verdict`, `must be one of "${from.name}"'s verdicts: ${allowed.join(', ')}`);
  return { verdict: raw.verdict };
}

// approved and feedback answer a stage with approval; done leaves a stage without it, except commands, wait for CI and evaluate (#877), which only end with
// passed or failed; a gate runs nothing, so its feedback goes to the stage
// that does the work
function checkTrigger(from: Stage, when: Trigger, to: string, field: string): void {
  if ((when === 'approved' || when === 'feedback') && from.approval !== true) fail(`${field}.when`, `"${when}" needs "${from.name}" to have "approval"`);
  if (when === 'done' && from.approval === true) fail(`${field}.when`, `"done" cannot leave "${from.name}", which has "approval": use "approved"`);
  if (when === 'done' && hasFixedVerdicts(from)) {
    fail(`${field}.when`, `"done" cannot leave "${from.name}", which ends with a verdict: use "verdict" with "passed" or "failed"`);
  }
  if (when === 'feedback' && to === from.name && isGate(from)) fail(`${field}.to`, 'cannot be the gate itself: a gate runs nothing, so its feedback goes to another stage');
}

function parseMaxTries(value: unknown, when: Trigger, field: string): Pick<Transition, 'maxTries'> {
  if (value === undefined) return {};
  if (!isAutomatic(when)) fail(field, 'only goes with "when": "done" or "verdict": your transitions have no limit');
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return fail(field, 'must be an integer ≥ 1');
  return { maxTries: value };
}

function parseSession(value: unknown, field: string, stages: readonly Stage[]): Pick<Transition, 'session'> {
  if (value === undefined) return {};
  if (value === 'previous' || value === 'new') return { session: value };
  if (!isRecord(value) || Object.keys(value).length !== 1 || value.continueOf === undefined) return fail(field, 'must be "previous", "new" or { "continueOf": "<stage>" }');
  const session: TransitionSession = { continueOf: stageNamed(value.continueOf, `${field}.continueOf`, stages).name };
  return { session };
}

function text(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') return fail(field, 'must be a non-empty string');
  return value;
}

function parseTransition(raw: unknown, field: string, stages: readonly Stage[], parseSources: SourcesParser): Transition {
  if (!isRecord(raw)) return fail(field, 'must be an object');
  const from = stageNamed(raw.from, `${field}.from`, stages);
  const to = target(raw.to, `${field}.to`, stages);
  const when = trigger(raw.when, `${field}.when`);
  const verdict = parseVerdict(raw, field, from, when);
  checkTrigger(from, when, to, field);
  const label = text(raw.label, `${field}.label`);
  const prompt = text(raw.prompt, `${field}.prompt`);
  return {
    from: from.name, to, when, ...verdict, ...(label === undefined ? {} : { label: label.trim() }), ...(prompt === undefined ? {} : { prompt }),
    ...parseSession(raw.session, `${field}.session`, stages), ...parseMaxTries(raw.maxTries, when, `${field}.maxTries`),
    ...(raw.sources === undefined ? {} : { sources: parseSources(raw.sources, `${field}.sources`) }),
  };
}

/** comb.transitions (#134): required, [] allowed (every stage end then stops its task); each checked against the stages and named by its
 * index; no two with the same (from, when, verdict), the transition's key. */
export function parseTransitions(raw: unknown, stages: readonly Stage[], parseSources: SourcesParser): Transition[] {
  if (raw === undefined) fail('comb.transitions', 'is required');
  if (!Array.isArray(raw)) return fail('comb.transitions', 'must be an array');
  const transitions = raw.map((t: unknown, i: number) => parseTransition(t, `comb.transitions[${i}]`, stages, parseSources));
  const keys = transitions.map(transitionKey);
  const twin = keys.findIndex((key, i) => keys.indexOf(key) !== i);
  if (twin !== -1) fail(`comb.transitions[${twin}]`, 'repeats the "from", "when" and "verdict" of an earlier transition');
  return transitions;
}

// The stage whose session a transition resumes, when the flow alone says it (#925): previous and a plain move into a continue stage resume
// the origin's, continueOf names its stage; a new session, or a move into a stage that starts its own, resumes nothing
function resumedStage(transition: Transition, to: Stage): string | undefined {
  if (transition.session === 'previous') return transition.from;
  if (typeof transition.session === 'object') return transition.session.continueOf;
  return transition.session === undefined && to.session === 'continue' ? transition.from : undefined;
}

/** #925: every transition whose resumed session the flow names, refused when that session's agent is not its destination's: one agent cannot
 * resume another's session, a handoff (#692) switches them. Pure, so it is tested with a stage of a second agent before AGENT_IDS has one;
 * parseConfig runs it once defaultAgent is parsed. */
export function checkResumedAgents(stages: readonly Stage[], transitions: readonly Transition[], defaultAgent: AgentId): void {
  transitions.forEach((transition, i) => {
    const to = stages.find((s) => s.name === transition.to);
    const resumed = to === undefined ? undefined : resumedStage(transition, to);
    const from = stages.find((s) => s.name === resumed);
    if (to === undefined || from === undefined || !runsAgent(to) || !runsAgent(from)) return;
    const was = agentOf(from, { defaultAgent });
    const now = agentOf(to, { defaultAgent });
    if (was !== now) fail(`comb.transitions[${i}].session`, `resumes a session of ${was} in a stage of ${now}: use "handoff" to switch agents (#692)`);
  });
}

// #494: the transitions into an agent stage a task can take after leaving `from` with no agent run in between: through gates and action
// stages, which leave the activity's last session as it was. Breadth-first over the flow, each stage once, so a loop ends
function passedOn(stages: readonly Stage[], transitions: readonly Transition[], from: string): Transition[] {
  const seen = new Set([from]);
  const queue = [from];
  const out: Transition[] = [];
  for (let at = queue.shift(); at !== undefined; at = queue.shift()) {
    for (const transition of transitions.filter((t) => t.from === at)) {
      const to = stages.find((s) => s.name === transition.to);
      if (to === undefined) continue;
      if (runsAgent(to)) out.push(transition);
      else if (!seen.has(to.name)) { seen.add(to.name); queue.push(to.name); }
    }
  }
  return out;
}

const clearedResume = (i: number, stage: string): never =>
  fail(`comb.transitions[${i}].session`, `resumes the session of "${stage}", which clears it when it ends (#494)`);

/** #494: a resume of a session a stage clears as it ends is refused: it would find nothing and start a new session without a word. Two ways
 * reach it: a transition whose resumedStage is the clearing stage, and a plain or previous move out of a stage that runs no agent, reached
 * from the clearing stage through such stages only, since the cleared session was the task's last there. A destination that runs no agent
 * resumes nothing, as in checkResumedAgents. */
export function checkClearedResumes(stages: readonly Stage[], transitions: readonly Transition[]): void {
  const clears = (name: string | undefined) => stages.find((s) => s.name === name)?.clearSession === true;
  transitions.forEach((transition, i) => {
    const to = stages.find((s) => s.name === transition.to);
    const resumed = to === undefined || !runsAgent(to) ? undefined : resumedStage(transition, to);
    if (resumed !== undefined && clears(resumed)) clearedResume(i, resumed);
  });
  stages.filter((s) => s.clearSession === true).forEach((clearing) => {
    passedOn(stages, transitions, clearing.name).forEach((transition) => {
      const to = stages.find((s) => s.name === transition.to);
      if (transition.from !== clearing.name && to !== undefined && resumedStage(transition, to) === transition.from) {
        clearedResume(transitions.indexOf(transition), clearing.name);
      }
    });
  });
}
