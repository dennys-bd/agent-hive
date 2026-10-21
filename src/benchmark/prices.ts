// The model prices (#473): USD per million tokens by model id, the providers' published prices for the models the agents run. A constant,
// not a setting (a settings candidate of the decomposition's root design): a change prices the runs measured after it, never one measured before.
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { addTokens, finite } from '../agents/jsonl.js';
import { type Tokens, ZERO_TOKENS } from '../facts.js';
import { isJsonObject } from '../state-guards.js';
import { USAGE_FILE } from '../usage-store.js';

export interface Price { input: number; output: number; cache_write: number; cache_read: number } // USD per million tokens

// Checked 2026-10-21 against the Claude API pricing page (platform.claude.com/docs/en/about-claude/pricing) as mirrored by the claude-api skill
// (model table cached 2026-10-06; cache rules in its prompt-caching guide). cache_write is the 5-minute write rate (1.25x input), the TTL
// Claude Code writes with by default. cache_read is the published rate for opus-5-5 ($0.20) and fable-5-1 ($0.25); for sonnet-5-5 and
// haiku-5-5 it is the guide's general 0.1x input rule: recheck both on the pricing page.
// Codex/OpenAI models are left out on purpose: their prices were not verified. Check https://openai.com/api/pricing and add each model id
// found in `tokens_by_model` of a real usage.sqlite (cache_write equals input there). Until then they are listed in `unpriced`.
export const PRICES: Readonly<Record<string, Price>> = {
  'claude-fable-5-1': { input: 10, output: 50, cache_write: 12.5, cache_read: 0.25 },
  'claude-opus-5-5': { input: 4, output: 20, cache_write: 5, cache_read: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cache_write: 2.5, cache_read: 0.2 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cache_write: 0.125, cache_read: 0.01 },
};

const PER_MILLION = 1_000_000;
const TOKEN_TYPES = ['input', 'output', 'cache_write', 'cache_read'] as const;
const STAGE_ENDED = `SELECT data FROM records WHERE event = 'stage.ended'`;

// A model's own entry, else the longest table id it extends with a dash: a dated `<id>-20261001` is `<id>`, and `claude-opus-5-50` is
// never `claude-opus-5-5`. `unknown` (a response that named no model) matches nothing
function priceOf(model: string, table: Readonly<Record<string, Price>>): Price | undefined {
  if (Object.hasOwn(table, model)) return table[model];
  const base = Object.keys(table).filter((id) => model.startsWith(`${id}-`)).sort((a, b) => b.length - a.length)[0];
  return base === undefined ? undefined : table[base];
}

const usdOf = (tokens: Tokens, price: Price): number => TOKEN_TYPES.reduce((sum, type) => sum + (tokens[type] * price[type]) / PER_MILLION, 0);

/** The cost of a usage split by model (#473); a model off the table costs 0 and is listed in `unpriced` (`sem preço para <model>`). */
export function costOf(byModel: Record<string, Tokens>, table: Readonly<Record<string, Price>> = PRICES): { usd: number; unpriced: string[] } {
  const priced = Object.entries(byModel).map(([model, tokens]) => ({ model, tokens, price: priceOf(model, table) }));
  const usd = priced.reduce((sum, { tokens, price }) => sum + (price === undefined ? 0 : usdOf(tokens, price)), 0);
  return { usd, unpriced: priced.filter((p) => p.price === undefined).map((p) => p.model) };
}

const parsedJson = (text: unknown): unknown => {
  if (typeof text !== 'string') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined; // a row the store wrote is JSON; anything else adds nothing
  }
};

const tokensOf = (value: unknown): Tokens | undefined =>
  isJsonObject(value) ? { input: finite(value.input), output: finite(value.output), cache_write: finite(value.cache_write), cache_read: finite(value.cache_read) } : undefined;

// A Map, so a model named __proto__ sums as a key and never touches the prototype; Object.fromEntries defines own properties
function addRow(sum: Map<string, Tokens>, data: unknown): void {
  const row = parsedJson(data);
  const byModel = isJsonObject(row) && isJsonObject(row.tokens_by_model) ? row.tokens_by_model : {};
  for (const [model, raw] of Object.entries(byModel)) {
    const tokens = tokensOf(raw);
    if (tokens !== undefined) sum.set(model, addTokens(sum.get(model) ?? ZERO_TOKENS, tokens));
  }
}

/** Every stage run's tokens per model in a run's home (#271's usage.sqlite), subagents included. node:sqlite is imported here, as
 *  usage-store.ts does, so its warning stays in the process that reads. A missing or unopenable store reads as none: the run costs 0, never fails. */
export async function readModelTokens(home: string): Promise<Record<string, Tokens>> {
  let db: DatabaseSync | undefined;
  try {
    const { DatabaseSync: Database } = await import('node:sqlite');
    db = new Database(join(home, USAGE_FILE), { readOnly: true }); // read-only: never creates the file, never writes the daemon's store
    const sum = new Map<string, Tokens>();
    for (const row of db.prepare(STAGE_ENDED).all()) addRow(sum, row.data);
    return Object.fromEntries(sum);
  } catch {
    return {};
  } finally {
    db?.close();
  }
}
