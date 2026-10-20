// The Hive's protocol (#167): what a session is told about the Hive's MCP tools. It is handed to the agent at launch, through the agent's
// runner and its protocol flag (src/agents/claude.ts), instead of riding at the end of every prompt: a stage prompt describes the work and nothing else.
// Agent-neutral: the tools are the same MCP tools whatever agent runs the session; only the flag differs.
import type { RenderedPassage } from './protocol-inserts.js';
import type { OptionalTool } from './types.js';

const FROM_THE_HIVE = 'This text comes from the Hive, the app that runs this session. Its tools `hive_done`, `hive_ask` and `hive_stop` report to it.';

const RESULT_LINE =
  'If the work produced something later stages need (a spec path, a plan path…), pass it to `hive_done` as `result`, e.g. `{ "spec": "docs/hive/specs/x-design.md" }`.';

// #367 / #417: a question asked in chat alone while background work runs keeps the task green until that work ends, forever if it never does
const askLines = (end: string): string[] => [
  `Every question for the user goes through \`hive_ask\`: call it with the question, ask it in chat and end your turn${end}.`,
  'Do this also while a subagent, a background shell or a scheduled job (cron) is still running: never ask in chat alone, or the Hive keeps showing this session as working until that work ends.',
];

const STOP_RULES =
  'with `reason` "wontDo" (or "duplicate", plus `duplicateOf`: the original issue number) the Hive closes the issue; without `reason` the task only stops. Never close the issue yourself.'
  + ' When the task cannot go on until another issue is done, call `hive_stop` with `block` (that issue\'s number) instead: the Hive records the blocker and starts the task again once it closes.';

// #797: what makes the workspace's memory grow. hive_applied is told in the memory section itself, which exists only once a lesson does
const REMEMBER_LINE = 'When the user corrects you, or you learn a fact about this repository that a later task would need, call `hive_remember` with it.';

// #803: how to walk back from a line to its reason; no tool, since git and gh already answer each step
const WHY_LINE =
  'To learn why code is the way it is, follow it back: `git blame` or `git log` on the lines, the PR the commit names (`gh pr view`), the issue it closes and the spec or plan it links.';

// #803: a risky attempt stays cheap to throw away
const UNDO_LINE =
  'Before a large or risky change, commit the work that passes, so the attempt can be thrown away with git; try an experiment you may discard in a separate worktree.';

// #336: one id per paragraph or rule of the text, the same in both kinds, so one anchor serves both files
export const PROTOCOL_BLOCKS = ['intro', 'done', 'result', 'ask', 'stop', 'remember', 'why', 'undo'] as const;
export type ProtocolBlockId = (typeof PROTOCOL_BLOCKS)[number];
export const PROTOCOL_KINDS = ['stage', 'session', 'local'] as const;
export type ProtocolKind = (typeof PROTOCOL_KINDS)[number];
export type ProtocolTexts = Record<ProtocolKind, string>;
/** What a workspace's runs are told above their memory section (#797), its passages rendered in (#336). */
export type ProtocolFor = (workspace: string, off: readonly OptionalTool[]) => Promise<ProtocolTexts>;
/** tool: the switch of mcp.off that drops the block (#333). local: what a session with no task is told (#256); none leaves the block out of that kind. */
export interface ProtocolBlock { id: ProtocolBlockId; stage: string; session: string; local?: string; tool?: OptionalTool }

const same = (text: string): Omit<ProtocolBlock, 'id'> => ({ stage: text, session: text });
// #256: a rule that holds with no task, so a local session is told it too
const everywhere = (text: string): Omit<ProtocolBlock, 'id'> => ({ ...same(text), local: text });
// #256: the intro names hive_done and hive_stop, which a local session does not have
const LOCAL_INTRO = 'This text comes from the Hive, the app that runs this session. This session runs in a workspace, with no task.';
// A Record, so a block id without its text fails tsc
const TEXTS: Record<ProtocolBlockId, Omit<ProtocolBlock, 'id'>> = {
  intro: { ...same(FROM_THE_HIVE), local: LOCAL_INTRO },
  done: {
    stage: 'When this command is completely finished (nothing left to do, no subagent or background task still running, no answer pending from the user), call the `hive_done` tool and end your turn. Never call it earlier.',
    session: [
      "The user drives this session. When you believe the task's work is finished, say so in chat and suggest moving the task to its next stage.",
      'Call `hive_done` only when the user confirms or asks for it: it moves the task to its next stage at once.',
    ].join('\n'),
  },
  result: same(RESULT_LINE), // no local: hive_done's
  ask: { stage: askLines(' without `hive_done`').join('\n'), session: askLines('').join('\n'), local: askLines('').join('\n') },
  stop: { stage: `If the task will not be done, call \`hive_stop\` instead of \`hive_done\`: ${STOP_RULES}`, session: `Call \`hive_stop\` only when the user asks for it: ${STOP_RULES}` },
  remember: { ...everywhere(REMEMBER_LINE), tool: 'hive_remember' }, // telling a session to call a tool it does not have is wrong
  why: everywhere(WHY_LINE),
  undo: everywhere(UNDO_LINE),
};
export const BLOCKS: readonly ProtocolBlock[] = PROTOCOL_BLOCKS.map((id) => ({ id, ...TEXTS[id] }));
export const isProtocolBlockId = (value: string): value is ProtocolBlockId => (PROTOCOL_BLOCKS as readonly string[]).includes(value);

// An empty render (its {% if %} does not hold) or a failed one adds nothing, not even a blank line
const shown = (passage: RenderedPassage): string[] => (passage.text === undefined || passage.text === '' ? [] : [passage.text]);

/** The protocol a run of `kind` is told (#336): each block the kind has and is not turned off, the passages anchored to it right after it, the orphans last.
 * A passage on a block that goes keeps its place: only the Hive's text goes. Pure. */
export function renderProtocol(kind: ProtocolKind, off: readonly OptionalTool[], passages: readonly RenderedPassage[]): string {
  const after = (id: ProtocolBlockId): string[] => passages.filter((p) => !p.orphan && p.after === id).flatMap(shown);
  // A block turned off (#336) or with no text for the kind (a task's rule in the local protocol, #256) goes; its passages stay
  const own = (block: ProtocolBlock): string[] => {
    const text = block[kind];
    return text === undefined || (block.tool !== undefined && off.includes(block.tool)) ? [] : [text];
  };
  const [intro, ...rest] = BLOCKS.map((block) => [...own(block), ...after(block.id)]);
  const tail = [...rest.flat(), ...passages.filter((p) => p.orphan).flatMap(shown)];
  return `${intro.join('\n')}\n\n${tail.join('\n')}\n`; // as today: a blank line after the intro, a trailing newline
}

export const protocolTexts = (off: readonly OptionalTool[], passages: readonly RenderedPassage[]): ProtocolTexts =>
  ({ stage: renderProtocol('stage', off, passages), session: renderProtocol('session', off, passages), local: renderProtocol('local', off, passages) });

/** A stage run's protocol (a spawn, Continue, feedback): the session ends the stage itself. */
export const STAGE_PROTOCOL = renderProtocol('stage', [], []);
/** A free session's protocol, on a task (#164, #283): hive_done moves the task on at once there, so ending the stage is the user's call. */
export const SESSION_PROTOCOL = renderProtocol('session', [], []);

/** A local session's protocol (#256): a run on a local activity, opened from "+" or captured in its terminal; no task, so no hive_done or hive_stop. */
export const LOCAL_PROTOCOL = renderProtocol('local', [], []);
