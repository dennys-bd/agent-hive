// The template reviewer (#328): POST /api/items/:id/review runs hive:template-reviewer headless on the open file of an item and answers its
// annotations on that file. Nothing is written. One review per item at a time; a client that goes away cancels its run. The agent's raw
// output and stderr reach hive.log only. The checks, the run and the guard are ask the agent's (#330), reused from server-assist.ts.
import type { Express, Response } from 'express';
import { z } from 'zod';
import { agentRefusal } from './agents.js';
import { fileLines } from './assist.js';
import { isRefusal, mainFiles } from './custom-versions.js';
import { type HeadlessInput, type HeadlessResult, runHeadless } from './headless-run.js';
import type { ItemSources } from './item-sources.js';
import { readCatalogue, readItem } from './items-catalogue.js';
import { parseAnnotations, REVIEW_SCHEMA, REVIEWER_ID, REVIEWER_NAME, reviewPrompt } from './reviewer.js';
import { type AssistRouteDeps, cancelOnClose, openFile, variablesOf } from './server-assist.js';
import { bodyOf, ITEMS_ERROR_MESSAGE } from './server-plugins.js';
import { deliveredHeader, parseTemplate, renderTemplate } from './template.js';
import type { AgentId, ReviewerConfig } from './types.js';

const HTTP_CONFLICT = 409;
const HTTP_SERVER_ERROR = 500;
const HTTP_BAD_GATEWAY = 502;
const DETAIL_MAX = 2048; // what of an agent's raw output a log line keeps; hive.log clips a line further

export type ReviewCode = 'busy' | 'off' | 'agent_unavailable' | 'reviewer_unavailable' | 'bad_answer' | 'run_failed';
// The page shows its own copy by code (4.3); these only name the case for a reader of the raw answer
const MESSAGES: Record<Exclude<ReviewCode, 'agent_unavailable'>, string> = {
  busy: 'a review of this item is already running',
  off: 'the reviewer is off',
  reviewer_unavailable: "the reviewer's text is unavailable; see hive.log",
  bad_answer: "the reviewer's answer was refused; see hive.log",
  run_failed: 'the review run failed; see hive.log',
};

const REVIEW_BODY = z.object({ version: z.string().nullable(), path: z.string(), text: z.string() });
type ReviewBody = z.infer<typeof REVIEW_BODY>;
type ReviewConfig = { defaultAgent: AgentId; reviewer: ReviewerConfig; comb: { workspaces: ItemSources['workspaces'] } };

export interface TemplateReviewRouteDeps extends Omit<AssistRouteDeps, 'requireLive'> {
  requireLive(res: Response): { runtime: { config: ReviewConfig } } | undefined;
}

interface Prepared { agent: AgentId; model?: string; prompt: string; lineCount: number }

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const clip = (text: string): string => text.slice(0, DETAIL_MAX);
const fail = (res: Response, status: number, error: string, code?: ReviewCode): void =>
  void res.status(status).json(code === undefined ? { error } : { error, code });

// The reviewer's instructions: the template-reviewer item's body at reviewer.version (null: the shipped file), rendered with every
// variable's default, since no workspace owns a global run. renderTemplate prefixes exactly deliveredHeader, so slicing it off leaves the body
async function reviewerInstructions(sources: ItemSources, version: string | null): Promise<{ text: string } | { reason: string }> {
  const read = await readItem(sources, REVIEWER_ID, version);
  if (isRefusal(read)) return { reason: read.message };
  const main = read.files.find((file) => mainFiles('specialist', REVIEWER_NAME).includes(file.path));
  if (main === undefined) return { reason: `${REVIEWER_ID} has no ${REVIEWER_NAME}.md` };
  const parsed = parseTemplate(main.text);
  const rendered = renderTemplate(parsed, '');
  if (!rendered.ok) return { reason: `line ${rendered.errors[0]?.line}: ${rendered.errors[0]?.message}` };
  return { text: rendered.text.slice(deliveredHeader(parsed).length).trim() };
}

// Every check after busy and off, in the contract's order of causes; undefined once one has answered
async function prepare(res: Response, deps: TemplateReviewRouteDeps, sources: ItemSources, id: string, body: ReviewBody, config: ReviewConfig): Promise<Prepared | undefined> {
  const read = await openFile(res, sources, id, body);
  if (!read) return undefined;
  const { reviewer } = config;
  const agent = reviewer.agent ?? config.defaultAgent;
  const refused = agentRefusal(agent, deps.agents);
  if (refused !== undefined) return void fail(res, HTTP_CONFLICT, refused, 'agent_unavailable');
  const instructions = await reviewerInstructions(sources, reviewer.version);
  if ('reason' in instructions) {
    deps.log.warn(`review: ${id} reviewer unavailable: ${instructions.reason}`);
    return void fail(res, HTTP_CONFLICT, MESSAGES.reviewer_unavailable, 'reviewer_unavailable');
  }
  const others = read.files.filter((file) => file.path !== body.path).map(({ path, text }) => ({ path, text }));
  const catalogue = await readCatalogue(sources);
  const prompt = reviewPrompt({ instructions: instructions.text, path: body.path, kind: read.item.kind, text: body.text, others, variables: variablesOf(read, body), catalogue });
  return { agent, ...(reviewer.model === null ? {} : { model: reviewer.model }), prompt, lineCount: fileLines(body.text).length };
}

async function runAndAnswer(res: Response, deps: TemplateReviewRouteDeps, id: string, run: Prepared, signal: AbortSignal): Promise<void> {
  const input: HeadlessInput = { agent: run.agent, ...(run.model === undefined ? {} : { model: run.model }), prompt: run.prompt, schema: REVIEW_SCHEMA, signal };
  const result = signal.aborted
    ? undefined
    : await (deps.runHeadless ?? runHeadless)(input).catch((err: unknown): HeadlessResult => ({ failure: 'could not start', detail: errorMessage(err) }));
  if (result === undefined || signal.aborted) return void deps.log.info(`review: ${id} cancelled`);
  if ('failure' in result) {
    deps.log.warn(`review: ${id} ${run.agent} run failed: ${result.failure}: ${clip(result.detail)}`);
    return fail(res, HTTP_BAD_GATEWAY, MESSAGES.run_failed, 'run_failed');
  }
  const parsed = parseAnnotations(result.answer, run.lineCount);
  if ('reason' in parsed) {
    deps.log.warn(`review: ${id} bad answer: ${parsed.reason}: ${clip(result.answer)}`);
    return fail(res, HTTP_BAD_GATEWAY, MESSAGES.bad_answer, 'bad_answer');
  }
  res.json(parsed);
}

/** POST /api/items/:id/review (#328, contract api.review), behind the server's host, secret and x-hive-ui gates. */
export function registerTemplateReviewRoutes(app: Express, deps: TemplateReviewRouteDeps): void {
  const inFlight = new Set<string>(); // item ids with a review, any version
  app.post('/api/items/:id/review', async (req, res) => {
    const current = deps.requireLive(res);
    if (!current) return;
    const body = bodyOf(REVIEW_BODY, req, res);
    if (!body) return;
    const id = String(req.params.id);
    const { config } = current.runtime;
    // busy, then off, before any read: neither costs I/O, and no await between the check and the add
    if (inFlight.has(id)) return fail(res, HTTP_CONFLICT, MESSAGES.busy, 'busy');
    if (!config.reviewer.on) return fail(res, HTTP_CONFLICT, MESSAGES.off, 'off'); // the server guarantees the plan is not spent with it off
    inFlight.add(id);
    const signal = cancelOnClose(res);
    try {
      const run = await prepare(res, deps, { home: deps.home, pluginSource: deps.pluginSource, workspaces: config.comb.workspaces }, id, body, config);
      if (run) await runAndAnswer(res, deps, id, run, signal);
    } catch (err) {
      deps.log.error(`review: ${id} failed: ${errorMessage(err)}`);
      if (!res.headersSent) fail(res, HTTP_SERVER_ERROR, ITEMS_ERROR_MESSAGE);
    } finally {
      inFlight.delete(id);
    }
  });
}
