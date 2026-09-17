// The setup form's state and its pure edges: SetupInfo → draft, draft → validation, draft → SetupBody.
// Strings as typed: the Radix Tabs unmount hidden panels, so native validation cannot reach another tab's fields.
import type { BoardConfig, Column, EpicsMode, Language, SetupBody, SetupInfo, Signal, UsageRule, WorkersMode } from '../../types.js';
import { t } from '../i18n.js';

// id: a per-row React key, generated once when the draft row is created and never sent to the server (toSetupBody
// never spreads the draft, only picks named fields) — lets ColumnEditor/RulesEditor key rows by the row itself
// instead of by screen position, so move/remove never leaves a surviving row showing another row's stale text.
export interface ColumnDraft { id: string; name: string; weight: string; session: 'new' | 'continue'; model: string; from: string[]; onStart: string; onFinish: string; prompt: string }
export interface RuleDraft { id: string; percent: string; maxWorkers: string; signal: Signal | '' }
export interface SetupDraft {
  boardType: BoardConfig['type']; owner: string; project: string; markdownPath: string;
  columns: ColumnDraft[]; language: Language; workers: WorkersMode; epics: EpicsMode;
  budgetHour: string; budgetDay: string; rules: RuleDraft[];
}
export type SetupTab = 'board' | 'general' | 'limits';
export interface SetupProblem { tab: SetupTab; message: string }

const DEFAULT_OWNER = '@me';
const DEFAULT_MARKDOWN_PATH = 'board.md';
const DEFAULT_WEIGHT = '1';
const PERCENT_MAX = 100;

export const emptyColumn = (): ColumnDraft => ({ id: crypto.randomUUID(), name: '', weight: DEFAULT_WEIGHT, session: 'new', model: '', from: [], onStart: '', onFinish: '', prompt: '' });
export const emptyRule = (): RuleDraft => ({ id: crypto.randomUUID(), percent: '', maxWorkers: '', signal: '' });

const numberField = (n?: number): string => (n ? String(n) : ''); // 0 or absent = no limit = empty field
const isNonNegativeInt = (text: string): boolean => /^\d+$/.test(text.trim());

const columnDraft = (c: Column): ColumnDraft => ({
  id: crypto.randomUUID(), name: c.name, weight: String(c.weight), session: c.session ?? 'new', model: c.model ?? '', from: c.from, onStart: c.onStart ?? '', onFinish: c.onFinish ?? '', prompt: c.prompt ?? '',
});
const ruleDraft = (r: UsageRule): RuleDraft => ({ id: crypto.randomUUID(), percent: String(r.percent), maxWorkers: r.maxWorkers === undefined ? '' : String(r.maxWorkers), signal: r.signal ?? '' });

/** Today's defaults (@me, board.md, ignore, embedded, the effective language) under whatever the saved config has. */
export function draftFrom(info?: SetupInfo): SetupDraft {
  const config = info?.config;
  const board = config?.board;
  return {
    boardType: board?.type ?? 'github',
    owner: board?.type === 'github' ? board.owner : DEFAULT_OWNER,
    project: board?.type === 'github' ? String(board.number) : '',
    markdownPath: board?.type === 'markdown' ? board.path : DEFAULT_MARKDOWN_PATH,
    columns: (config?.columns ?? []).map(columnDraft),
    language: info?.language ?? 'en',
    workers: config?.workers ?? 'embedded',
    epics: config?.epics ?? 'ignore',
    budgetHour: numberField(config?.budget.maxTokensPerHour),
    budgetDay: numberField(config?.budget.maxTokensPerDay),
    rules: (config?.usageRules ?? []).map(ruleDraft),
  };
}

function boardProblem(draft: SetupDraft): SetupProblem | undefined {
  if (draft.boardType === 'markdown') return draft.markdownPath.trim() === '' ? { tab: 'board', message: t('setup.error.path') } : undefined;
  return draft.project === '' ? { tab: 'board', message: t('setup.error.project') } : undefined;
}

function columnsProblem(columns: ColumnDraft[]): SetupProblem | undefined {
  if (columns.length === 0) return { tab: 'board', message: t('setup.columns.none') };
  const bad = columns.findIndex((c) => c.name.trim() === '' || !isNonNegativeInt(c.weight));
  return bad === -1 ? undefined : { tab: 'board', message: t('setup.columns.error', { n: bad + 1 }) };
}

function rulesProblem(rules: RuleDraft[]): SetupProblem | undefined {
  const bad = rules.findIndex((r) => (r.maxWorkers === '' && r.signal === '') || !isNonNegativeInt(r.percent) || Number(r.percent) > PERCENT_MAX);
  return bad === -1 ? undefined : { tab: 'limits', message: t('setup.rules.error', { n: bad + 1 }) };
}

function budgetProblem(draft: SetupDraft): SetupProblem | undefined {
  const bad = [draft.budgetHour, draft.budgetDay].some((v) => v.trim() !== '' && !isNonNegativeInt(v));
  return bad ? { tab: 'limits', message: t('setup.budgetHint') } : undefined;
}

/** The first problem in today's order (board, columns, rules, budget) with the tab to reveal; undefined when the server may judge the rest. */
export function validateSetup(draft: SetupDraft): SetupProblem | undefined {
  return boardProblem(draft) ?? columnsProblem(draft.columns) ?? rulesProblem(draft.rules) ?? budgetProblem(draft);
}

const optional = <K extends string>(key: K, value: string): { [P in K]?: string } => (value.trim() === '' ? {} : { [key]: value.trim() }) as { [P in K]?: string };

// Absent keys stay absent (never an explicit undefined), so hive.config.json stays clean; the server validates the rest.
const columnFrom = (c: ColumnDraft): Column => ({
  name: c.name.trim(), weight: Number(c.weight), from: c.from,
  ...(c.session === 'continue' ? { session: 'continue' as const } : {}),
  ...optional('model', c.model), ...optional('onStart', c.onStart), ...optional('onFinish', c.onFinish), ...optional('prompt', c.prompt),
});
const ruleFrom = (r: RuleDraft): UsageRule => ({
  percent: Number(r.percent), ...(r.maxWorkers === '' ? {} : { maxWorkers: Number(r.maxWorkers) }), ...(r.signal === '' ? {} : { signal: r.signal }),
});
const limitFrom = (text: string): number | undefined => (isNonNegativeInt(text) && Number(text) > 0 ? Number(text) : undefined);

function boardFrom(draft: SetupDraft): BoardConfig {
  return draft.boardType === 'markdown'
    ? { type: 'markdown', path: draft.markdownPath.trim() }
    : { type: 'github', owner: draft.owner.trim(), number: Number(draft.project) };
}

export function toSetupBody(draft: SetupDraft): SetupBody {
  const hour = limitFrom(draft.budgetHour);
  const day = limitFrom(draft.budgetDay);
  return {
    board: boardFrom(draft), columns: draft.columns.map(columnFrom), workers: draft.workers, epics: draft.epics,
    budget: { ...(hour ? { maxTokensPerHour: hour } : {}), ...(day ? { maxTokensPerDay: day } : {}) },
    usageRules: draft.rules.map(ruleFrom), language: draft.language,
  };
}

/** GET /setup/columns for the board as drafted; undefined while the board is not chosen (no owner + project, or no path). */
export function columnsUrl(draft: SetupDraft): string | undefined {
  if (draft.boardType === 'markdown') {
    const path = draft.markdownPath.trim();
    return path === '' ? undefined : `/setup/columns?${new URLSearchParams({ type: 'markdown', path })}`;
  }
  const owner = draft.owner.trim();
  if (owner === '' || draft.project === '') return undefined;
  return `/setup/columns?${new URLSearchParams({ type: 'github', owner, number: draft.project })}`;
}
