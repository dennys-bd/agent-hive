// The judge (#474): in a fresh temp folder holding only the blind bundle, read-only, as the harness's judge was; never in the eval worktree,
// whose files the blindness check never scrubbed. Scores 1..5, one per rubric line, the lines unrendered (a seed has no task item).
import { createHash } from 'node:crypto';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { JUDGE_SCHEMA, judgePrompt, parseScores, type ScoreRange, type Work } from '../evaluate-prompt.js';
import type { HeadlessInput, HeadlessResult } from '../headless-run.js';
import { specializedAgents } from '../launch-options.js';
import { EVALUATE_TIMEOUT_MS } from '../server-evaluate.js';
import { rubricLines } from '../stage-agent.js';
import type { EvaluateRow, JudgeScore, ReviewFinding } from '../types.js';
import { type BundleFile, writeBundle } from './blind.js';

export const BENCH_SCORE_RANGE: ScoreRange = { min: 1, max: 5 };

const BUNDLE_GUIDE = 'Your current folder is the run\'s blind bundle, not a repository: diff.patch (the changes against the baseline), metrics.json, findings.json (each collector\'s findings), scenarios.json (each click scenario\'s passes over its walks, with the tester\'s notes) and screens/ (a screenshot per scenario step, named <scenario>-<walk>-<n>.png). There is no CLAUDE.md or AGENTS.md to read. Read the bundle with the Read and Glob tools.';

export interface JudgeInput { row: EvaluateRow; pluginDir: string; rubric: string; files: readonly BundleFile[]; work: Work; findings: readonly { who: string; findings: ReviewFinding[] }[] }
export interface JudgeDeps { headless(input: HeadlessInput): Promise<HeadlessResult>; signal: AbortSignal; tmpRoot: string }

export const rubricHash = (rubric: string): string => createHash('sha256').update(rubric).digest('hex').slice(0, 12);

function instructionsOf(row: EvaluateRow, pluginDir: string): string {
  const body = row.specializedAgent === undefined ? undefined : specializedAgents(pluginDir).find((r) => r.name === row.specializedAgent)?.instructions;
  return [body, BUNDLE_GUIDE].filter((part): part is string => part !== undefined).join('\n\n');
}

export async function judgeBundle(input: JudgeInput, keepAt: string, deps: JudgeDeps): Promise<{ scores: JudgeScore[] } | { reason: string }> {
  const lines = rubricLines(input.rubric);
  if (lines.length === 0) return { scores: [] };
  const dir = await mkdtemp(join(deps.tmpRoot, 'hive-judge-'));
  const bundle = join(dir, 'bundle');
  try {
    await writeBundle(bundle, input.files);
    const prompt = judgePrompt(input.work, lines, input.findings, instructionsOf(input.row, input.pluginDir), BENCH_SCORE_RANGE);
    const { row } = input;
    const result = await deps.headless({ agent: row.agent, ...(row.model === undefined ? {} : { model: row.model }), prompt, schema: JUDGE_SCHEMA, signal: deps.signal, cwd: bundle, outsideRepo: true, readOnlyTools: true, timeoutMs: EVALUATE_TIMEOUT_MS })
      .catch((): HeadlessResult => ({ failure: 'could not start', detail: '' }));
    await rm(keepAt, { recursive: true, force: true });
    await cp(bundle, keepAt, { recursive: true });
    if ('failure' in result) return { reason: result.failure };
    return parseScores(result.answer, lines, BENCH_SCORE_RANGE);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
