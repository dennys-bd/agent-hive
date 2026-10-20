// Ask the agent (#330): POST /api/items/:id/assist runs the chosen agent headless on the open file of an item and answers its proposal, with
// the diff against the text the user sees. Nothing is written: accepting is the save route's (#331). One run per item at a time; a client
// that goes away cancels its run. The agent's raw output and stderr reach hive.log only.
import type { Express, Response } from 'express';
import { z } from 'zod';
import { agentRefusal } from './agents.js';
import { applyProposal, ASSIST_SCHEMA, type AssistAnswer, assistPrompt, type AssistTarget, parseProposal, proposalHunk, targetOf } from './assist.js';
import { isRefusal, mainFiles } from './custom-versions.js';
import { type HeadlessInput, type HeadlessResult, runHeadless } from './headless-run.js';
import type { ItemSources } from './item-sources.js';
import { isLaunchModel } from './launch-pick.js';
import { readCatalogue, readItem } from './items-catalogue.js';
import type { Logger } from './log.js';
import { bodyOf, ITEMS_ERROR_MESSAGE } from './server-plugins.js';
import { parseTemplate, type TemplateVariable } from './template.js';
import { AGENT_IDS, type AgentAvailability, type AgentId, type ItemRead } from './types.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_SERVER_ERROR = 500;
const HTTP_BAD_GATEWAY = 502;
const DETAIL_MAX = 2048; // what of an agent's raw output a log line keeps (decision 14); hive.log clips a line further

export type AssistCode = 'busy' | 'agent_unavailable' | 'bad_answer' | 'run_failed';
// The page shows its own copy by code (#331); these only name the case for a reader of the raw answer
const MESSAGES: Record<Exclude<AssistCode, 'agent_unavailable'>, string> = {
  busy: 'the agent is already working on this item',
  bad_answer: "the agent's answer was refused; see hive.log",
  run_failed: 'the agent run failed; see hive.log',
};

const ASSIST_BODY = z.object({
  version: z.string().nullable(),
  path: z.string(),
  text: z.string(),
  request: z.string().min(1),
  selection: z.object({ startLine: z.number().int(), endLine: z.number().int() }).optional(),
  agent: z.enum(AGENT_IDS).optional(),
  model: z.string().refine(isLaunchModel, 'not a model name').optional(), // the open routes' rule: never a leading '-', bounded
});
type AssistBody = z.infer<typeof ASSIST_BODY>;

export interface AssistRouteDeps {
  requireLive(res: Response): { runtime: { config: { defaultAgent: AgentId; comb: { workspaces: ItemSources['workspaces'] } } } } | undefined;
  home: string;
  pluginSource: string;
  agents: readonly AgentAvailability[];
  log: Pick<Logger, 'error' | 'warn' | 'info'>;
  runHeadless?: (input: HeadlessInput) => Promise<HeadlessResult>; // tests inject a fake
}

interface Prepared { agent: AgentId; model?: string; prompt: string; target: AssistTarget; text: string }

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const clip = (text: string): string => text.slice(0, DETAIL_MAX);
const fail = (res: Response, status: number, error: string, code?: AssistCode): void =>
  void res.status(status).json(code === undefined ? { error } : { error, code });

// The item's files as the body names them: one of its versions, or the original for null; 404 for an unknown item, version or path; the
// template reviewer's route too (#328)
export async function openFile(res: Response, sources: ItemSources, id: string, body: Pick<AssistBody, 'version' | 'path'>): Promise<ItemRead | undefined> {
  const read = await readItem(sources, id, body.version);
  if (isRefusal(read)) return void fail(res, HTTP_NOT_FOUND, read.message);
  if (!read.files.some((file) => file.path === body.path)) return void fail(res, HTTP_NOT_FOUND, `${id} has no file ${body.path}`);
  return read;
}

// An item declares its variables in its main file's header: the body's text when that is the open file (unsaved edits count), else the
// version's own; the template reviewer's route too (#328)
export function variablesOf(read: ItemRead, body: Pick<AssistBody, 'path' | 'text'>): TemplateVariable[] {
  const main = mainFiles(read.item.kind, read.item.name);
  const text = main.includes(body.path) ? body.text : read.files.find((file) => main.includes(file.path))?.text;
  return text === undefined ? [] : parseTemplate(text).variables;
}

// Every check before the run, in the contract's order of causes; undefined once one has answered
async function prepare(res: Response, deps: AssistRouteDeps, sources: ItemSources, id: string, body: AssistBody, defaultAgent: AgentId): Promise<Prepared | undefined> {
  const read = await openFile(res, sources, id, body);
  if (!read) return undefined;
  const target = targetOf(body.text, body.selection);
  if (!target) return void fail(res, HTTP_BAD_REQUEST, 'selection: outside the text');
  const agent = body.agent ?? defaultAgent;
  const refused = agentRefusal(agent, deps.agents);
  if (refused !== undefined) return void fail(res, HTTP_CONFLICT, refused, 'agent_unavailable');
  const catalogue = await readCatalogue(sources);
  const prompt = assistPrompt({ request: body.request, path: body.path, kind: read.item.kind, text: body.text, target, variables: variablesOf(read, body), catalogue });
  return { agent, ...(body.model === undefined ? {} : { model: body.model }), prompt, target, text: body.text };
}

// res, not req: req's close fires as soon as express.json has read the body; res's before the answer means the client went away. Listened
// to before any await, since close fires once: a client gone while the item is read must not leave a run going for nobody; the template
// reviewer's route too (#328)
export function cancelOnClose(res: Response): AbortSignal {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
  });
  return controller.signal;
}

async function runAndAnswer(res: Response, deps: AssistRouteDeps, id: string, run: Prepared, signal: AbortSignal): Promise<void> {
  const input: HeadlessInput = { agent: run.agent, ...(run.model === undefined ? {} : { model: run.model }), prompt: run.prompt, schema: ASSIST_SCHEMA, signal };
  const result = signal.aborted
    ? undefined
    : await (deps.runHeadless ?? runHeadless)(input).catch((err: unknown): HeadlessResult => ({ failure: 'could not start', detail: errorMessage(err) }));
  if (result === undefined || signal.aborted) return void deps.log.info(`assist: ${id} cancelled`);
  if ('failure' in result) {
    deps.log.warn(`assist: ${id} ${run.agent} run failed: ${result.failure}: ${clip(result.detail)}`);
    return fail(res, HTTP_BAD_GATEWAY, MESSAGES.run_failed, 'run_failed');
  }
  const parsed = parseProposal(result.answer, run.target);
  if ('reason' in parsed) {
    deps.log.warn(`assist: ${id} bad answer: ${parsed.reason}: ${clip(result.answer)}`);
    return fail(res, HTTP_BAD_GATEWAY, MESSAGES.bad_answer, 'bad_answer');
  }
  const text = applyProposal(run.text, parsed.proposal);
  const answer: AssistAnswer = { proposal: parsed.proposal, hunk: proposalHunk(run.text, parsed.proposal), text, changed: text !== run.text };
  res.json(answer);
}

/** POST /api/items/:id/assist (#330, contract api.assist), behind the server's host, secret and x-hive-ui gates. */
export function registerAssistRoutes(app: Express, deps: AssistRouteDeps): void {
  const inFlight = new Set<string>(); // item ids with a run, any version (decision 10)
  app.post('/api/items/:id/assist', async (req, res) => {
    const current = deps.requireLive(res);
    if (!current) return;
    const body = bodyOf(ASSIST_BODY, req, res);
    if (!body) return;
    const id = String(req.params.id);
    const { config } = current.runtime;
    // busy before any read: a second request costs no catalogue I/O, and no await between this check and the add
    if (inFlight.has(id)) return fail(res, HTTP_CONFLICT, MESSAGES.busy, 'busy');
    inFlight.add(id);
    const signal = cancelOnClose(res);
    try {
      const run = await prepare(res, deps, { home: deps.home, pluginSource: deps.pluginSource, workspaces: config.comb.workspaces }, id, body, config.defaultAgent);
      if (run) await runAndAnswer(res, deps, id, run, signal);
    } catch (err) {
      deps.log.error(`assist: ${id} failed: ${errorMessage(err)}`);
      if (!res.headersSent) fail(res, HTTP_SERVER_ERROR, ITEMS_ERROR_MESSAGE);
    } finally {
      inFlight.delete(id);
    }
  });
}
