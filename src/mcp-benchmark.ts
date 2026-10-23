// The benchmark's MCP tools (#478, mcp.benchmark): read the experiments and save one as a draft. Nothing here runs, sleeps or evaluates an
// experiment; the draft's write is drafts.ts', through the routes' queue. Optional tools (#333): REGISTER in mcp-optional.ts holds them.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { liveDefaultAgent } from './agents.js';
import type { Drafter } from './benchmark/drafts.js';
import { livePtyId, type McpDeps, recorded, refuse, reply, UNKNOWN_WORKER_MESSAGE } from './mcp-kit.js';
import type { Experiment, State, Worker } from './types.js';

export type BenchmarkToolDeps = Pick<McpDeps, 'live' | 'facts'> & { benchmark: Drafter };

export const LIST_DESCRIPTION = 'List the benchmark experiments: id, name, status, workspace and archived, as JSON. It only reads: nothing runs.';
export const GET_DESCRIPTION = "Read one benchmark experiment's config by id, as JSON: name, status, workspace, base, arms (with their ids), seed, pace, isolation, blindness and evaluation. Its sections are the shapes benchmark_draft takes. It only reads: nothing runs.";
export const DRAFT_DESCRIPTION = 'Save a benchmark experiment as a draft. Nothing runs, sleeps or is evaluated. Without id, a new draft starts from `from` (a copy of that experiment) or from the empty experiment of `workspace`; with id, it replaces a draft that has no round. Give only the sections that change (name, base, arms, seed, pace, isolation, blindness, evaluation), each whole, in the shape benchmark_get answers. arms replaces the arm list in order, each { id?, name, overrides }: an id keeps that arm, none adds one. A seed entry upload:<name> must already be in the experiment. Answers { id } of the draft, or every problem as <path>: <message>, one per line.';

// Loose on purpose: the handler parses with DRAFT, so a shape error comes back as every issue in our lines, not as the SDK's error
const SECTION = 'in the shape benchmark_get answers';
const DRAFT_ARGS = z.looseObject({
  id: z.unknown().optional().describe('the draft to replace'), from: z.unknown().optional().describe('an experiment id to start from'),
  workspace: z.unknown().optional().describe('a workspace name, for a new empty draft'), name: z.unknown().optional(),
  base: z.unknown().optional().describe(SECTION), arms: z.unknown().optional().describe('[{ id?, name, overrides }]'), seed: z.unknown().optional().describe(SECTION),
  pace: z.unknown().optional().describe(SECTION), isolation: z.unknown().optional().describe(SECTION), blindness: z.unknown().optional().describe(SECTION), evaluation: z.unknown().optional().describe(SECTION),
});

// The calling worker while it is live, with the state it reads; none answers unknown_worker as every other tool does
function callerOf(deps: BenchmarkToolDeps, header: string | undefined): { state: State; worker: Worker } | undefined {
  const ptyId = livePtyId(deps, header);
  const state = deps.live()?.state;
  const worker = ptyId === undefined ? undefined : state?.workers.find((s) => s.runId === ptyId);
  return state && worker ? { state, worker } : undefined;
}

const createdByOf = (state: State, worker: Worker): Experiment['createdBy'] =>
  ({ kind: 'mcp', agent: worker.agent ?? liveDefaultAgent(state), ...(worker.launch?.model === undefined ? {} : { model: worker.launch.model }) });
const summary = (e: Experiment) => ({ id: e.id, name: e.name, status: e.status, workspace: e.workspace, ...(e.archived ? { archived: true } : {}) });
const configOf = ({ id, name, status, workspace, base, arms, seed, pace, isolation, blindness, evaluation }: Experiment) =>
  ({ id, name, status, workspace, base, arms, seed, pace, isolation, blindness, evaluation });

export function registerBenchmarkListTool(server: McpServer, deps: BenchmarkToolDeps, header: string | undefined): void {
  server.registerTool('benchmark_list', { description: LIST_DESCRIPTION, inputSchema: {} }, async () => recorded(deps, header, 'benchmark_list', async () => {
    const caller = callerOf(deps, header);
    if (!caller) return refuse('unknown_worker', UNKNOWN_WORKER_MESSAGE);
    return reply(JSON.stringify(caller.state.benchmark.experiments.map(summary)));
  }));
}

export function registerBenchmarkGetTool(server: McpServer, deps: BenchmarkToolDeps, header: string | undefined): void {
  server.registerTool('benchmark_get', { description: GET_DESCRIPTION, inputSchema: { id: z.string() } }, async ({ id }) => recorded(deps, header, 'benchmark_get', async () => {
    const caller = callerOf(deps, header);
    if (!caller) return refuse('unknown_worker', UNKNOWN_WORKER_MESSAGE);
    const experiment = caller.state.benchmark.experiments.find((e) => e.id === id);
    return experiment === undefined ? refuse('unknown_experiment', `no experiment ${id}`) : reply(JSON.stringify(configOf(experiment)));
  }));
}

export function registerBenchmarkDraftTool(server: McpServer, deps: BenchmarkToolDeps, header: string | undefined): void {
  server.registerTool('benchmark_draft', { description: DRAFT_DESCRIPTION, inputSchema: DRAFT_ARGS }, async (args) => recorded(deps, header, 'benchmark_draft', async () => {
    const caller = callerOf(deps, header);
    if (!caller) return refuse('unknown_worker', UNKNOWN_WORKER_MESSAGE);
    const answer = await deps.benchmark.draft(args, createdByOf(caller.state, caller.worker));
    return 'id' in answer ? reply(JSON.stringify({ id: answer.id })) : refuse('bad_draft', answer.refused);
  }));
}