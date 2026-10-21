import type { Stage, StageAction } from './types.js';

// What a stage runs (#710): one definition of "a stage that runs an agent" and of the prompt its agent is told, so no reader forgets the skill
// stage. Node-free: the page reads it too.

/** A Hive skill's name as a skill stage holds it (#710): one folder under the plugin's skills/, the shape codex-home's AGENT_NAME admits. */
export const SKILL_NAME = /^[a-z0-9-]+$/;

/** The actions the Hive runs itself, with no agent (#573, #755, #834): every one but skill. */
export type HiveAction = Exclude<StageAction, 'skill'>;

type StageRun = Pick<Stage, 'action' | 'prompt' | 'skill'>;

/** What a stage's agent is told (#710, decisions 2 and 4): a prompt stage's prompt; /hive:<skill> on a skill stage, for Claude and Codex
 * alike (the plugin's name is codex-home's CODEX_PLUGIN, which the page cannot import); nothing on a gate, a show-only stage or a Hive action. */
export function agentPrompt(stage: StageRun): string | undefined {
  if (stage.action === 'skill') return stage.skill === undefined ? undefined : `/hive:${stage.skill}`;
  return stage.action === undefined ? stage.prompt : undefined;
}

/** Whether a stage spawns an agent (#710): a prompt stage or a skill stage. */
export const runsAgent = (stage: StageRun): boolean => agentPrompt(stage) !== undefined;

/** The stage's action when the Hive runs it itself (#710): undefined on a prompt, a skill, a gate, a show-only stage and no stage. */
export const hiveAction = (stage: Pick<Stage, 'action'> | undefined): HiveAction | undefined => (stage?.action === 'skill' ? undefined : stage?.action);

// A slash command opening a prompt: `/` then a command name (`build`, `hive:new-plan`), never a path such as docs/x.md
const COMMAND_LINE = /^\/[\w:-]+(?:[ \t].*)?$/;

/** A prompt that opens on a slash command, split into that line and the rest (#710). Claude runs a command only at the start of the message,
 * so whatever a composer adds (a transition's text, a handoff) goes after the command line, never before it. Undefined for any other prompt. */
export function commandFirst(prompt: string): { command: string; rest: string } | undefined {
  const text = prompt.trimStart();
  const end = text.indexOf('\n');
  const command = end === -1 ? text : text.slice(0, end);
  return COMMAND_LINE.test(command) ? { command: command.trimEnd(), rest: end === -1 ? '' : text.slice(end + 1).trim() } : undefined;
}
