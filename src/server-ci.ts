import { recordsOf, taskOfActivity } from './activities.js';
import { ciQuery, cleanName, cleanText, parseCi } from './ci-checks.js';
import type { Logger } from './log.js';
import { inBackoff } from './polling.js';
import { openPrUrls, prNumber, prRepo } from './pull-requests.js';
import { OUTPUT_MAX } from './server-stage-commands.js';
import { taskId } from './tasks.js';
import type { CiCheck, CiPrRead, Effect, Exec, Gql, HiveEvent, State } from './types.js';

// A wait-for-CI stage's server side (#834), out of server.ts, which is over 1100 lines: the reads of every waiting task's open PRs, the re-run
// of failed Actions jobs and the fetch of the failed logs. Every gh call is an argv array with a timeout, so nothing hangs a wait.

export const GH_TIMEOUT_MS = 60_000;
export const LOG_LINES = 80; // the tail of each failed job's log the output keeps
const GH_MAX_BUFFER = 20 * 1024 * 1024;

export interface CiDeps {
  gql: Gql; // the PR poll's: gh api graphql
  exec: Exec;
  dispatch(event: HiveEvent): Promise<Effect[]>;
  log: Pick<Logger, 'error'>;
  state(): State | undefined;
  now?(): number;
}

export interface CiReader {
  readAll(): Promise<void>;
  readOne(activityId: string): Promise<void>;
  rerun(effect: Extract<Effect, { type: 'ciRerun' }>): Promise<void>;
  collect(effect: Extract<Effect, { type: 'ciCollect' }>): Promise<void>;
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const firstLine = (err: unknown): string => errorMessage(err).split('\n')[0] ?? '';

interface Waiting { activityId: string; urls: string[] }

// Each activity holding a wait, with its task's open PRs; a task whose source is in its quota backoff waits for the next tick (its timeout counts)
function waitingIn(state: State, now: number): Waiting[] {
  return state.activities.flatMap((a) => {
    const task = a.ci === undefined ? undefined : taskOfActivity(state, a.id);
    if (task === undefined) return [];
    const source = task.item.source;
    if (source !== undefined && inBackoff(Object.hasOwn(state.syncs, source) ? state.syncs[source] : undefined, now)) return [];
    return [{ activityId: a.id, urls: openPrUrls(recordsOf(state, taskId(task))) }];
  });
}

// gh prints each failed line as `<job>\t<step>\t<text>`: the job's own lines, else the run's, the last LOG_LINES
function jobTail(log: string, name: string): string {
  const lines = cleanText(log).split('\n').filter((line) => line !== '');
  const own = lines.filter((line) => line.split('\t')[0] === name);
  return (own.length > 0 ? own : lines).slice(-LOG_LINES).join('\n');
}

interface Block { header: string; body: string }

// Every block keeps its header and the tail of its body inside an even share of OUTPUT_MAX, so the whole fits a later prompt
function capped(blocks: Block[]): string {
  const share = Math.floor(OUTPUT_MAX / Math.max(1, blocks.length)) - 2;
  const text = blocks.map(({ header, body }) => (body === '' ? header : `${header}\n${body.slice(-Math.max(0, share - header.length - 1))}`)).join('\n\n');
  return text.slice(-OUTPUT_MAX);
}

// A failed check's header: its name, its PR, its page (#758's url) when GitHub gave one
const headerOf = (check: CiCheck): string =>
  cleanName(`${check.name} · #${prNumber(check.pr)}${check.url === undefined ? '' : ` · ${check.url}`}`);

export function createCiReader({ gql, exec, dispatch, log, state, now = Date.now }: CiDeps): CiReader {
  const gh = async (args: string[]): Promise<string> => (await exec('gh', args, { timeout: GH_TIMEOUT_MS, maxBuffer: GH_MAX_BUFFER })).stdout;

  // One query for every PR of `list`, then one ciRead per activity, one after the other. No PR at all: no query, and every read is empty. A query
  // that fails, or a PR the parse left out, reads nothing (never a false pass) and dispatches ciClock instead, so the timeout still counts
  async function read(list: Waiting[]): Promise<void> {
    if (list.length === 0) return;
    const urls = [...new Set(list.flatMap((w) => w.urls))];
    const query = ciQuery(urls);
    let reads: CiPrRead[] | undefined;
    try {
      reads = query === undefined ? [] : parseCi(urls, await gql(query));
    } catch (err) {
      log.error(`ci read: ${errorMessage(err)}`);
    }
    const at = new Date(now()).toISOString();
    for (const { activityId, urls: own } of list) {
      const prs = (reads ?? []).filter((r) => own.includes(r.url));
      const isRead = reads !== undefined && prs.length === own.length;
      await dispatch(isRead ? { type: 'ciRead', activityId, at, prs } : { type: 'ciClock', activityId, at });
    }
  }

  const readAll = async (): Promise<void> => {
    const current = state();
    if (current) await read(waitingIn(current, now()));
  };
  const readOne = async (activityId: string): Promise<void> => {
    const current = state();
    if (current) await read(waitingIn(current, now()).filter((w) => w.activityId === activityId));
  };

  // Each run once; a failure is logged and, past the re-run's grace, the next read sees the checks still failed on a head already re-run, so the stage fails
  async function rerun({ runs }: Extract<Effect, { type: 'ciRerun' }>): Promise<void> {
    for (const { repo, runId } of runs) {
      await gh(['run', 'rerun', String(runId), '--failed', '-R', repo]).catch((err: unknown) => log.error(`ci rerun ${runId}: ${firstLine(err)}`));
    }
  }

  // One gh run view per run, shared by its failed jobs; a check with no Actions run is its header alone
  async function blocksOf(failed: CiCheck[]): Promise<Block[]> {
    const logs = new Map<string, Promise<string>>();
    const logOf = (repo: string, runId: number): Promise<string> => {
      const key = `${repo}#${runId}`;
      const known = logs.get(key) ?? gh(['run', 'view', String(runId), '--log-failed', '-R', repo]);
      logs.set(key, known);
      return known;
    };
    return Promise.all(failed.map(async (check): Promise<Block> => {
      const header = headerOf(check);
      if (check.runId === undefined) return { header, body: '' };
      try {
        return { header, body: jobTail(await logOf(prRepo(check.pr), check.runId), check.name) };
      } catch (err) {
        return { header, body: `log unavailable: ${firstLine(err)}` };
      }
    }));
  }

  // Always ends in ciFailed, so the stage's collecting mark never outlives the fetch
  async function collect({ activityId, failed }: Extract<Effect, { type: 'ciCollect' }>): Promise<void> {
    let output: string;
    try {
      output = capped(await blocksOf(failed));
    } catch (err) {
      output = `logs unavailable: ${firstLine(err)}`;
    }
    await dispatch({ type: 'ciFailed', activityId, names: failed.map((c) => cleanName(c.name)), output });
  }

  return { readAll, readOne, rerun, collect };
}
