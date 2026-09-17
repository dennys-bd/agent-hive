import { randomUUID } from 'node:crypto';
import { candidates, cardId, cardOf, columnOf, isBlocked, mergeCards, nextColumn } from './cards.js';
import type { BoardCard, Card, Column, Effect, HiveEvent, HookPayload, RateLimits, Signal, Slot, SlotEventKind, State, Status, UsageLimits } from './types.js';
import { hasBudget, isTranscriptPath, pruneUsage } from './usage.js';
import { applyUsageRules, worstSignal } from './usage-rules.js';

export interface Reduced {
  state: State;
  effects: Effect[];
}

export const WAITING_NOTIFICATIONS: readonly string[] = [
  'permission_prompt', 'idle_prompt', 'agent_needs_input', 'elicitation_dialog', 'elicitation_url_dialog',
];
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;
export const SESSION_ID = /^[A-Za-z0-9_-]{8,64}$/; // Claude Code uses uuids; anything else came from another local process
export const SIGNALS: readonly Signal[] = ['green', 'yellow', 'red'];
export const STATUSES: readonly Status[] = ['empty', 'working', 'waiting', 'review'];

export function initialState(maxConcurrent: number): State {
  return {
    signal: 'green', maxConcurrent, slots: Array.from({ length: maxConcurrent }, emptySlot), columns: [], cards: [], usage: [], budget: {},
    usageRules: [],
  };
}

/** A free slot for the gate and for a manual start: empty and not draining. */
export function isFree(slot: Slot): boolean {
  return slot.status === 'empty' && !slot.draining;
}

const occupiedCount = (slots: Slot[]): number => slots.filter((s) => s.status !== 'empty').length;

/** The one gate every automatic spawn goes through: green, a free slot that is not draining, and room under the cap when there is one. */
export function canStart(signal: Signal, slots: Slot[], limit?: number): boolean {
  if (signal !== 'green' || !slots.some(isFree)) return false;
  return limit === undefined || occupiedCount(slots) < limit;
}

/** Effective signal and worker cap: the manual signal and the usage rules can only restrict each other, never loosen. */
function limits(state: State, now: number): UsageLimits {
  const dyn = applyUsageRules(state.usage, state.budget, state.usageRules, now);
  return {
    signal: worstSignal(state.signal, dyn.signal),
    ...(dyn.maxWorkers === undefined ? {} : { maxWorkers: Math.min(state.maxConcurrent, dyn.maxWorkers) }),
  };
}

/** Whether a job could start right now: token budget with balance and `canStart` under the effective signal and cap. */
export function canSchedule(state: State, now: number): boolean {
  const { signal, maxWorkers } = limits(state, now);
  return hasBudget(state.usage, state.budget, now) && canStart(signal, state.slots, maxWorkers);
}

export function extractPrUrl(command: string, response: unknown): string | undefined {
  if (!command.includes('gh pr create')) return undefined;
  const text = typeof response === 'string' ? response : JSON.stringify(response ?? '');
  return text.match(PR_URL)?.[0];
}

/** Any local process can hit /hooks/event and the id reaches the panel and the log: only a plain id of a sane length is kept. */
export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID.test(value);
}

/** A hook is from a subagent or teammate, not the worker's own top-level turn, when the slot already recorded a
 * session id (from its first SessionStart) and this payload carries a different, well-formed one. A missing or
 * malformed payload id, or a slot that never recorded one, is today's behaviour: treated as the main session (#24). */
export function isChildSession(slot: Slot | undefined, payload: HookPayload): boolean {
  return isSessionId(slot?.sessionId) && isSessionId(payload.session_id) && payload.session_id !== slot.sessionId;
}

export function reduce(state: State, event: HiveEvent): Reduced {
  switch (event.type) {
    case 'boot': return boot(state); // no fill: bootHive polls right after, and the board is the truth; opens under yellow unless a saved red wins
    case 'poll': return fill(poll(state, event.cards)); // also where a dynamic red ages out: samples leave the window with time
    case 'setMax': return fill(setMax(state, event.max));
    case 'setSignal': return fill(none({ ...state, signal: event.signal }));
    case 'setBudget': return fill(none({ ...state, budget: event.budget })); // raising the limit can open a job right away
    case 'setUsageRules': return fill(none({ ...state, usageRules: event.usageRules }));
    case 'setColumns': return fill(setColumns(state, event.columns));
    case 'hook': return applyHook(state, event.workerId, event.payload, event.branch, event.tokens);
    case 'exit': return fill(exit(state, event.workerId));
    case 'kill': return killSlot(state, event.slotId);
    case 'error': return { state: { ...state, error: event.message }, effects: [] };
    case 'rateLimits': return setRateLimits(state, event.workerId, event.rateLimits); // display only: no fill, no effects
    case 'boardQuota': return none({ ...state, boardQuota: event.quota }); // display and timer backoff only: no fill, no effects
    case 'start': return start(state, event.itemId, event.raiseMax === true); // no fill: nothing loosened, so nothing else could open
    case 'closeCard': return fill(closeCard(state, event.cardId));
    case 'keepCard': return fill(keepCard(state, event.cardId));
  }
}

function emptySlot(): Slot {
  return { id: randomUUID(), status: 'empty' };
}

function none(state: State): Reduced {
  return { state, effects: [] };
}

function patch(state: State, workerId: string, changes: Partial<Slot>): Reduced {
  return none({ ...state, slots: state.slots.map((s) => (s.workerId === workerId ? { ...s, ...changes } : s)) });
}

const withCard = (state: State, card: Card): State => ({ ...state, cards: state.cards.map((c) => (cardId(c) === cardId(card) ? card : c)) });
const dropSlot = ({ slotId: _slotId, ...card }: Card): Card => card;

const freeSlot = (slots: Slot[], slot: Slot): Slot[] =>
  (slot.draining ? slots.filter((s) => s.id !== slot.id) : slots.map((s) => (s.id === slot.id ? { id: s.id, status: 'empty' as Status } : s)));

// Account-wide data. From a worker it needs a live slot, as with hooks (any local process can post to the route); the Hive's own
// reading never passes through a route, so it is always kept. Nothing here gates a spawn: signal and budget stay item 6's.
function setRateLimits(state: State, workerId: string | undefined, rateLimits: RateLimits): Reduced {
  if (workerId === undefined) return none({ ...state, rateLimits });
  const slot = state.slots.find((s) => s.workerId === workerId);
  return !slot || slot.status === 'empty' ? none(state) : none({ ...state, rateLimits });
}

// Whether the board must be told: a target that differs from what the board shows, for a card the board still has.
const shouldWrite = (card: Card, target: string | undefined): target is string =>
  target !== undefined && target !== card.boardColumn && !card.orphan && !card.missing;

// Runs `card` in `slots[index]`: the session policy is resolved here (continue needs an id to resume; without one the run is new,
// with an id the Hive generates so it never waits for the hook), onStart is written when the board does not show it yet, then the spawn.
function occupy(state: State, index: number, card: Card, column: Column, kind: SlotEventKind): Reduced {
  const slot: Slot = { id: state.slots[index].id, workerId: randomUUID(), cardId: cardId(card), status: 'working', startedAt: new Date().toISOString(), lastEvent: { kind } };
  const session = column.session === 'continue' && card.sessionId !== undefined ? 'continue' : 'new';
  const { onStart } = column;
  const write = shouldWrite(card, onStart);
  const started: Card = { ...card, slotId: slot.id, sessionId: session === 'continue' ? card.sessionId : randomUUID(), ...(write ? { boardColumn: onStart } : {}) };
  return {
    state: withCard({ ...state, slots: state.slots.map((s, i) => (i === index ? slot : s)) }, started),
    effects: [...(write ? [{ type: 'setColumn' as const, itemId: cardId(card), column: onStart }] : []), { type: 'spawn', slot, card: started, column, session }],
  };
}

function fill(reduced: Reduced): Reduced {
  const now = Date.now();
  if (!canSchedule(reduced.state, now)) return reduced; // nothing could start: whatever happened stands
  const { signal, maxWorkers } = limits(reduced.state, now);
  let { state } = reduced;
  const spawned: Effect[] = [];
  // The gate is re-checked before every spawn against the slots as they stand, so the cap counts what was just opened.
  for (let i = 0; i < state.slots.length && canStart(signal, state.slots, maxWorkers); i += 1) {
    if (!isFree(state.slots[i])) continue;
    const card = candidates(state.cards, state.columns)[0];
    const column = card && columnOf(state.columns, card.column);
    if (!card || !column) break;
    const next = occupy(state, i, card, column, 'starting');
    state = next.state;
    spawned.push(...next.effects);
  }
  return { state, effects: [...reduced.effects, ...spawned] };
}

// The human override: no signal, cap or budget check; the card runs in the column it is in. Unknown, running, missing or blocked
// card, a column without prompt, or no free slot without raiseMax: unchanged. With raiseMax the new max is occupied + 1, not
// maxConcurrent + 1: with slots draining the cap sits below the occupied count and +1 on it would open nothing (#47).
function start(state: State, itemId: string, raiseMax: boolean): Reduced {
  const card = state.cards.find((c) => cardId(c) === itemId);
  const column = card && columnOf(state.columns, card.column);
  if (!card || !column?.prompt || card.slotId !== undefined || card.missing || isBlocked(card.task)) return none(state);
  const hasFree = state.slots.some(isFree);
  if (!hasFree && !raiseMax) return none(state);
  const base = hasFree ? state : setMax(state, occupiedCount(state.slots) + 1).state;
  const index = base.slots.findIndex(isFree);
  return index < 0 ? none(state) : occupy(base, index, card, column, 'manualStart'); // never throws: a reducer that throws takes the route with it
}

function poll(state: State, listed: BoardCard[]): Reduced {
  return none({ ...state, cards: mergeCards(state.cards, state.columns, listed), lastPolledAt: new Date().toISOString(), error: undefined });
}

// A stopped card whose column vanished has nowhere to be shown or run: the next poll re-enters it through a `from` if the board still
// has it. A running one keeps its slot and leaves at its Stop (unknown column: no write, no next).
function setColumns(state: State, columns: Column[]): Reduced {
  return none({ ...state, columns, cards: state.cards.filter((c) => c.slotId !== undefined || columnOf(columns, c.column) !== undefined) });
}

function setMax(state: State, max: number): Reduced {
  const occupied = occupiedCount(state.slots);
  const room = Math.max(0, max - occupied);
  let occupiedSeen = 0;
  let emptyKept = 0;
  const kept = state.slots.flatMap<Slot>((s) => {
    if (s.status !== 'empty') {
      const draining = occupiedSeen++ >= max;
      return [draining ? { ...s, draining: true } : { ...s, draining: undefined }];
    }
    if (emptyKept >= room) return [];
    emptyKept += 1;
    return [s];
  });
  const extra = Array.from({ length: room - emptyKept }, emptySlot);
  return none({ ...state, maxConcurrent: max, slots: [...kept, ...extra] });
}

// The run did not end through Stop (kill, closed tab, crash, boot): the slot frees, the card stays where it is and the board is not told.
function exit(state: State, workerId: string): Reduced {
  const slot = state.slots.find((s) => s.workerId === workerId);
  if (!slot || slot.status === 'empty') return none(state);
  const card = cardOf(state.cards, slot);
  const stopped = card === undefined ? state : withCard(state, dropSlot(card));
  return none({ ...stopped, slots: freeSlot(state.slots, slot) });
}

// The end of the command: the session dies, the board learns the outcome, the card moves on (or leaves after the last column).
function finish(state: State, workerId: string): Reduced {
  const slot = state.slots.find((s) => s.workerId === workerId);
  const card = slot && cardOf(state.cards, slot);
  if (!slot || !card) return exit(state, workerId);
  const column = columnOf(state.columns, card.column);
  const write = shouldWrite(card, column?.onFinish);
  const next = column && nextColumn(state.columns, column.name);
  const moved: Card = { ...dropSlot(card), column: next?.name ?? card.column, ...(write ? { boardColumn: column?.onFinish as string } : {}) };
  const cards = next ? state.cards.map((c) => (cardId(c) === cardId(card) ? moved : c)) : state.cards.filter((c) => cardId(c) !== cardId(card));
  return {
    state: { ...state, slots: freeSlot(state.slots, slot), cards },
    effects: [{ type: 'kill', slug: card.slug, workerId }, ...(write ? [{ type: 'setColumn' as const, itemId: cardId(card), column: column?.onFinish as string }] : [])],
  };
}

function killSlot(state: State, slotId: string): Reduced {
  const slot = state.slots.find((s) => s.id === slotId);
  const card = slot && cardOf(state.cards, slot);
  return { state, effects: card && slot.workerId ? [{ type: 'kill', slug: card.slug, workerId: slot.workerId }] : [] };
}

// The user's answer to a card that left the board. Close: the card goes, its session with it. Keep: it runs to the end on its own.
function closeCard(state: State, id: string): Reduced {
  const card = state.cards.find((c) => cardId(c) === id);
  if (!card?.missing) return none(state);
  const slot = state.slots.find((s) => s.id === card.slotId);
  return {
    state: { ...state, cards: state.cards.filter((c) => c !== card), slots: slot ? freeSlot(state.slots, slot) : state.slots },
    effects: slot?.workerId ? [{ type: 'kill', slug: card.slug, workerId: slot.workerId }] : [],
  };
}

function keepCard(state: State, id: string): Reduced {
  const card = state.cards.find((c) => cardId(c) === id);
  if (!card?.missing) return none(state);
  const { missing: _missing, ...rest } = card;
  return none(withCard(state, { ...rest, orphan: true }));
}

// Workers are children of the Hive: none survives a restart, so every occupied slot is given as dead. Every boot opens under
// yellow so nothing new is dispatched before the user looks; a saved red is manual mode and survives the restart.
function boot(state: State): Reduced {
  const signal = state.signal === 'red' ? 'red' : 'yellow';
  return state.slots
    .flatMap((s) => (s.status !== 'empty' && s.workerId ? [s.workerId] : []))
    .reduce<Reduced>((r, workerId) => exit(r.state, workerId), none({ ...state, signal }));
}

function describeTool(p: HookPayload): string {
  const input = (p.tool_input ?? {}) as Record<string, unknown>;
  const detail = String(input.command ?? input.file_path ?? input.pattern ?? '').slice(0, 60);
  const name = p.tool_name ?? 'tool';
  return detail ? `${name}: ${detail}` : name;
}

const activeStatus = (card: Card | undefined): Status => (card?.prUrl ? 'review' : 'working');

// One sample per turn: the delta against the total seen at this worker's previous turn end. A smaller total means the
// transcript was replaced, so the whole new total counts. A delta of 0 adds nothing; pruning happens on insert.
function recordUsage(state: State, slot: Slot, tokens: number): State {
  const previous = slot.tokens ?? 0;
  const delta = tokens >= previous ? tokens - previous : tokens;
  const now = new Date();
  const slots = state.slots.map((s) => (s.workerId === slot.workerId ? { ...s, tokens } : s));
  const usage = delta > 0 ? pruneUsage([...state.usage, { at: now.toISOString(), tokens: delta }], now.getTime()) : state.usage;
  return { ...state, slots, usage };
}

function applyHook(initial: State, workerId: string, p: HookPayload, branch?: string, tokens?: number): Reduced {
  const slot = initial.slots.find((s) => s.workerId === workerId);
  if (!slot || slot.status === 'empty') return none(initial);
  // A Stop / SessionEnd from a subagent or teammate is not the worker's turn end: skip before the token sample lands (#24)
  if ((p.hook_event_name === 'Stop' || p.hook_event_name === 'SessionEnd') && isChildSession(slot, p)) return none(initial);
  const state = tokens === undefined ? initial : recordUsage(initial, slot, tokens); // only the server sets tokens (Stop / SessionEnd)
  const card = cardOf(state.cards, slot);
  switch (p.hook_event_name) {
    case 'SessionStart': { // the transcript path is kept only when it is what Claude Code sends: an absolute .jsonl; the first session id wins (#24)
      const patched = patch(state, workerId, {
        transcriptPath: isTranscriptPath(p.transcript_path) ? p.transcript_path : undefined,
        sessionId: slot.sessionId ?? (isSessionId(p.session_id) ? p.session_id : undefined),
      });
      return card ? none(withCard(patched.state, { ...card, worktree: p.cwd, branch })) : patched;
    }
    case 'UserPromptSubmit':
      return patch(state, workerId, { status: activeStatus(card), question: undefined, lastEvent: { kind: 'prompt' } });
    case 'PreToolUse':
      return patch(state, workerId, { status: activeStatus(card), question: undefined, lastEvent: { kind: 'tool', detail: describeTool(p) } });
    case 'Notification': {
      const kind = String(p.notification_type ?? '');
      if (!WAITING_NOTIFICATIONS.includes(kind)) return none(state);
      return patch(state, workerId, { status: 'waiting', question: String(p.message ?? kind), lastEvent: { kind: 'waiting', detail: kind } });
    }
    case 'PostToolUse': {
      const prUrl = extractPrUrl(String((p.tool_input as { command?: unknown } | undefined)?.command ?? ''), p.tool_response);
      if (!prUrl || !card) return none(state);
      return none(withCard(patch(state, workerId, { status: 'review', question: undefined, lastEvent: { kind: 'pr' } }).state, { ...card, prUrl }));
    }
    case 'Stop': return fill(finish(state, workerId)); // the end of the turn is the end of the command
    case 'SessionEnd': return fill(exit(state, workerId));
    default: return none(state);
  }
}
