import { resolveCommand } from '../run-commands.js';
import { runsAgent } from '../stage-agent.js';
import type { BenchFlow, BenchStage, BenchTransition, Config, Stage, Transition } from '../types.js';
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
  return undefined;
}

// from/onStart talk to a source the run does not have. after is dropped too: a delayed deleteActivity ("Done · 5d") would hold every run
// until its timeout. The agent is frozen here so a later change of the default agent in Settings cannot change the experiment.
function benchStage(stage: Stage, defaultAgent: Config['defaultAgent']): { stage: BenchStage; dropped: string[] } {
  const { from, onStart, after, ...kept } = stage;
  const dropped = [isFilled(from) ? `${stage.name}.from` : '', isFilled(onStart) ? `${stage.name}.onStart` : '', after === undefined ? '' : `${stage.name}.after`].filter((d) => d !== '');
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
