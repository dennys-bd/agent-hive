// The tools the Hive's config may turn off (#333): hive_create_task, hive_remember, hive_recall, hive_revise, hive_forget (#683), hive_task, and the benchmark's three (#478). Registered per request, only those mcp.off leaves on.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { localWorkspaceOf, taskOfWorker } from './activities.js';
import { taskWorkspace, workspaceByName } from './config.js';
import { createTask } from './create-task.js';
import { correlationOf } from './fact-derive.js';
import type { Correlation } from './facts.js';
import { forgetRefusal, isMemoryRefusal, lessonRefusal, memoryCounts, recalledOf, revisionRefusal, unknownMemoryMessage, withEntry, withForgotten, withRevision, withUse } from './memory.js';
import { registerBenchmarkDraftTool, registerBenchmarkGetTool, registerBenchmarkListTool } from './mcp-benchmark.js';
import { livePtyId, type McpDeps, recorded, refuse, reply, UNKNOWN_WORKER_MESSAGE } from './mcp-kit.js';
import { readTaskAnswer } from './mcp-task.js';
import { MEMORY_KINDS, type MemoryOrigin, type MemoryUse, OPTIONAL_TOOLS, type OptionalTool } from './types.js';

// hive_create_task: a new local task in the Comb (#132).
function registerCreateTaskTool(server: McpServer, deps: McpDeps, header: string | undefined): void {
  server.registerTool('hive_create_task', {
    description: 'Create a task in the Hive. Without stage the task is created outside the flow, in hive only. Optional workspace: a Comb workspace name, for a task created in hive. '
      + "Optional source: where the task is created; defaults to the Hive's setting. Answers the new task id, or a notice when the source's filter leaves it out of the flow.",
    inputSchema: { title: z.string(), body: z.string().optional(), stage: z.string().optional(), workspace: z.string().optional(), source: z.string().optional() },
  }, async ({ title, body, stage, workspace, source }) => recorded(deps, header, 'hive_create_task', async () => {
    const current = deps.live();
    if (!livePtyId(deps, header) || !current) return refuse('unknown_worker', UNKNOWN_WORKER_MESSAGE);
    const { state, config, sources } = current;
    const request = { title, body, ...(stage === undefined ? {} : { stage }), ...(workspace === undefined ? {} : { workspace }), ...(source === undefined ? {} : { source }) };
    // POST /tasks' own resolution (#846): the two cannot drift
    const created = await createTask({ state, config, sources, dispatch: deps.dispatch, poll: deps.poll, latest: () => deps.live()?.state }, request);
    if ('status' in created) return refuse('event', created.message);
    return reply('notice' in created ? created.notice : created.id);
  }));
}

/** Who saves, reads, revises or forgets a lesson (#797, #681, #683): the workspace the worker's task resolves to, or its local activity's (#256); the lesson's origin (the
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

export const REMEMBER_DESCRIPTION = 'Save a lesson to this workspace\'s memory, which the Hive gives every later run in this workspace. kind: "pref" (how the user wants things done, often learned from a correction), "fact" (a fact about this repository a later task needs) or "avoid" (something that fails or must not be done here). description: one line of at most 150 characters naming what the lesson is about, short and direct (e.g. "Portuguese copy for a run or a command"), never the lesson itself. body: up to 4,000 characters holding the lesson, why it holds and how to apply it; line breaks are kept. Never save details of this task only, what the repository already records (its agent instructions, the code, git history), or anything a token or a secret could be in.';
export const RECALL_DESCRIPTION = 'Read a lesson of this workspace\'s memory: pass its id (m-<n>, as the memory section lists it). Answers JSON with its kind, description and body. Call it before working on what a lesson\'s description touches; the description only names the subject, the body holds the lesson.';

// hive_remember (#797): a lesson for every later run in the workspace. Its records name its kind and id, never its description or body
export function registerRememberTool(server: McpServer, deps: McpDeps, header: string | undefined): void {
  server.registerTool('hive_remember', {
    description: REMEMBER_DESCRIPTION,
    inputSchema: { kind: z.enum(MEMORY_KINDS), description: z.string(), body: z.string() },
  }, async ({ kind, description, body }) => recorded(deps, header, 'hive_remember', async () => {
    const caller = memoryCaller(deps, header);
    if (!caller) return refuse('unknown_worker', UNKNOWN_WORKER_MESSAGE);
    const refused = lessonRefusal(description, body);
    if (refused) return refuse(refused.code, refused.message);
    const saved = await deps.memory.update(caller.workspace, (file) => withEntry(file, kind, description, body, caller.origin, new Date().toISOString(), caller.cap));
    if (isMemoryRefusal(saved)) return refuse(saved.code, saved.message);
    const id = `m-${saved.nextId - 1}`; // withEntry's: the counter it just moved on
    deps.facts.write({ event: 'memory.changed', level: 'info', ...caller.correlation, action: 'added', kind, by: 'worker', id, workspace: caller.workspace, ...memoryCounts(saved) });
    return reply(`saved as ${id}`);
  }, { kind }));
}

// hive_recall (#681): a run reads a lesson, and the read is the lesson's use. Its records name the id and kind, never the description or body
export function registerRecallTool(server: McpServer, deps: McpDeps, header: string | undefined): void {
  server.registerTool('hive_recall', { description: RECALL_DESCRIPTION, inputSchema: { id: z.string() } }, async ({ id }) => recorded(deps, header, 'hive_recall', async () => {
    const caller = memoryCaller(deps, header);
    if (!caller) return refuse('unknown_worker', UNKNOWN_WORKER_MESSAGE);
    const lastUsed: MemoryUse = { at: new Date().toISOString(), ...(caller.origin === 'local' ? {} : caller.origin) }; // #256: a local session's names no task
    const saved = await deps.memory.update(caller.workspace, (file) => withUse(file, id, lastUsed));
    if (isMemoryRefusal(saved)) return refuse(saved.code, saved.message);
    const lesson = saved.entries.find((e) => e.id === id); // withUse found it; the find narrows it for the answer
    if (!lesson) return refuse('unknown_memory', unknownMemoryMessage(id));
    deps.facts.write({ event: 'memory.recalled', level: 'info', ...caller.correlation, id, kind: lesson.kind, uses: lesson.uses, workspace: caller.workspace });
    return reply(JSON.stringify(recalledOf(lesson)));
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

export const REVISE_DESCRIPTION = 'Correct a lesson of this workspace\'s memory that proved wrong or outdated: pass its id (m-<n>, as the memory section lists it), why (one line of at most 150 characters saying what made it wrong) and at least one of kind, description and body; only the fields given change. description: one line of at most 150 characters naming what the lesson is about, short and direct (e.g. "Portuguese copy for a run or a command"), never the lesson itself. body: up to 4,000 characters holding the lesson, why it holds and how to apply it; line breaks are kept. Never put a token or a secret in any field. The lesson as it was goes to the memory\'s history, where the user can restore it.';
export const FORGET_DESCRIPTION = 'Remove a lesson of this workspace\'s memory that proved wrong or no longer holds: pass its id (m-<n>, as the memory section lists it) and why (one line of at most 150 characters). The lesson goes to the memory\'s history, where the user can restore it.';

// hive_revise (#683): a run corrects a lesson; the lesson as it was goes to the history. Its records name the id and the kind, never a text or the why
export function registerReviseTool(server: McpServer, deps: McpDeps, header: string | undefined): void {
  server.registerTool('hive_revise', {
    description: REVISE_DESCRIPTION,
    inputSchema: { id: z.string(), kind: z.enum(MEMORY_KINDS).optional(), description: z.string().optional(), body: z.string().optional(), why: z.string() },
  }, async ({ id, kind, description, body, why }) => recorded(deps, header, 'hive_revise', async () => {
    const caller = memoryCaller(deps, header);
    if (!caller) return refuse('unknown_worker', UNKNOWN_WORKER_MESSAGE);
    const fields = { kind, description, body };
    const refused = revisionRefusal(fields, why);
    if (refused) return refuse(refused.code, refused.message);
    const saved = await deps.memory.update(caller.workspace, (file) => withRevision(file, id, fields, { by: caller.origin, why }, new Date().toISOString(), caller.cap));
    if (isMemoryRefusal(saved)) return refuse(saved.code, saved.message);
    const lesson = saved.entries.find((e) => e.id === id); // withRevision found it; the find narrows it for the fact
    if (!lesson) return refuse('unknown_memory', unknownMemoryMessage(id));
    deps.facts.write({ event: 'memory.changed', level: 'info', ...caller.correlation, action: 'edited', kind: lesson.kind, by: 'worker', id, workspace: caller.workspace, ...memoryCounts(saved) });
    return reply(`revised ${id}`);
  }, { kind }));
}

// hive_forget (#683): a run removes a lesson; it goes whole to the history. Its records name the id and the kind, never a text or the why
export function registerForgetTool(server: McpServer, deps: McpDeps, header: string | undefined): void {
  server.registerTool('hive_forget', { description: FORGET_DESCRIPTION, inputSchema: { id: z.string(), why: z.string() } }, async ({ id, why }) => recorded(deps, header, 'hive_forget', async () => {
    const caller = memoryCaller(deps, header);
    if (!caller) return refuse('unknown_worker', UNKNOWN_WORKER_MESSAGE);
    const refused = forgetRefusal(why);
    if (refused) return refuse(refused.code, refused.message);
    const saved = await deps.memory.update(caller.workspace, (file) => withForgotten(file, id, { by: caller.origin, why }, new Date().toISOString()));
    if (isMemoryRefusal(saved)) return refuse(saved.code, saved.message);
    const change = saved.history.at(-1); // withForgotten's: the change it just added, the newest one
    if (!change) return refuse('unknown_memory', unknownMemoryMessage(id));
    deps.facts.write({ event: 'memory.changed', level: 'info', ...caller.correlation, action: 'removed', kind: change.entry.kind, by: 'worker', id, workspace: caller.workspace, ...memoryCounts(saved) });
    return reply(`removed ${id}`);
  }));
}

const REGISTER: Record<OptionalTool, Register> = {
  hive_remember: registerRememberTool, hive_recall: registerRecallTool, hive_revise: registerReviseTool, hive_forget: registerForgetTool, hive_create_task: registerCreateTaskTool, hive_task: registerTaskTool,
  benchmark_list: registerBenchmarkListTool, benchmark_get: registerBenchmarkGetTool, benchmark_draft: registerBenchmarkDraftTool, // #478
};

/** The optional tools the Hive's config leaves on (#333): a tool in `off` is never registered, so tools/list lacks it and a call gets the SDK's unknown-tool answer. */
export function registerOptionalTools(server: McpServer, deps: McpDeps, header: string | undefined, off: readonly OptionalTool[]): void {
  for (const name of OPTIONAL_TOOLS) if (!off.includes(name)) REGISTER[name](server, deps, header);
}
