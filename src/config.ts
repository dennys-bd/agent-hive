import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LOG_LEVELS, type LogLevel } from './log.js';
import { LANGUAGES } from './language.js';
import { SIGNALS } from './orchestrator.js';
import type { BoardConfig, Budget, Column, Config, EpicsMode, Language, Signal, SessionPolicy, UsageRule, WorkersMode } from './types.js';

export const CONFIG_FILE = 'hive.config.json';

export const BOARD_TYPES: readonly BoardConfig['type'][] = ['github', 'markdown'];
export const WORKERS_MODES: readonly WorkersMode[] = ['embedded', 'iterm'];
export const EPICS_MODES: readonly EpicsMode[] = ['ignore', 'queue'];
export const SESSION_POLICIES: readonly SessionPolicy[] = ['new', 'continue'];
export const LEGACY_COLUMN_NAME = 'fila';
/** What a file from before columns existed meant: the one-column pipeline `legacyColumns` proposes. */
export const LEGACY_STATUS: Record<'queue' | 'working' | 'review', string> = { queue: 'Ready', working: 'In progress', review: 'In review' };
export const LEGACY_PROMPT = 'Task #{number}: {title}\n\n{body}\n\nWork on this branch. When the task is done, open a PR with `gh pr create`.';

export const DEFAULT_CONFIG: Omit<Config, 'board' | 'columns'> = {
  workers: 'embedded',
  epics: 'ignore',
  logLevel: 'info',
  maxConcurrent: 2,
  port: 47821,
  claudeArgs: [],
  budget: {},
  usageRules: [],
};

const BUDGET_KEYS = ['maxTokensPerHour', 'maxTokensPerDay'] as const;
const PERCENT_MAX = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${CONFIG_FILE}: "${field}" must be a non-empty string`);
  return value;
}

function requireInt(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`${CONFIG_FILE}: "${field}" must be a non-negative integer`);
  return value as number;
}

function optional<T>(value: unknown, fallback: T, check: (v: unknown) => T): T {
  return value === undefined ? fallback : check(value);
}

// `field` is how the board appears in error messages: "board" for the current format, "project" for legacy files.
export function parseBoard(raw: unknown, field: string): BoardConfig {
  if (!isRecord(raw)) throw new Error(`${CONFIG_FILE}: "${field}" must be an object`);
  switch (raw.type) {
    case 'github':
      return { type: 'github', owner: requireString(raw.owner, `${field}.owner`), number: requireInt(raw.number, `${field}.number`) };
    case 'markdown':
      return { type: 'markdown', path: requireString(raw.path, `${field}.path`) };
    default:
      throw new Error(`${CONFIG_FILE}: "${field}.type" must be one of: ${BOARD_TYPES.join(', ')}`);
  }
}

// Files written before boards were pluggable have `project: { owner, number }` and no `board`.
function boardFrom(raw: Record<string, unknown>): BoardConfig {
  if (raw.board === undefined && isRecord(raw.project)) return parseBoard({ ...raw.project, type: 'github' }, 'project');
  return parseBoard(raw.board, 'board');
}

// Absent keys stay absent (never become 0) so a hive.config.json without limits stays clean.
function parseBudget(raw: unknown): Budget {
  if (!isRecord(raw)) throw new Error(`${CONFIG_FILE}: "budget" must be an object`);
  return Object.fromEntries(
    BUDGET_KEYS.flatMap((key) => (raw[key] === undefined ? [] : [[key, requireInt(raw[key], `budget.${key}`)]])),
  ) as Budget;
}

function requireSignal(value: unknown, field: string): Signal {
  if (!SIGNALS.includes(value as Signal)) throw new Error(`${CONFIG_FILE}: "${field}" must be one of: ${SIGNALS.join(', ')}`);
  return value as Signal;
}

function requireLanguage(value: unknown): Language {
  if (!LANGUAGES.includes(value as Language)) throw new Error(`${CONFIG_FILE}: "language" must be one of: ${LANGUAGES.join(', ')}`);
  return value as Language;
}

function parseUsageRule(raw: unknown, field: string): UsageRule {
  if (!isRecord(raw)) throw new Error(`${CONFIG_FILE}: "${field}" must be an object`);
  const percent = requireInt(raw.percent, `${field}.percent`);
  if (percent > PERCENT_MAX) throw new Error(`${CONFIG_FILE}: "${field}.percent" must be an integer from 0 to ${PERCENT_MAX}`);
  const maxWorkers = raw.maxWorkers === undefined ? undefined : requireInt(raw.maxWorkers, `${field}.maxWorkers`);
  const signal = raw.signal === undefined ? undefined : requireSignal(raw.signal, `${field}.signal`);
  if (maxWorkers === undefined && signal === undefined) throw new Error(`${CONFIG_FILE}: "${field}" must set "maxWorkers" or "signal"`);
  return { percent, ...(maxWorkers === undefined ? {} : { maxWorkers }), ...(signal === undefined ? {} : { signal }) };
}

function parseUsageRules(raw: unknown): UsageRule[] {
  if (!Array.isArray(raw)) throw new Error(`${CONFIG_FILE}: "usageRules" must be an array`);
  return raw.map((rule, i) => parseUsageRule(rule, `usageRules[${i}]`));
}

const optionalString = (value: unknown, field: string): { [k: string]: string } | Record<string, never> =>
  value === undefined ? {} : { [field.split('.').pop() as string]: requireString(value, field) };

function parseColumn(raw: unknown, field: string): Column {
  if (!isRecord(raw)) throw new Error(`${CONFIG_FILE}: "${field}" must be an object`);
  const from = raw.from;
  if (!Array.isArray(from) || !from.every((x) => typeof x === 'string')) throw new Error(`${CONFIG_FILE}: "${field}.from" must be an array of strings`);
  const session = raw.session === undefined ? {} : { session: requireSessionPolicy(raw.session, `${field}.session`) };
  return {
    name: requireString(raw.name, `${field}.name`), weight: requireInt(raw.weight, `${field}.weight`), from: from as string[],
    ...optionalString(raw.prompt, `${field}.prompt`), ...session, ...optionalString(raw.model, `${field}.model`),
    ...optionalString(raw.onStart, `${field}.onStart`), ...optionalString(raw.onFinish, `${field}.onFinish`),
  };
}

function requireSessionPolicy(value: unknown, field: string): SessionPolicy {
  if (!SESSION_POLICIES.includes(value as SessionPolicy)) throw new Error(`${CONFIG_FILE}: "${field}" must be one of: ${SESSION_POLICIES.join(', ')}`);
  return value as SessionPolicy;
}

// Required, non-empty, unique names, and at least one entry point: a pipeline nothing can enter is a config mistake, not a quiet Hive.
function parseColumns(raw: unknown): Column[] {
  if (raw === undefined) throw new Error(`${CONFIG_FILE}: "columns" is required`);
  if (!Array.isArray(raw) || raw.length === 0) throw new Error(`${CONFIG_FILE}: "columns" must be a non-empty array`);
  const columns = raw.map((column, i) => parseColumn(column, `columns[${i}]`));
  columns.forEach((column, i) => {
    if (columns.findIndex((c) => c.name === column.name) !== i) throw new Error(`${CONFIG_FILE}: "columns[${i}].name" must be unique`);
  });
  if (!columns.some((c) => c.from.length > 0)) throw new Error(`${CONFIG_FILE}: "columns" must have at least one column with "from"`);
  return columns;
}

const textOr = (value: unknown, fallback: string): string => (typeof value === 'string' && value !== '' ? value : fallback);

/** The pipeline a file from before columns existed described with `status` + `promptTemplate`: one column, shown prefilled in the setup form. */
export function legacyColumns(raw: Record<string, unknown>): Column[] {
  const status = isRecord(raw.status) ? raw.status : {};
  return [{
    name: LEGACY_COLUMN_NAME, weight: 1, session: 'new', from: [textOr(status.queue, LEGACY_STATUS.queue)],
    onStart: textOr(status.working, LEGACY_STATUS.working), onFinish: textOr(status.review, LEGACY_STATUS.review),
    prompt: textOr(raw.promptTemplate, LEGACY_PROMPT),
  }];
}

/** A file without `columns` as the config it would be with the legacy proposal; undefined when it has columns or cannot be proposed (the caller reports the original error). */
export function legacyConfig(raw: unknown): Config | undefined {
  if (!isRecord(raw) || raw.columns !== undefined) return undefined;
  try {
    return parseConfig({ ...raw, columns: legacyColumns(raw) });
  } catch {
    return undefined; // the rest of the file is broken too: parseConfig(raw) names the field for the caller
  }
}

export function parseConfig(raw: unknown): Config {
  if (!isRecord(raw)) throw new Error(`${CONFIG_FILE}: root must be an object`);
  const board = boardFrom(raw);

  return {
    board,
    columns: parseColumns(raw.columns),
    workers: optional(raw.workers, DEFAULT_CONFIG.workers, (v) => {
      if (!WORKERS_MODES.includes(v as WorkersMode)) throw new Error(`${CONFIG_FILE}: "workers" must be one of: ${WORKERS_MODES.join(', ')}`);
      return v as WorkersMode;
    }),
    epics: optional(raw.epics, DEFAULT_CONFIG.epics, (v) => {
      if (!EPICS_MODES.includes(v as EpicsMode)) throw new Error(`${CONFIG_FILE}: "epics" must be one of: ${EPICS_MODES.join(', ')}`);
      return v as EpicsMode;
    }),
    logLevel: optional(raw.logLevel, DEFAULT_CONFIG.logLevel, (v) => {
      if (!LOG_LEVELS.includes(v as LogLevel)) throw new Error(`${CONFIG_FILE}: "logLevel" must be one of: ${LOG_LEVELS.join(', ')}`);
      return v as LogLevel;
    }),
    ...(raw.language === undefined ? {} : { language: requireLanguage(raw.language) }), // absent stays absent: the system decides
    maxConcurrent: optional(raw.maxConcurrent, DEFAULT_CONFIG.maxConcurrent, (v) => requireInt(v, 'maxConcurrent')),
    port: optional(raw.port, DEFAULT_CONFIG.port, (v) => requireInt(v, 'port')),
    claudeArgs: optional(raw.claudeArgs, DEFAULT_CONFIG.claudeArgs, (v) => {
      if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new Error(`${CONFIG_FILE}: "claudeArgs" must be an array of strings`);
      return v as string[];
    }),
    budget: optional(raw.budget, DEFAULT_CONFIG.budget, parseBudget),
    usageRules: optional(raw.usageRules, DEFAULT_CONFIG.usageRules, parseUsageRules),
  };
}

/** The parsed JSON of hive.config.json, undefined when the file is missing; unreadable or invalid JSON rejects naming the path. */
export async function readConfig(repo: string): Promise<unknown | undefined> {
  const path = join(repo, CONFIG_FILE);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`${path}: erro de leitura (${(err as Error).message})`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${path}: JSON inválido (${(err as Error).message})`);
  }
}

export async function loadConfigIfPresent(repo: string): Promise<Config | undefined> {
  const raw = await readConfig(repo);
  return raw === undefined ? undefined : parseConfig(raw);
}

/** For the setup form: a legacy file reads as its proposal, so a save can keep the columns it does not send. */
export async function loadConfigOrLegacy(repo: string): Promise<Config | undefined> {
  const raw = await readConfig(repo);
  return raw === undefined ? undefined : (legacyConfig(raw) ?? parseConfig(raw));
}

export async function loadConfig(repo: string): Promise<Config> {
  const config = await loadConfigIfPresent(repo);
  if (!config) throw new Error(`${CONFIG_FILE} não encontrado em ${repo}`);
  return config;
}
