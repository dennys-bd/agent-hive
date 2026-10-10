import type { Run } from './exec.js';
import type { Scenario } from './seed.js';
import { type Click, CRITERIA, type Criterion, type Judge, type Score } from './types.js';

export const TESTER_MODEL = 'sonnet'; // the spec fixes only the judge's model
export const TESTER_TIMEOUT_MS = 120 * 60_000; // fourteen scenarios and up to twelve screens
export const JUDGE_TIMEOUT_MS = 30 * 60_000;
const DENIED = 'Bash Edit Write NotebookEdit WebFetch WebSearch';
// The tester works in a bare temp folder and needs only the browser: no file tool reaches the state folder or the home from it
const TESTER_DENIED = `${DENIED} Read Glob Grep`;
// What @playwright/mcp 0.0.83 exposes, minus evaluate, run code, file upload, install and the cookie, storage and network tools: the cookie is the dashboard's secret
const TESTER_TOOLS = ['navigate', 'navigate_back', 'click', 'hover', 'type', 'fill_form', 'press_key', 'select_option', 'snapshot', 'take_screenshot', 'wait_for', 'resize'].map((name) => `mcp__playwright__browser_${name}`).join(' ');
const VISUAL: readonly Criterion[] = ['fidelity', 'behaviour'];
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export const testerArgs = (prompt: string, mcpConfig: string): string[] => [
  '-p', prompt, '--model', TESTER_MODEL, '--output-format', 'json', '--mcp-config', mcpConfig, '--strict-mcp-config', '--setting-sources', 'project', '--allowedTools', TESTER_TOOLS, '--disallowedTools', TESTER_DENIED,
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

function clickOf(raw: unknown, id: string): Click {
  if (!isRecord(raw)) return { scenario: id, passed: false, notes: 'not reported by the tester', screenshots: [] };
  const shots: unknown[] = Array.isArray(raw.screenshots) ? raw.screenshots : [];
  return { scenario: id, passed: raw.passed === true, notes: typeof raw.notes === 'string' ? raw.notes : '', screenshots: shots.filter((s): s is string => typeof s === 'string') };
}

export function parseClicks(raw: unknown, scenarios: readonly Scenario[]): Click[] {
  const list: unknown[] = Array.isArray(raw) ? raw : [];
  return scenarios.map((s) => clickOf(list.find((c) => isRecord(c) && c.scenario === s.id), s.id));
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
