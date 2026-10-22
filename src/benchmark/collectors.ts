// The static collectors (#474): #877's reviewers, one headless read-only run per row in the eval worktree. Unlike #877's stage, a failing
// collector is one `error` row and the rest go on: a benchmark wants every signal it can get from an expensive run.
import { parseFindings, REVIEW_SCHEMA, reviewerPrompt, type Work } from '../evaluate-prompt.js';
import type { HeadlessInput, HeadlessResult } from '../headless-run.js';
import { specializedAgents } from '../launch-options.js';
import { EVALUATE_TIMEOUT_MS } from '../server-evaluate.js';
import type { CollectorResult, EvaluateRow } from '../types.js';

export interface CollectorDeps { headless(input: HeadlessInput): Promise<HeadlessResult>; signal: AbortSignal; log(line: string): void }

export const collectorName = (row: EvaluateRow): string => `${row.specializedAgent ?? row.agent}${row.focus ? ` · ${row.focus}` : ''}`;

// The row's agent body from the experiment's pinned plugin, never the workspace's current one; read once for all the rows
function instructionsOf(row: EvaluateRow, roles: () => { name: string; instructions: string }[]): { instructions?: string } | { reason: string } {
  if (row.specializedAgent === undefined) return {};
  const role = roles().find((r) => r.name === row.specializedAgent);
  return role === undefined ? { reason: `${row.specializedAgent} is not an agent of the experiment's plugin` } : { instructions: role.instructions };
}

async function collect(row: EvaluateRow, work: Work, cwd: string, roles: () => { name: string; instructions: string }[], deps: CollectorDeps): Promise<CollectorResult> {
  const name = collectorName(row);
  const error = (summary: string): CollectorResult => ({ name, status: 'error', summary, findings: [] });
  let picked: { instructions?: string } | { reason: string };
  try {
    picked = instructionsOf(row, roles);
  } catch (err) {
    picked = { reason: err instanceof Error ? err.message : String(err) }; // a bad frontmatter in the pinned plugin
  }
  if ('reason' in picked) return error(picked.reason);
  const input: HeadlessInput = {
    agent: row.agent, ...(row.model === undefined ? {} : { model: row.model }), prompt: reviewerPrompt(work, row.focus ?? '', picked.instructions),
    schema: REVIEW_SCHEMA, signal: deps.signal, cwd, readOnlyTools: true, timeoutMs: EVALUATE_TIMEOUT_MS,
  };
  const result = await deps.headless(input).catch((): HeadlessResult => ({ failure: 'could not start', detail: '' }));
  if ('failure' in result) return error(result.failure);
  const parsed = parseFindings(result.answer);
  if ('reason' in parsed) return error(parsed.reason);
  return { name, status: parsed.findings.length === 0 ? 'ok' : 'warn', summary: `${parsed.findings.length} findings`, findings: parsed.findings };
}

export async function runCollectors(rows: readonly EvaluateRow[], work: Work, cwd: string, pluginDir: string, deps: CollectorDeps): Promise<CollectorResult[]> {
  let cached: { name: string; instructions: string }[] | undefined;
  const roles = (): { name: string; instructions: string }[] => (cached ??= specializedAgents(pluginDir));
  const results = await Promise.all(rows.map((row) => collect(row, work, cwd, roles, deps)));
  for (const [i, r] of results.entries()) deps.log(`collector ${i + 1}: ${r.status}`);
  return results;
}
