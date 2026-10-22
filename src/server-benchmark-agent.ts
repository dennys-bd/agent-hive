// Ask the agent (#478, mcp.benchmark): the dialog's post opens a local session whose prompt asks for one draft through the benchmark tools.
// Mounted from registerBenchmarkRoutes. The prompt is English, as every worker prompt the Hive writes; the description never reaches a log.
import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import { localActivityId } from './activities.js';
import { knownAgent, liveDefaultAgent } from './agents.js';
import { zodIssues } from './benchmark/draft-schema.js';
import { workspaceByName } from './config.js';
import { askedLaunch } from './launch-options.js';
import type { Logger } from './log.js';
import type { BenchmarkRouteDeps } from './server-benchmark.js';
import { answerOpen, type TaskRouteDeps } from './server-tasks.js';
import { sizeIn } from './terminal-wire.js';
import { AGENT_IDS, type OptionalTool } from './types.js';

const DESCRIPTION_MAX = 4000;
const ASK = z.object({ description: z.string().trim().min(1).max(DESCRIPTION_MAX), workspace: z.string(), from: z.string().optional() });
type Ask = z.infer<typeof ASK>;
// A session that cannot read or save the draft would only spend a run
const NEEDED: readonly OptionalTool[] = ['benchmark_get', 'benchmark_draft'];
const TOOLS = 'mcp__hive__benchmark_list, mcp__hive__benchmark_get and mcp__hive__benchmark_draft';
export const ASK_RULE = 'Nothing runs: never run, sleep or evaluate an experiment; save one draft with benchmark_draft and report its id.';

export type AskSessionDeps = Pick<TaskRouteDeps, 'dispatch' | 'started' | 'language' | 'plugin'>;
export interface BenchmarkAgentDeps { requireLive: BenchmarkRouteDeps['requireLive']; log: Pick<Logger, 'warn'>; session: AskSessionDeps }
interface AskRefusal { status: number; error: string; message: string }
type Live = NonNullable<ReturnType<BenchmarkRouteDeps['requireLive']>>;

/** The drafting session's first message. Lines joined, never a replace, so a `$` in the description stays as typed. */
export function askPrompt({ description, workspace, from }: Ask): string {
  const start = from === undefined
    ? `Start from the empty experiment: pass workspace "${workspace}" to benchmark_draft.`
    : `Start from experiment ${from}: call mcp__hive__benchmark_get with id "${from}" first, then pass from "${from}" to benchmark_draft.`;
  return [`Draft a benchmark experiment in the Hive's workspace ${workspace}, from this description:`, '', description, '', start,
    `Read and write it only with the Hive's MCP tools ${TOOLS}.`, ASK_RULE].join('\n');
}

// What the post may not open, in the spec's order; undefined: it may
function askRefusal(live: Live, ask: Ask): AskRefusal | undefined {
  const { config } = live.runtime;
  if (workspaceByName(config, ask.workspace) === undefined) return { status: 404, error: 'unknown_workspace', message: `no workspace ${ask.workspace}` };
  const from = ask.from === undefined ? undefined : live.state.benchmark.experiments.find((e) => e.id === ask.from);
  if (ask.from !== undefined && from === undefined) return { status: 404, error: 'unknown_experiment', message: `no experiment ${ask.from}` };
  if (from !== undefined && from.workspace !== ask.workspace) return { status: 400, error: 'other_workspace', message: `${from.id} belongs to ${from.workspace}` };
  if (config.mcp.off.some((tool) => NEEDED.includes(tool))) return { status: 409, error: 'mcp_off', message: 'turn on benchmark_get and benchmark_draft in Plugins › MCP' };
  return undefined;
}

export function registerBenchmarkAgentRoutes(app: Express, deps: BenchmarkAgentDeps): void {
  app.post('/benchmark/agent', async (req: Request, res: Response) => {
    const live = deps.requireLive(res);
    if (!live) return;
    const refuse = (r: AskRefusal): void => {
      deps.log.warn(`benchmark: ask the agent refused: ${r.error}`); // the code only: the description is the user's text
      res.status(r.status).json({ error: r.error, message: r.message });
    };
    const ask = ASK.safeParse(req.body ?? {});
    if (!ask.success) return refuse({ status: 400, error: 'bad_body', message: zodIssues(ask.error).join('\n') });
    const { kind } = (req.body ?? {}) as { kind?: unknown };
    const agent = knownAgent(kind);
    if (kind !== undefined && agent === undefined) return refuse({ status: 400, error: 'unknown_agent', message: `kind must be one of: ${AGENT_IDS.join(', ')}` });
    const gate = askRefusal(live, ask.data);
    if (gate) return refuse(gate);
    await deps.session.plugin.ready();
    const picked = askedLaunch(req.body, agent ?? liveDefaultAgent(live.state), deps.session.language(), () => deps.session.plugin.dir(ask.data.workspace));
    if ('status' in picked) return refuse({ status: picked.status, error: 'bad_launch', message: picked.message });
    const event = { type: 'newLocalSession', activityId: localActivityId(ask.data.workspace), ...(agent === undefined ? {} : { agent }), ...picked, prompt: askPrompt(ask.data) } as const;
    await answerOpen(deps.session, await deps.session.dispatch(event, sizeIn(req.body)), res);
  });
}