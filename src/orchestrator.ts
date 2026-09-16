import { randomUUID } from 'node:crypto';
import type { Effect, HiveEvent, HookPayload, Signal, Slot, State, Status, Task } from './types.js';

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

export function initialState(maxConcurrent: number): State {
  return { signal: 'green', maxConcurrent, slots: Array.from({ length: maxConcurrent }, emptySlot), queue: [] };
}

/** The one gate every spawn goes through: green and at least one free slot that is not draining. */
export function canStart(signal: Signal, slots: Slot[]): boolean {
  return signal === 'green' && slots.some((s) => s.status === 'vazio' && !s.draining);
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
    case 'boot': return boot(state, event.aliveSlugs); // no fill: bootHive polls right after, and the board is the truth
    case 'poll': return fill(poll(state, event.tasks));
    case 'setMax': return fill(setMax(state, event.max));
    case 'setSignal': return fill(setSignal(state, event.signal));
    case 'hook': return applyHook(state, event.workerId, event.payload, event.branch);
    case 'exit': return fill(exit(state, event.workerId));
    case 'kill': {
      const slot = state.slots.find((s) => s.id === event.slotId);
      return { state, effects: slot?.slug && slot.workerId ? [{ type: 'kill', slug: slot.slug, workerId: slot.workerId }] : [] };
    }
    case 'spawned': return patch(state, event.workerId, { itermSessionId: event.itermSessionId });
    case 'error': return { state: { ...state, error: event.message }, effects: [] };
  }
}

function emptySlot(): Slot {
  return { id: randomUUID(), status: 'vazio' };
}

function none(state: State): Reduced {
  return { state, effects: [] };
}

function patch(state: State, workerId: string, changes: Partial<Slot>): Reduced {
  return none({ ...state, slots: state.slots.map((s) => (s.workerId === workerId ? { ...s, ...changes } : s)) });
}

function fill(reduced: Reduced): Reduced {
  const { state, effects } = reduced;
  if (!canStart(state.signal, state.slots)) return reduced; // yellow / red: whatever happened stands, nothing new starts
  let queue = state.queue;
  const spawned: Effect[] = [];
  const slots = state.slots.map((slot) => {
    if (slot.status !== 'vazio' || slot.draining) return slot;
    const index = queue.findIndex((t) => !isBlocked(t)); // first free task in board order; blocked ones keep their place
    if (index < 0) return slot;
    const task = queue[index];
    queue = queue.filter((_, i) => i !== index);
    const next: Slot = {
      id: slot.id, workerId: randomUUID(), status: 'trabalhando', task, slug: slugFor(task),
      startedAt: new Date().toISOString(), lastEvent: 'iniciando',
    };
    spawned.push({ type: 'setStatus', itemId: task.itemId, key: 'working' }, { type: 'spawn', slot: next });
    return next;
  });
  return { state: { ...state, slots, queue }, effects: [...effects, ...spawned] };
}

function poll(state: State, tasks: Task[]): Reduced {
  const inSlot = new Set(state.slots.map((s) => s.task?.itemId));
  return none({
    ...state, queue: tasks.filter((t) => !inSlot.has(t.itemId)),
    lastPolledAt: new Date().toISOString(), error: undefined,
  });
}

function setMax(state: State, max: number): Reduced {
  const occupiedCount = state.slots.filter((s) => s.status !== 'vazio').length;
  const room = Math.max(0, max - occupiedCount);
  let occupiedSeen = 0;
  let emptyKept = 0;
  const kept = state.slots.flatMap<Slot>((s) => {
    if (s.status !== 'vazio') {
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

// Leaving red releases every paused mark. The Hive never types in a worker's terminal: this mark is all it releases.
function setSignal(state: State, signal: Signal): Reduced {
  const slots = signal === 'red' ? state.slots : state.slots.map((s) => ({ ...s, paused: undefined }));
  return none({ ...state, signal, slots });
}

function exit(state: State, workerId: string): Reduced {
  const slot = state.slots.find((s) => s.workerId === workerId);
  if (!slot || slot.status === 'vazio') return none(state);
  const requeue = slot.task && !slot.prUrl ? slot.task : undefined;
  const slots = slot.draining
    ? state.slots.filter((s) => s.workerId !== workerId)
    : state.slots.map((s) => (s.workerId === workerId ? { id: s.id, status: 'vazio' as Status } : s));
  return {
    state: { ...state, slots, queue: requeue ? [...state.queue, requeue] : state.queue },
    effects: requeue ? [{ type: 'setStatus', itemId: requeue.itemId, key: 'queue' }] : [],
  };
}

function boot(state: State, aliveSlugs: string[]): Reduced {
  const dead = state.slots.filter((s) => s.status !== 'vazio' && s.slug && !aliveSlugs.includes(s.slug));
  return dead.reduce<Reduced>((r, s) => {
    const next = exit(r.state, s.workerId!);
    return { state: next.state, effects: [...r.effects, ...next.effects] };
  }, none(state));
}

function describeTool(p: HookPayload): string {
  const input = (p.tool_input ?? {}) as Record<string, unknown>;
  const detail = String(input.command ?? input.file_path ?? input.pattern ?? '').slice(0, 60);
  const name = p.tool_name ?? 'tool';
  return detail ? `${name}: ${detail}` : name;
}

function activeStatus(slot: Slot): Status {
  return slot.prUrl ? 'aguardando_review' : 'trabalhando';
}

function applyHook(state: State, workerId: string, p: HookPayload, branch?: string): Reduced {
  const slot = state.slots.find((s) => s.workerId === workerId);
  if (!slot || slot.status === 'vazio') return none(state);
  switch (p.hook_event_name) {
    case 'SessionStart':
      return patch(state, workerId, { worktree: p.cwd, branch });
    case 'UserPromptSubmit':
      return patch(state, workerId, { status: activeStatus(slot), question: undefined, paused: undefined, lastEvent: 'prompt enviado' });
    case 'PreToolUse':
      return patch(state, workerId, { status: activeStatus(slot), question: undefined, paused: undefined, lastEvent: describeTool(p) });
    case 'Notification': {
      const kind = String(p.notification_type ?? '');
      if (!WAITING_NOTIFICATIONS.includes(kind)) return none(state);
      return patch(state, workerId, { status: 'esperando_voce', question: String(p.message ?? kind), lastEvent: `aguardando: ${kind}` });
    }
    case 'PostToolUse': {
      const command = String((p.tool_input as { command?: unknown } | undefined)?.command ?? '');
      const prUrl = extractPrUrl(command, p.tool_response);
      if (!prUrl) return none(state);
      const patched = patch(state, workerId, { status: 'aguardando_review', prUrl, question: undefined, lastEvent: 'PR aberto' });
      return { ...patched, effects: slot.task ? [{ type: 'setStatus', itemId: slot.task.itemId, key: 'review' }] : [] };
    }
    case 'Stop':
      // Red is manual mode: the worker stops by itself at the end of the turn; the mark says it stopped under red
      return patch(state, workerId, {
        status: activeStatus(slot), question: undefined,
        ...(state.signal === 'red' ? { paused: true, lastEvent: 'pausado: sinal vermelho' } : { lastEvent: 'turno encerrado' }),
      });
    case 'SessionEnd':
      return fill(exit(state, workerId));
    default:
      return none(state);
  }
}
