import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LOG_LEVELS, type LogLevel } from './log.js';
import { LANGUAGES } from './language.js';
import { SIGNALS } from './orchestrator.js';
import type { BoardConfig, Budget, Config, EpicsMode, Language, Signal, StatusKey, UsageRule, WorkersMode } from './types.js';

export const CONFIG_FILE = 'hive.config.json';

export const BOARD_TYPES: readonly BoardConfig['type'][] = ['github', 'markdown'];
export const WORKERS_MODES: readonly WorkersMode[] = ['embedded', 'iterm'];
export const EPICS_MODES: readonly EpicsMode[] = ['ignore', 'queue'];

export const DEFAULT_CONFIG: Omit<Config, 'board'> = {
  workers: 'embedded',
  epics: 'ignore',
  logLevel: 'info',
  status: { queue: 'Ready', working: 'In progress', review: 'In review' },
  maxConcurrent: 2,
  port: 47821,
  claudeArgs: [],
  promptTemplate:
    'Task #{number}: {title}\n\n{body}\n\nWork on this branch. When the task is done, open a PR with `gh pr create`.',
  budget: {},
  usageRules: [],
};

const STATUS_KEYS: StatusKey[] = ['queue', 'working', 'review'];
const MARKDOWN_CELL_BREAKERS = /[|\r\n]/; // written into a table cell, these would split or end the row
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
function parseBoard(raw: unknown, field: string): BoardConfig {
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

export function parseConfig(raw: unknown): Config {
  if (!isRecord(raw)) throw new Error(`${CONFIG_FILE}: root must be an object`);
  const board = boardFrom(raw);

  const statusRaw = optional(raw.status, {} as Record<string, unknown>, (v) => {
    if (!isRecord(v)) throw new Error(`${CONFIG_FILE}: "status" must be an object`);
    return v;
  });
  const status = Object.fromEntries(
    STATUS_KEYS.map((key) => [key, optional(statusRaw[key], DEFAULT_CONFIG.status[key], (v) => requireString(v, `status.${key}`))]),
  ) as Record<StatusKey, string>;
  if (board.type === 'markdown') {
    for (const key of STATUS_KEYS) {
      if (MARKDOWN_CELL_BREAKERS.test(status[key])) {
        throw new Error(`${CONFIG_FILE}: "status.${key}" must not contain "|" or line breaks for markdown boards`);
      }
    }
  }

  return {
    board,
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
    status,
    maxConcurrent: optional(raw.maxConcurrent, DEFAULT_CONFIG.maxConcurrent, (v) => requireInt(v, 'maxConcurrent')),
    port: optional(raw.port, DEFAULT_CONFIG.port, (v) => requireInt(v, 'port')),
    claudeArgs: optional(raw.claudeArgs, DEFAULT_CONFIG.claudeArgs, (v) => {
      if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new Error(`${CONFIG_FILE}: "claudeArgs" must be an array of strings`);
      return v as string[];
    }),
    promptTemplate: optional(raw.promptTemplate, DEFAULT_CONFIG.promptTemplate, (v) => requireString(v, 'promptTemplate')),
    budget: optional(raw.budget, DEFAULT_CONFIG.budget, parseBudget),
    usageRules: optional(raw.usageRules, DEFAULT_CONFIG.usageRules, parseUsageRules),
  };
}

export async function loadConfigIfPresent(repo: string): Promise<Config | undefined> {
  const path = join(repo, CONFIG_FILE);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`${path}: erro de leitura (${(err as Error).message})`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`${path}: JSON inválido (${(err as Error).message})`);
  }
  return parseConfig(raw);
}

export async function loadConfig(repo: string): Promise<Config> {
  const config = await loadConfigIfPresent(repo);
  if (!config) throw new Error(`${CONFIG_FILE} não encontrado em ${repo}`);
  return config;
}
