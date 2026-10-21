import { agentRefusal } from './agents.js';
import { noWorkspaceReason, taskWorkspace } from './config.js';
import { DiffTooLarge, diffBase, taskPatch } from './diff.js';
import { cutPatch, JUDGE_SCHEMA, judgePrompt, parseFindings, parseScores, REVIEW_SCHEMA, reviewerPrompt, type Work } from './evaluate-prompt.js';
import { workspaceBase } from './fork.js';
import { type HeadlessDeps, type HeadlessResult, runHeadless } from './headless-run.js';
import { launchRun, type SpecializedAgent, specializedAgents } from './launch-options.js';
import type { Logger } from './log.js';
import type { Runtime } from './server.js';
import { readyWorktree } from './server-stage-commands.js';
import { renderPrompt } from './spawn.js';
import { rubricLines } from './stage-agent.js';
import { failingScores } from './stage-evaluate.js';
import type { Activity, AgentAvailability, AgentId, Effect, EvaluateRow, Exec, HiveEvent, JudgeScore, ReviewFinding, Stage, StageEvaluate, Task, Workspace } from './types.js';

// How an evaluate stage runs (#877): every reviewer headless at once in the task's worktree, read-only, then the judge with their findings; each
// answer under its schema, checked with zod. One AbortController per evaluation: the Stop's abortEvaluate, a Quit's abortAll. A reviewer that
// breaks aborts the others (a batch controller under the run's). The answers reach the reducer as evaluateJudging, then evaluateEnded or
// evaluateBroken; a stopped run dispatches nothing. Never logged: a prompt, the patch, a finding, the evidence or a failed run's output (Codex
// echoes the prompt on its stderr).

/** How long one reviewer's or the judge's run may take (#877). A timeout breaks the stage. */
export const EVALUATE_TIMEOUT_MS = 20 * 60_000; // ponytail: fixed; a stage timeout if it ever falls short
const TOO_LARGE_PATCH = '[patch over 5 MB: read the files]';

type EvaluateEffect = Extract<Effect, { type: 'evaluate' }>;

export interface EvaluateDeps {
  exec: Exec;
  agents: readonly AgentAvailability[];
  log: Pick<Logger, 'info' | 'warn'>;
  dispatch(event: HiveEvent): Promise<Effect[]>;
  prepare(runtime: Runtime, activity: Activity, task: Task, key: string): Promise<string>; // the spawner's: the worktree and its setup
  current(activityId: string): StageEvaluate | undefined; // the mark the State holds now: a Stop during the setup dropped it
  pluginDir(workspace: string): Promise<string>; // the workspace's rendered plugin folder, once its renders landed
  headless?: HeadlessDeps; // tests: a fake CLI first on PATH, a shorter timeout
}

export interface EvaluateRunner { run(runtime: Runtime, effect: EvaluateEffect): Promise<void>; abort(runId: string): void; abortAll(): void }

interface Row { who: string; agent: AgentId; model?: string; instructions?: string; focus: string }
type Broken = { broken: string };
interface Reviewed { findings: ReviewFinding[]; byRow: { who: string; findings: ReviewFinding[] }[] }

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// One row's launch (#877, decision 7): its agent on PATH, then its picks as a stage run's are checked, its specialized agent looked up in the
// workspace's plugin folder, which is read only when some row names one, and once for all the rows
async function resolveRows(deps: EvaluateDeps, stage: Stage, workspace: string): Promise<{ reviewers: Row[]; judge: Row } | Broken> {
  const { reviewers = [], judge } = stage;
  if (judge === undefined) return { broken: 'the stage has no judge' }; // the config refuses it; a hand-edited state's stage might not
  const named: [string, EvaluateRow][] = [...reviewers.map((row, i): [string, EvaluateRow] => [`reviewer ${i + 1} (${row.agent})`, row]), [`judge (${judge.agent})`, judge]];
  const isNamed = named.some(([, row]) => row.specializedAgent !== undefined);
  const dir = isNamed ? await deps.pluginDir(workspace) : '';
  let roles: SpecializedAgent[] | undefined;
  const rows: Row[] = [];
  for (const [who, row] of named) {
    const refusal = agentRefusal(row.agent, deps.agents);
    if (refusal !== undefined) return { broken: `${who}: ${refusal}` };
    const pick = { ...(row.model === undefined ? {} : { model: row.model }), ...(row.specializedAgent === undefined ? {} : { specializedAgent: row.specializedAgent }) };
    const picked = launchRun(pick, [], () => (roles ??= specializedAgents(dir)));
    if ('refusal' in picked) return { broken: `${who}: ${picked.refusal}` };
    const instructions = picked.specializedAgent?.instructions;
    rows.push({ who, agent: row.agent, focus: row.focus ?? '', ...(picked.model === undefined ? {} : { model: picked.model }), ...(instructions === undefined ? {} : { instructions }) });
  }
  return { reviewers: rows.slice(0, -1), judge: rows[rows.length - 1] as Row };
}

// The task and its changes (#877, decision 10): the patch against the worktree scope's base, on taskDiff's index copy. Past 5 MB the patch is a
// line saying so, and the stat goes with it: both come from one index copy, and the files are what the agents read anyway
async function workOf(runtime: Runtime, { task, activity }: EvaluateEffect, workspace: Workspace, cwd: string, exec: Exec): Promise<Work | Broken> {
  try {
    const base = await diffBase(task, activity, workspaceBase(runtime.config, workspace), cwd, 'worktree', exec);
    const diff = await taskPatch(cwd, base.commit, exec).catch((err: unknown) => {
      if (err instanceof DiffTooLarge) return { stat: '', patch: TOO_LARGE_PATCH };
      throw err;
    });
    return { id: task.item.id, title: task.item.title, body: task.item.body, base: base.label, stat: diff.stat, patch: cutPatch(diff.patch) };
  } catch (err) {
    return { broken: `diff: ${errorMessage(err)}` };
  }
}

// The rubric's dimensions as the judge reads them and the scores are named (#877, decision 4): each line rendered alone, its whitespace folded,
// so a {body} of several lines never adds one; a line that renders empty keeps its raw text, so no score goes unnamed
const dimensionsOf = ({ stage, task, result }: EvaluateEffect): string[] =>
  rubricLines(stage.rubric ?? '').map((line) => renderPrompt(line, task.item, result).replace(/\s+/g, ' ').trim() || line);

export function createEvaluateRunner(deps: EvaluateDeps): EvaluateRunner {
  const runs = new Map<string, AbortController>();

  // One headless run, read-only in the worktree; a throw (its temp folder) reads as a failure. The reason only, never the run's output
  async function ask(row: Row, prompt: string, schema: object, cwd: string, signal: AbortSignal): Promise<{ answer: string } | Broken> {
    let result: HeadlessResult;
    try {
      const input = { agent: row.agent, prompt, schema, signal, cwd, readOnlyTools: true as const, timeoutMs: EVALUATE_TIMEOUT_MS };
      result = await runHeadless({ ...input, ...(row.model === undefined ? {} : { model: row.model }) }, deps.headless);
    } catch (err) {
      result = { failure: 'could not start', detail: errorMessage(err) };
    }
    return 'answer' in result ? result : { broken: `${row.who}: ${result.failure}` };
  }

  // Every reviewer at once (#877, decision 12): the first failure aborts the rest and is the one named, never a `cancelled` it caused
  async function review(rows: readonly Row[], work: Work, cwd: string, signal: AbortSignal): Promise<Reviewed | Broken> {
    const batch = new AbortController();
    const both = AbortSignal.any([signal, batch.signal]);
    let first: string | undefined;
    const lists = await Promise.all(rows.map(async (row) => {
      const asked = await ask(row, reviewerPrompt(work, row.focus, row.instructions), REVIEW_SCHEMA, cwd, both);
      const parsed = 'broken' in asked ? asked : parseFindings(asked.answer);
      if ('findings' in parsed) return parsed.findings;
      first ??= 'broken' in parsed ? parsed.broken : `${row.who}: ${parsed.reason}`;
      batch.abort();
      return [];
    }));
    if (first !== undefined) return { broken: first };
    return { findings: lists.flat(), byRow: rows.map((row, i) => ({ who: `${row.who} · ${row.focus}`, findings: lists[i] ?? [] })) };
  }

  async function judge(row: Row, work: Work, dimensions: string[], reviewed: Reviewed, cwd: string, signal: AbortSignal): Promise<{ scores: JudgeScore[] } | Broken> {
    const asked = await ask(row, judgePrompt(work, dimensions, reviewed.byRow, row.instructions), JUDGE_SCHEMA, cwd, signal);
    if ('broken' in asked) return asked;
    const parsed = parseScores(asked.answer, dimensions);
    return 'reason' in parsed ? { broken: `${row.who}: ${parsed.reason}` } : parsed;
  }

  // The evaluation in decision 7's order, every check before any git; the last event to dispatch, none when a Stop dropped the run
  async function evaluate(runtime: Runtime, effect: EvaluateEffect, signal: AbortSignal): Promise<HiveEvent | undefined> {
    const { activity, task, runId } = effect;
    const broken = (message: string): HiveEvent => ({ type: 'evaluateBroken', activityId: activity.id, runId, message });
    const workspace = taskWorkspace(runtime.config, task);
    if (!workspace) return broken(noWorkspaceReason(task));
    const rows = await resolveRows(deps, effect.stage, workspace.name);
    if ('broken' in rows) return broken(rows.broken);
    let cwd: string | undefined;
    try {
      cwd = await readyWorktree(deps, runtime, activity, task, runId, () => deps.current(activity.id)?.runId === runId);
    } catch (err) {
      return broken(`worktree: ${errorMessage(err)}`);
    }
    if (cwd === undefined || signal.aborted) return undefined;
    const work = await workOf(runtime, effect, workspace, cwd, deps.exec);
    if ('broken' in work) return broken(work.broken);
    const reviewed = await review(rows.reviewers, work, cwd, signal);
    if ('broken' in reviewed) return broken(reviewed.broken);
    if (signal.aborted) return undefined;
    await deps.dispatch({ type: 'evaluateJudging', activityId: activity.id, runId });
    const judged = await judge(rows.judge, work, dimensionsOf(effect), reviewed, cwd, signal);
    if ('broken' in judged) return broken(judged.broken);
    const threshold = effect.stage.threshold ?? 0;
    // the failing dimensions by their 1-based index: a rendered line can carry the task's text, which no log line holds
    const failing = new Set(failingScores(judged.scores, threshold));
    const below = judged.scores.flatMap((s, i) => (failing.has(s) ? [i + 1] : [])).join(',') || 'none';
    deps.log.info(`evaluate #${task.item.id}: scores ${judged.scores.map((s) => s.score).join(',')} against ${threshold}: below: ${below}`);
    return { type: 'evaluateEnded', activityId: activity.id, runId, scores: judged.scores, findings: reviewed.findings };
  }

  async function run(runtime: Runtime, effect: EvaluateEffect): Promise<void> {
    const controller = new AbortController();
    runs.set(effect.runId, controller);
    try {
      const last = await evaluate(runtime, effect, controller.signal);
      if (last !== undefined && !controller.signal.aborted) await deps.dispatch(last); // a Stop already ended the stage: nothing to answer
    } catch (err) {
      if (!controller.signal.aborted) await deps.dispatch({ type: 'evaluateBroken', activityId: effect.activity.id, runId: effect.runId, message: errorMessage(err) });
    } finally {
      runs.delete(effect.runId);
    }
  }

  return {
    run,
    abort: (runId) => runs.get(runId)?.abort(),
    abortAll: () => { for (const controller of runs.values()) controller.abort(); },
  };
}
