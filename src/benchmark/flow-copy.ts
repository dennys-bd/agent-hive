import { resolveCommand } from '../run-commands.js';
import { runsAgent } from '../stage-agent.js';
import type { BenchFlow, BenchStage, BenchTransition, Config, Stage, StageOverride, Transition } from '../types.js';
import { STAGE_OVERRIDE_FIELDS } from './arms.js';
import { canonicalJson } from './canonical.js';
import { STAGE_NAME, STAGE_OVERRIDE } from './schemas.js';
import { DONE_STAGE } from './watcher.js';

export type FlowCopy = { flow: BenchFlow } | { refused: string };
type Comb = Pick<Config, 'comb' | 'defaultAgent'>;

const isFilled = (record: object | undefined): boolean => record !== undefined && Object.keys(record).length > 0;

// A run's local origin has no CI, and DONE_STAGE is where the run holds finished tasks
function refusal(stages: readonly Stage[]): string | undefined {
  if (stages.length === 0) return 'the flow has no stage';
  const waits = stages.find((s) => s.action === 'waitForCi');
  if (waits !== undefined) return `stage ${waits.name} waits for CI, and a run's local origin has none`;
  if (stages.some((s) => s.name === DONE_STAGE)) return `a stage is named ${DONE_STAGE}, the stage a run holds its finished tasks in`;
  const unnamed = stages.find((s) => !STAGE_NAME.safeParse(s.name).success);
  return unnamed === undefined ? undefined : `a stage is named ${unnamed.name}, a name an arm cannot override`;
}

// from/onStart talk to a source the run does not have. after is dropped too: a delayed deleteActivity ("Done · 5d") would hold every run
// until its timeout, and so is maxWorkers: 0, which would pause the run for as long. The agent is frozen here so a later change of the default agent in Settings cannot change the experiment.
function benchStage(stage: Stage, defaultAgent: Config['defaultAgent']): { stage: BenchStage; dropped: string[] } {
  const { from, onStart, after, maxWorkers, ...kept } = stage;
  const dropped = [isFilled(from) ? `${stage.name}.from` : '', isFilled(onStart) ? `${stage.name}.onStart` : '', after === undefined ? '' : `${stage.name}.after`, maxWorkers === undefined ? '' : `${stage.name}.maxWorkers`].filter((d) => d !== '');
  return { stage: runsAgent(kept) ? { ...kept, agent: kept.agent ?? defaultAgent } : kept, dropped };
}

function benchTransition(transition: Transition): { transition: BenchTransition; dropped: string[] } {
  const { sources, ...kept } = transition;
  return { transition: kept, dropped: isFilled(sources) ? [`${transition.from} → ${transition.to}.sources`] : [] };
}

// Only { name, line }: a command's env may hold a token, and the timeout means nothing to a run's one-shot stage
function commandLines(stages: readonly Stage[], commands: Config['comb']['commands'], workspace: string): { lines: { name: string; line: string }[] } | { refused: string } {
  const lines: { name: string; line: string }[] = [];
  for (const stage of stages) {
    for (const name of stage.action === 'commands' ? stage.commands ?? [] : []) {
      if (lines.some((l) => l.name === name)) continue;
      const found = commands.find((c) => c.name === name);
      const line = found === undefined ? undefined : resolveCommand(found, workspace);
      if (line === undefined) return { refused: `stage ${stage.name} runs ${name}, which has no line in workspace ${workspace}` };
      lines.push({ name, line });
    }
  }
  return { lines };
}

/** The workspace's flow as an experiment's base keeps it (#536), or the reason the Hive cannot run it. */
export function copyFlow(config: Comb, workspace: string, now: Date): FlowCopy {
  const { stages, transitions, commands } = config.comb;
  const refused = refusal(stages);
  if (refused !== undefined) return { refused };
  const resolved = commandLines(stages, commands, workspace);
  if ('refused' in resolved) return resolved;
  const copiedStages = stages.map((s) => benchStage(s, config.defaultAgent));
  const copiedTransitions = transitions.map(benchTransition);
  return {
    flow: {
      copiedAt: now.toISOString(), stages: copiedStages.map((c) => c.stage), transitions: copiedTransitions.map((c) => c.transition), commands: resolved.lines,
      dropped: [...copiedStages, ...copiedTransitions].flatMap((c) => c.dropped),
    },
  };
}

// The flow with every editable field taken out: what must stay as the copy made it
const frame = (flow: BenchFlow): string =>
  canonicalJson({ ...flow, stages: flow.stages.map((s) => Object.fromEntries(Object.entries(s).filter(([k]) => !(STAGE_OVERRIDE_FIELDS as readonly string[]).includes(k)))) });

// Which stages a field means something on: the agent's fields on a stage that runs an agent, the rest on their own action
const FITS: Record<keyof StageOverride, (stage: BenchStage) => boolean> = {
  agent: runsAgent, model: runsAgent, prompt: runsAgent, skill: (s) => s.action === 'skill', commands: (s) => s.action === 'commands',
  judge: (s) => s.action === 'evaluate', threshold: (s) => s.action === 'evaluate',
};
const misfits = (stage: BenchStage, fields: StageOverride, label: string): string[] =>
  (Object.keys(fields) as (keyof StageOverride)[]).filter((k) => !FITS[k](stage)).map((k) => `${label}: ${k} does not fit a stage that ${stage.action ?? 'runs a prompt'}`);

function fieldIssues(stage: BenchStage, commands: readonly { name: string }[]): string[] {
  const editable = Object.fromEntries(Object.entries(stage).filter(([k]) => (STAGE_OVERRIDE_FIELDS as readonly string[]).includes(k)));
  const parsed = STAGE_OVERRIDE.safeParse(editable);
  const issues = parsed.success ? [] : parsed.error.issues.map((i) => `base.flow.${stage.name}: ${i.path.join('.')} ${i.message}`);
  // a base has a model or none: null (the agent's default) only means something on an arm
  const nullModel = editable.model === null ? [`base.flow.${stage.name}: model cannot be null on a base`] : [];
  const missing = (stage.commands ?? []).filter((c) => !commands.some((l) => l.name === c)).map((c) => `base.flow.${stage.name}: no line for command ${c}`);
  return [...issues, ...nullModel, ...missing, ...misfits(stage, editable, `base.flow.${stage.name}`)];
}

/** What an arm's stage overrides may not do (#536), against the flow they apply to: name a stage the flow lacks, a command it has no line
 *  for, or a field the stage's action does not take. Shared by the arm route and benchmark_draft. */
export function overrideIssues(flow: BenchFlow, stages: Record<string, StageOverride>): string[] {
  return Object.entries(stages).flatMap(([name, fields]) => {
    const stage = flow.stages.find((s) => s.name === name);
    if (stage === undefined) return [`stage ${name}: no such stage in the flow`];
    const missing = (fields.commands ?? []).filter((c) => !flow.commands.some((l) => l.name === c)).map((c) => `stage ${name}: no line for command ${c}`);
    return [...misfits(stage, fields, `stage ${name}`), ...missing];
  });
}

/** What a patched base's flow may not do (#536): change the copy's structure (every field but STAGE_OVERRIDE_FIELDS, the stage order, the
 *  transitions, the commands, copiedAt, dropped), give an editable field a bad value, or name a command the copy has no line for. */
export function flowIssues(copy: BenchFlow, next: BenchFlow): string[] {
  if (frame(copy) !== frame(next)) return ['base.flow: the flow is the copy the experiment was created with; change its structure in Settings and create another experiment'];
  return next.stages.flatMap((s) => fieldIssues(s, next.commands));
}
