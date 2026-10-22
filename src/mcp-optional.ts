// The tools the Hive's config may turn off (#333): hive_create_task, hive_remember, hive_applied, hive_task, and the benchmark's three (#478). Registered per request, only those mcp.off leaves on.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { localWorkspaceOf, taskOfWorker } from './activities.js';
import { taskWorkspace, workspaceByName } from './config.js';
import { createTask } from './create-task.js';
import { correlationOf } from './fact-derive.js';
import type { Correlation } from './facts.js';
import { isMemoryRefusal, lessonRefusal, looksLikeSecret, MEMORY_SECRET_MESSAGE, memoryCounts, whyProblem, withEntry, withUse } from './memory.js';
import { registerBenchmarkDraftTool, registerBenchmarkGetTool, registerBenchmarkListTool } from './mcp-benchmark.js';
import { livePtyId, type McpDeps, OK, recorded, refuse, reply, UNKNOWN_WORKER_MESSAGE } from './mcp-kit.js';
import { readTaskAnswer } from './mcp-task.js';
import { MEMORY_KINDS, type MemoryOrigin, type MemoryUse, OPTIONAL_TOOLS, type OptionalTool } from './types.js';

// hive_create_task: a new local task in the Comb (#132).
function registerCreateTaskTool(server: McpServer, deps: McpDeps, header: string | undefined): void {
  server.registerTool('hive_create_task', {
    description: 'Create a task in the Hive. stage defaults to the first stage. Optional workspace: a Comb workspace name, for a task created in hive. '
      + "Optional source: where the task is created; defaults to the Hive's setting. Answers the new task id, or a notice when the source's filter leaves it out of the flow.",
    inputSchema: { title: z.string(), body: z.string().optional(), stage: z.string().optional(), workspace: z.string().optional(), source: z.string().optional() },
  }, async ({ title, body, stage, workspace, source }) => recorded(deps, header, 'hive_create_task', async () => {
    const current = deps.live();
    if (!livePtyId(deps, header) || !current) return refuse('unknown_worker', UNKNOWN_WORKER_MESSAGE);
    const { state, config, sources } = current;
    const request = { title, body, stage: stage ?? state.stages[0]?.name, ...(workspace === undefined ? {} : { workspace }), ...(source === undefined ? {} : { source }) };
    // POST /tasks' own resolution (#846): the two cannot drift
    const created = await createTask({ state, config, sources, dispatch: deps.dispatch, poll: deps.poll, latest: () => deps.live()?.state }, request);
    if ('status' in created) return refuse('event', created.message);
    return reply('notice' in created ? created.notice : created.id);
  }));
}

/** Who saves or cites a lesson (#797): the workspace the worker's task resolves to, or its local activity's (#256); the lesson's origin (the
 * stage only for a stage run, 'local' for a local session) and the ids its records join by. */
export interface MemoryCaller { workspace: string; cap: number; origin: Exclude<MemoryOrigin, 'user'>; correlation: Correlation }

// None for an unknown worker, a task whose workspace no longer resolves or a local activity whose workspace a save removed: the tools answer
// unknown_worker
export function memoryCaller(deps: McpDeps, header: string | undefined): MemoryCaller | undefined {
  const ptyId = livePtyId(deps, header);
  const current = deps.live();
  const worker = ptyId === undefined ? undefined : current?.state.workers.find((s) => s.runId === ptyId);
  if (!current || !worker) return undefined;
  const correlation = correlationOf(current.state, worker);
  const task = taskOfWorker(current.state, worker);
  if (!task) {
    // #256: a local session's lessons are its activity's workspace's, under that workspace's cap
    const local = workspaceByName(current.config, localWorkspaceOf(worker.activityId ?? ''));
    return local ? { workspace: local.name, cap: local.memoryCap, origin: 'local', correlation } : undefined;
  }
  const workspace = taskWorkspace(current.config, task);
  if (!workspace) return undefined;
  const stage = worker.freeSession ? {} : { stage: task.stage };
  return { workspace: workspace.name, cap: workspace.memoryCap, origin: { task: task.item.id, ...stage }, correlation };
}

export const REMEMBER_DESCRIPTION = 'Save a lesson to this workspace\'s memory, which the Hive gives every later run in this workspace. kind: "pref" (how the user wants things done, often learned from a correction), "fact" (a fact about this repository a later task needs) or "avoid" (something that fails or must not be done here). text: one line, at most 300 characters. Never save details of this task only, what the repository already records (its agent instructions, the code, git history), or anything a token or a secret could be in.';
export const APPLIED_DESCRIPTION = 'Tell the Hive a lesson of this workspace\'s memory changed what you did: pass its id (m-<n>, as the memory shows it) and why, in one line. Call it each time a lesson makes you act differently, not for lessons you only read.';

// hive_remember (#797): a lesson for every later run in the workspace. Its records name its kind and id, never its text
export function registerRememberTool(server: McpServer, deps: McpDeps, header: string | undefined): void {
  server.registerTool('hive_remember', {
    description: REMEMBER_DESCRIPTION,
    inputSchema: { kind: z.enum(MEMORY_KINDS), text: z.string() },
  }, async ({ kind, text }) => recorded(deps, header, 'hive_remember', async () => {
    const caller = memoryCaller(deps, header);
    if (!caller) return refuse('unknown_worker', UNKNOWN_WORKER_MESSAGE);
    const refused = lessonRefusal(text);
    if (refused) return refuse(refused.code, refused.message);
    const saved = await deps.memory.update(caller.workspace, (file) => withEntry(file, kind, text, caller.origin, new Date().toISOString(), caller.cap));
    if (isMemoryRefusal(saved)) return refuse(saved.code, saved.message);
    const id = `m-${saved.nextId - 1}`; // withEntry's: the counter it just moved on
    deps.facts.write({ event: 'memory.changed', level: 'info', ...caller.correlation, action: 'added', kind, by: 'worker', id, workspace: caller.workspace, ...memoryCounts(saved) });
    return reply(`saved as ${id}`);
  }, { kind }));
}

// hive_applied (#797): the run cites a lesson that changed what it did. A citation is counted on the lesson, never rendered
export function registerAppliedTool(server: McpServer, deps: McpDeps, header: string | undefined): void {
  server.registerTool('hive_applied', {
    description: APPLIED_DESCRIPTION,
    inputSchema: { id: z.string(), why: z.string() },
  }, async ({ id, why }) => recorded(deps, header, 'hive_applied', async () => {
    const caller = memoryCaller(deps, header);
    if (!caller) return refuse('unknown_worker', UNKNOWN_WORKER_MESSAGE);
    const problem = whyProblem(why);
    if (problem) return refuse('bad_memory', problem);
    if (looksLikeSecret(why)) return refuse('memory_secret', MEMORY_SECRET_MESSAGE);
    const lastUsed: MemoryUse = { at: new Date().toISOString(), ...(caller.origin === 'local' ? {} : caller.origin), why: why.trim() }; // #256: a local session's names no task
    const saved = await deps.memory.update(caller.workspace, (file) => withUse(file, id, lastUsed));
    if (isMemoryRefusal(saved)) return refuse(saved.code, saved.message);
    const lesson = saved.entries.find((e) => e.id === id);
    if (lesson) deps.facts.write({ event: 'memory.applied', level: 'info', ...caller.correlation, id, kind: lesson.kind, uses: lesson.uses, workspace: caller.workspace });
    return reply(OK);
  }));
}

type Register = (server: McpServer, deps: McpDeps, header: string | undefined) => void;
export const TASK_DESCRIPTION = 'Read the task this session works on, as the Hive holds it: id, itemId, title, body, url, source (absent on a task created in the Hive), workspace, repository (the workspace\'s GitHub origin, owner/name), stage, result (what earlier stages passed to hive_done, merged), parent and children (each with title and stage when the Hive holds it, closed: true on a child closed on its source), blockers (blockedBy and blocking, with stage when the blocker is a task of the Hive) and comments (the source\'s first 100, oldest first; commentsError when the source failed). task is null in a session with no task. Answers a JSON object.';

// hive_task (#7): the worker's own task. A session with no task (#256) gets task: null, never an error; only an unknown worker is refused
function registerTaskTool(server: McpServer, deps: McpDeps, header: string | undefined): void {
  server.registerTool('hive_task', { description: TASK_DESCRIPTION, inputSchema: {} }, async () => recorded(deps, header, 'hive_task', async () => {
    const ptyId = livePtyId(deps, header);
    const current = deps.live();
    const worker = ptyId === undefined ? undefined : current?.state.workers.find((s) => s.runId === ptyId);
    if (!current || !worker) return refuse('unknown_worker', UNKNOWN_WORKER_MESSAGE);
    return reply(JSON.stringify(await readTaskAnswer(deps.exec, current, worker)));
  }));
}

const REGISTER: Record<OptionalTool, Register> = {
  hive_remember: registerRememberTool, hive_applied: registerAppliedTool, hive_create_task: registerCreateTaskTool, hive_task: registerTaskTool,
  benchmark_list: registerBenchmarkListTool, benchmark_get: registerBenchmarkGetTool, benchmark_draft: registerBenchmarkDraftTool, // #478
};

/** The optional tools the Hive's config leaves on (#333): a tool in `off` is never registered, so tools/list lacks it and a call gets the SDK's unknown-tool answer. */
export function registerOptionalTools(server: McpServer, deps: McpDeps, header: string | undefined, off: readonly OptionalTool[]): void {
  for (const name of OPTIONAL_TOOLS) if (!off.includes(name)) REGISTER[name](server, deps, header);
}
