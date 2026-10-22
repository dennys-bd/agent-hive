import { TESTER_TOOLS } from '../../src/benchmark/browser.js';
import type { Run } from '../../src/benchmark/exec.js';
import { CRITERIA, type Criterion, type Judge, type Score } from './types.js';

export const TESTER_MODEL = 'sonnet'; // the spec fixes only the judge's model
export { parseClicks, TESTER_TIMEOUT_MS } from '../../src/benchmark/browser.js';
export const JUDGE_TIMEOUT_MS = 30 * 60_000;
const DENIED = 'Bash Edit Write NotebookEdit WebFetch WebSearch';
// The tester works in a bare temp folder and needs only the browser: no file tool reaches the state folder or the home from it
const TESTER_DENIED = `${DENIED} Read Glob Grep`;
const VISUAL: readonly Criterion[] = ['fidelity', 'behaviour'];
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export const testerArgs = (prompt: string, mcpConfig: string): string[] => [
  '-p', prompt, '--model', TESTER_MODEL, '--output-format', 'json', '--mcp-config', mcpConfig, '--strict-mcp-config', '--setting-sources', 'project', '--allowedTools', TESTER_TOOLS.join(' '), '--disallowedTools', TESTER_DENIED,
];

export const judgeArgs = (prompt: string, model: string): string[] => [
  '-p', prompt, '--model', model, '--output-format', 'json', '--strict-mcp-config', '--setting-sources', 'project', '--allowedTools', 'Read(./**) Glob', '--disallowedTools', DENIED,
];

export function resultText(stdout: string): string {
  const answer = JSON.parse(stdout) as { result?: unknown; is_error?: unknown };
  if (answer.is_error === true || typeof answer.result !== 'string') throw new Error(`claude -p failed: ${String(answer.result ?? 'no result')}`);
  return answer.result;
}

export async function runClaude(run: Run, args: string[], cwd: string, timeoutMs: number): Promise<string> {
  return resultText((await run('claude', args, { cwd, timeoutMs })).stdout);
}

/** A model may wrap its JSON in prose or a fence. */
export function extractJson(text: string, open: '[' | '{'): unknown {
  const close = open === '[' ? ']' : '}';
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  if (start === -1 || end < start) throw new Error(`no JSON ${open}…${close} in the answer`);
  return JSON.parse(text.slice(start, end + 1));
}

function scoreOf(raw: unknown, criterion: Criterion, booted: boolean): Score {
  if (!booted && VISUAL.includes(criterion)) return { score: null, reason: 'did not boot' };
  const score = isRecord(raw) ? raw.score : undefined;
  if (typeof score !== 'number' || !Number.isInteger(score) || score < 1 || score > 10) throw new Error(`the judge's ${criterion} is not a score from 1 to 10`);
  return { score, reason: isRecord(raw) && typeof raw.reason === 'string' ? raw.reason : '' };
}

export function parseJudge(raw: unknown, model: string, booted: boolean): Judge {
  if (!isRecord(raw)) throw new Error('the judge answered no object');
  return { model, scores: Object.fromEntries(CRITERIA.map((c) => [c, scoreOf(raw[c], c, booted)])) as Record<Criterion, Score> };
}
