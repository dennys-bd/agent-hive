// The new session dialog's picks (#257) and what they make: the open's body and the summary's command line. No DOM.
import { AGENTS } from '../../agents.js';
import type { AgentId, LaunchPick } from '../../types.js';

/** The dialog's fields as the user left them: '' is the agent's default model, no specialized agent, no arguments. */
export interface SessionPicks { agent: AgentId; model: string; specializedAgent: string; args: string }

/** The arguments field as words, split on whitespace: a value never carries a space. */
export const splitArgs = (text: string): string[] => text.split(/\s+/).filter((word) => word !== '');

/** The open's picks (#257): only what differs from the defaults, so an untouched dialog posts the kind alone. */
export function launchOf({ model, specializedAgent, args }: SessionPicks): LaunchPick {
  const words = splitArgs(args);
  return { ...(model === '' ? {} : { model }), ...(specializedAgent === '' ? {} : { specializedAgent }), ...(words.length === 0 ? {} : { args: words }) };
}

// What each runner puts a pick behind (agents/claude.ts, agents/codex.ts), mirrored here: the page never imports a runner. Codex has no
// --agent: it gets the agent's text, so its line shows no flag
const MODEL_FLAG: Record<AgentId, string> = { claude: '--model', codex: '-m' };
const AGENT_FLAG: Partial<Record<AgentId, string>> = { claude: '--agent' };

/** The summary's runs line (#257): the command, the global args, the session's, then the agent's flag and the model's, in the runner's order. */
export function runsLine(picks: SessionPicks, globalArgs: readonly string[]): string {
  const { model, specializedAgent, args } = launchOf(picks);
  const agentFlag = AGENT_FLAG[picks.agent];
  return [
    AGENTS[picks.agent].command, ...globalArgs, ...(args ?? []),
    ...(specializedAgent === undefined || agentFlag === undefined ? [] : [agentFlag, specializedAgent]),
    ...(model === undefined ? [] : [MODEL_FLAG[picks.agent], model]),
  ].join(' ');
}
