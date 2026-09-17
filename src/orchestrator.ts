import { randomUUID } from 'node:crypto';
import type { Effect, HiveEvent, HookPayload, RateLimits, Signal, Slot, State, Status, Task, UsageLimits, UsageRule } from './types.js';
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
const SLUG_MAX = 30;
export const SIGNALS: readonly Signal[] = ['green', 'yellow', 'red'];
export const STATUSES: readonly Status[] = ['empty', 'working', 'waiting', 'review'];

export function initialState(maxConcurrent: number): State {
  return {
    signal: 'green', maxConcurrent, slots: Array.from({ length: maxConcurrent }, emptySlot), queue: [], usage: [], budget: {},
    usageRules: [],
  };
}

/** The one gate every spawn goes through: green, a free slot that is not draining, and room under the cap when there is one. */
export function canStart(signal: Signal, slots: Slot[], limit?: number): boolean {
  if (signal !== 'green' || !slots.some((s) => s.status === 'empty' && !s.draining)) return false;
  return limit === undefined || slots.filter((s) => s.status !== 'empty').length < limit;
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

function kebab(text: string): string {
  return text
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function slugFor(task: Task): string {
  const title = kebab(task.title).slice(0, SLUG_MAX).replace(/-+$/, '');
  return `hive-${kebab(task.id)}-${title}`;
}

/** The only blocking rule: the adapter already filtered the list down to blockers that are still open. */
export function isBlocked(task: Task): boolean {
  return (task.blockedBy?.length ?? 0) > 0;
}

export function extractPrUrl(command: string, response: unknown): string | undefined {
  if (!command.includes('gh pr create')) return undefined;
  const text = typeof response === 'string' ? response : JSON.stringify(response ?? '');
  return text.match(PR_URL)?.[0];
}

export function reduce(state: State, event: HiveEvent): Reduced {
  switch (event.type) {
    case 'boot': return boot(state); // no fill: bootHive polls right after, and the board is the truth; opens under yellow unless a saved red wins
    case 'poll': return fill(poll(state, event.tasks)); // also where a dynamic red ages out: samples leave the window with time
    case 'setMax': return fill(setMax(state, event.max));
    case 'setSignal': return fill(setSignal(state, event.signal));
    case 'setBudget': return fill(none({ ...state, budget: event.budget })); // raising the limit can open a job right away
    case 'setUsageRules': return fill(setUsageRules(state, event.usageRules));
    case 'hook': return applyHook(state, event.workerId, event.payload, event.branch, event.tokens);
    case 'exit': return fill(exit(state, event.workerId));
    case 'kill': {
      const slot = state.slots.find((s) => s.id === event.slotId);
      return { state, effects: slot?.slug && slot.workerId ? [{ type: 'kill', slug: slot.slug, workerId: slot.workerId }] : [] };
    }
    case 'error': return { state: { ...state, error: event.message }, effects: [] };
    case 'rateLimits': return setRateLimits(state, event.workerId, event.rateLimits); // display only: no fill, no effects
    case 'boardQuota': return none({ ...state, boardQuota: event.quota }); // display and timer backoff only: no fill, no effects
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

// Account-wide data, but only a live worker feeds it, as with hooks. Nothing here gates a spawn: signal and budget stay item 6's.
function setRateLimits(state: State, workerId: string, rateLimits: RateLimits): Reduced {
  const slot = state.slots.find((s) => s.workerId === workerId);
  return !slot || slot.status === 'empty' ? none(state) : none({ ...state, rateLimits });
}

function fill(reduced: Reduced): Reduced {
  const { state, effects } = reduced;
  const now = Date.now();
  if (!canSchedule(state, now)) return reduced; // nothing could start: whatever happened stands
  const { signal, maxWorkers } = limits(state, now);
  let queue = state.queue;
  let slots = state.slots;
  const spawned: Effect[] = [];
  // The gate is re-checked before every spawn against the slots as they stand, so the cap counts what was just opened.
  for (let i = 0; i < slots.length && canStart(signal, slots, maxWorkers); i += 1) {
    const slot = slots[i];
    if (slot.status !== 'empty' || slot.draining) continue;
    const index = queue.findIndex((t) => !isBlocked(t)); // first free task in board order; blocked ones keep their place
    if (index < 0) break;
    const task = queue[index];
    queue = queue.filter((_, j) => j !== index);
    const next: Slot = {
      id: slot.id, workerId: randomUUID(), status: 'working', task, slug: slugFor(task),
      startedAt: new Date().toISOString(), lastEvent: { kind: 'starting' },
    };
    slots = slots.map((s, j) => (j === i ? next : s));
    spawned.push({ type: 'setStatus', itemId: task.itemId, key: 'working' }, { type: 'spawn', slot: next });
  }
  return { state: { ...state, slots, queue }, effects: [...effects, ...spawned] };
}

function poll(state: State, tasks: Task[]): Reduced {
  const inSlot = new Set(state.slots.map((s) => s.task?.itemId));
  return none(releasePaused({
    ...state, queue: tasks.filter((t) => !inSlot.has(t.itemId)),
    lastPolledAt: new Date().toISOString(), error: undefined,
  }));
}

function setMax(state: State, max: number): Reduced {
  const occupiedCount = state.slots.filter((s) => s.status !== 'empty').length;
  const room = Math.max(0, max - occupiedCount);
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

function setSignal(state: State, signal: Signal): Reduced {
  return none(releasePaused({ ...state, signal }));
}

function setUsageRules(state: State, usageRules: UsageRule[]): Reduced {
  return none(releasePaused({ ...state, usageRules }));
}

// Leaving red (manual or dynamic) releases every paused mark. The Hive never types in a worker's terminal: this mark is all it releases.
function releasePaused(state: State): State {
  if (!state.slots.some((s) => s.paused) || limits(state, Date.now()).signal === 'red') return state;
  return { ...state, slots: state.slots.map((s) => ({ ...s, paused: undefined })) };
}

function exit(state: State, workerId: string): Reduced {
  const slot = state.slots.find((s) => s.workerId === workerId);
  if (!slot || slot.status === 'empty') return none(state);
  const requeue = slot.task && !slot.prUrl ? slot.task : undefined;
  const slots = slot.draining
    ? state.slots.filter((s) => s.workerId !== workerId)
    : state.slots.map((s) => (s.workerId === workerId ? { id: s.id, status: 'empty' as Status } : s));
  return {
    state: { ...state, slots, queue: requeue ? [...state.queue, requeue] : state.queue },
    effects: requeue ? [{ type: 'setStatus', itemId: requeue.itemId, key: 'queue' }] : [],
  };
}

// Workers are children of the Hive: none survives a restart, so every occupied slot is given as dead.
// Every boot opens under yellow so nothing new is dispatched before the user looks; a saved red is
// manual mode and survives the restart.
function boot(state: State): Reduced {
  const signal = state.signal === 'red' ? 'red' : 'yellow';
  return state.slots
    .flatMap((s) => (s.status !== 'empty' && s.workerId ? [s.workerId] : []))
    .reduce<Reduced>((r, workerId) => {
      const next = exit(r.state, workerId);
      return { state: next.state, effects: [...r.effects, ...next.effects] };
    }, none({ ...state, signal }));
}

function describeTool(p: HookPayload): string {
  const input = (p.tool_input ?? {}) as Record<string, unknown>;
  const detail = String(input.command ?? input.file_path ?? input.pattern ?? '').slice(0, 60);
  const name = p.tool_name ?? 'tool';
  return detail ? `${name}: ${detail}` : name;
}

function activeStatus(slot: Slot): Status {
  return slot.prUrl ? 'review' : 'working';
}

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
  // Only the server sets `tokens` (Stop / SessionEnd): the sample lands first, then the event applies on top of it
  const state = tokens === undefined ? initial : recordUsage(initial, slot, tokens);
  switch (p.hook_event_name) {
    case 'SessionStart': // the transcript path is kept only when it is what Claude Code sends: an absolute .jsonl
      return patch(state, workerId, { worktree: p.cwd, branch, transcriptPath: isTranscriptPath(p.transcript_path) ? p.transcript_path : undefined });
    case 'UserPromptSubmit':
      return patch(state, workerId, { status: activeStatus(slot), question: undefined, paused: undefined, lastEvent: { kind: 'prompt' } });
    case 'PreToolUse':
      return patch(state, workerId, { status: activeStatus(slot), question: undefined, paused: undefined, lastEvent: { kind: 'tool', detail: describeTool(p) } });
    case 'Notification': {
      const kind = String(p.notification_type ?? '');
      if (!WAITING_NOTIFICATIONS.includes(kind)) return none(state);
      return patch(state, workerId, { status: 'waiting', question: String(p.message ?? kind), lastEvent: { kind: 'waiting', detail: kind } });
    }
    case 'PostToolUse': {
      const command = String((p.tool_input as { command?: unknown } | undefined)?.command ?? '');
      const prUrl = extractPrUrl(command, p.tool_response);
      if (!prUrl) return none(state);
      const patched = patch(state, workerId, { status: 'review', prUrl, question: undefined, lastEvent: { kind: 'pr' } });
      return { ...patched, effects: slot.task ? [{ type: 'setStatus', itemId: slot.task.itemId, key: 'review' }] : [] };
    }
    case 'Stop':
      // Red (by hand or by usage, this turn's sample included) is manual mode: the worker stops by itself at the end of
      // the turn; the mark says it stopped under red
      return patch(state, workerId, {
        status: activeStatus(slot), question: undefined,
        ...(limits(state, Date.now()).signal === 'red' ? { paused: true, lastEvent: { kind: 'paused' } } : { lastEvent: { kind: 'turn' } }),
      });
    case 'SessionEnd':
      return fill(exit(state, workerId));
    default:
      return none(state);
  }
}
