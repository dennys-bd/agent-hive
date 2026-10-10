// The Hive's protocol (#167): what a session is told about the Hive's MCP tools. It is handed to the agent at launch, through the agent's
// protocol flag (AgentSpec.protocolFlag), instead of riding at the end of every prompt: a stage prompt describes the work and nothing else.
// Agent-neutral: the tools are the same MCP tools whatever agent runs the session; only the flag differs.

const FROM_THE_HIVE = 'This text comes from the Hive, the app that runs this session. Its tools `hive_done`, `hive_ask` and `hive_stop` report to it.';

const RESULT_LINE =
  'If the work produced something later stages need (a spec path, a plan path…), pass it to `hive_done` as `result`, e.g. `{ "spec": "docs/hive/specs/x-design.md" }`.';

// #367 / #417: a question asked in chat alone while background work runs keeps the task green until that work ends, forever if it never does
const askLines = (end: string): string[] => [
  `Every question for the user goes through \`hive_ask\`: call it with the question, ask it in chat and end your turn${end}.`,
  'Do this also while a subagent, a background shell or a scheduled job (cron) is still running: never ask in chat alone, or the Hive keeps showing this session as working until that work ends.',
];

const STOP_RULES =
  'with `reason` "wontDo" (or "duplicate", plus `duplicateOf`: the original issue number) the Hive closes the issue; without `reason` the task only stops. Never close the issue yourself.';

// #797: what makes the workspace's memory grow. hive_applied is told in the memory section itself, which exists only once a lesson does
const REMEMBER_LINE = 'When the user corrects you, or you learn a fact about this repository that a later task would need, call `hive_remember` with it.';

// #803: how to walk back from a line to its reason; no tool, since git and gh already answer each step
const WHY_LINE =
  'To learn why code is the way it is, follow it back: `git blame` or `git log` on the lines, the PR the commit names (`gh pr view`), the issue it closes and the spec or plan it links.';

// #803: a risky attempt stays cheap to throw away
const UNDO_LINE =
  'Before a large or risky change, commit the work that passes, so the attempt can be thrown away with git; try an experiment you may discard in a separate worktree.';

/** A stage run's protocol (a spawn, Continue, feedback): the session ends the stage itself. */
export const STAGE_PROTOCOL = [
  FROM_THE_HIVE,
  '',
  'When this command is completely finished (nothing left to do, no subagent or background task still running, no answer pending from the user), call the `hive_done` tool and end your turn. Never call it earlier.',
  RESULT_LINE,
  ...askLines(' without `hive_done`'),
  `If the task will not be done, call \`hive_stop\` instead of \`hive_done\`: ${STOP_RULES}`,
  REMEMBER_LINE,
  WHY_LINE,
  UNDO_LINE,
  '',
].join('\n');

/** A free session's protocol, on a task (#164, #283): hive_done moves the task on at once there, so ending the stage is the user's call. */
export const SESSION_PROTOCOL = [
  FROM_THE_HIVE,
  '',
  "The user drives this session. When you believe the task's work is finished, say so in chat and suggest moving the task to its next stage.",
  'Call `hive_done` only when the user confirms or asks for it: it moves the task to its next stage at once.',
  RESULT_LINE,
  ...askLines(''),
  `Call \`hive_stop\` only when the user asks for it: ${STOP_RULES}`,
  REMEMBER_LINE,
  WHY_LINE,
  UNDO_LINE,
  '',
].join('\n');
