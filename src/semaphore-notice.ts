import { activityOfWorker, taskOfWorker } from './activities.js';
import { withoutControls } from './pty-paste.js';
import { liveWorker, none, patch, type Reduced } from './reducer-kit.js';
import { shellQuote } from './shell-init.js';
import { stageOf } from './tasks.js';
import { APPROVAL_HOLD_MAX_MIN, type Effect, type SemaphoreEvent, type State, type Worker } from './types.js';

// A semaphore's turn told to the agent whose pty it came to (#799), in the one channel it reads then: its held Stop's answer, or text typed
// into its pty. Pure and immutable, like the reducer that routes here; the clock is read only for a hold's end, as awaitApproval reads it.

const MINUTE_MS = 60_000;
// A word sh reads as itself (shlex.quote's safe set): shown bare, any other quoted
const PLAIN_WORD = /^[\w@%+=:,./-]+$/;
// What applyHook's plain Stop leaves: the worker idle at its own prompt
const IDLE: Partial<Worker> = { status: 'waiting', question: undefined, lastEvent: { kind: 'turn' } };

type Turn = Extract<SemaphoreEvent, { type: 'semaphoreTurn' }>;

const pad = (n: number): string => String(n).padStart(2, '0');
const localTime = (iso: string): string => {
  const at = new Date(iso);
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
};
// The argv came from the shim: no control byte reaches the paste, where an ESC could close it (#483)
const shown = (word: string): string => {
  const clean = withoutControls(word);
  return PLAIN_WORD.test(clean) ? clean : shellQuote(clean);
};

/** The notice (#799, decision 9), English like every prompt the Hive gives an agent; a turn with no reservation (a removed semaphore) has
 * no second sentence. */
export function noticeText(semaphore: string, argv: readonly string[], until?: string): string {
  const run = `Your turn on the semaphore \`${semaphore}\` came: run \`${argv.map(shown).join(' ')}\` now.`;
  return until === undefined ? run : `${run} Its permit is held for you until ${localTime(until)}.`;
}

const hasPlace = (state: State, ptyId: string): boolean => Object.values(state.semaphores).some((s) => s.line.some((w) => w.ptyId === ptyId));
const isInTurn = (state: State, ptyId: string, semaphore: string): boolean =>
  state.semaphores[semaphore]?.line.some((w) => w.ptyId === ptyId && w.turnUntil !== undefined) === true;

// Decision 1: a paste lands in the agent's own input box only while it works or once its turn ended there; at any other prompt (a permission,
// an elicitation, hive_ask, approval, backoff) its Enter would answer that prompt
const takesInput = (w: Worker): boolean => w.status === 'working' || (w.status === 'waiting' && w.lastEvent?.kind === 'turn');

// A Stop answered with the notice as the run's next prompt, in its own stage; a stage run always has its task and activity (#629)
function stopAnswer(state: State, worker: Worker, ptyId: string, text: string): Effect[] {
  const task = taskOfWorker(state, worker);
  const activity = activityOfWorker(state, worker);
  const stage = task && stageOf(state.stages, task.stage);
  if (!task || !activity || !stage) return [{ type: 'release', ptyId }, { type: 'input', ptyId, text }];
  return [{ type: 'continue', ptyId, activity, task, stage, prompt: text }];
}

/** A turn given (#799, decision 1): a held Stop is answered; any other run keeps the notice for a Stop in its turn, and one that takes input
 * also gets it typed (a Stop may beat the queued paste). The latest turn wins. A pty no worker runs is a terminal's, whose shim waits (2.4). */
export function turnCame(state: State, { ptyId, semaphore, argv, until }: Turn): Reduced {
  const worker = liveWorker(state, ptyId);
  if (!worker) return none(state);
  const text = noticeText(semaphore, argv, until);
  if (worker.semaphoreHold !== undefined) return { state: patch(state, ptyId, { semaphoreHold: undefined }).state, effects: stopAnswer(state, worker, ptyId, text) };
  const kept = patch(state, ptyId, { semaphoreNotice: { semaphore, text } }).state;
  return { state: kept, effects: takesInput(worker) ? [{ type: 'input', ptyId, text }] : [] };
}

// A kept notice at a Stop still in its turn: a stage run's Stop answers it, a free session goes idle and gets it typed
function delivered(state: State, ptyId: string, worker: Worker, text: string): Reduced {
  if (worker.freeSession === true) return { state: patch(state, ptyId, IDLE).state, effects: [{ type: 'input', ptyId, text }] };
  return { state: patch(state, ptyId, { status: 'working', question: undefined }).state, effects: stopAnswer(state, worker, ptyId, text) };
}

// Decisions 3-5: the Stop waits for the turn, at most APPROVAL_HOLD_MAX_MIN (the Stop hook's own timeout outlasts it); green, last event kept
function held(state: State, ptyId: string): Reduced {
  const until = new Date(Date.now() + APPROVAL_HOLD_MAX_MIN * MINUTE_MS).toISOString();
  return { state: patch(state, ptyId, { status: 'working', question: undefined, semaphoreHold: until }).state, effects: [{ type: 'hold', ptyId, until }] };
}

/** A Stop with nothing else pending (#799, decisions 2, 3): a kept notice still in its turn is delivered, else dropped; then a stage run with a
 * place in some line holds its Stop. Undefined: neither, the Stop goes on as today. */
export function stopWithPlace(state: State, ptyId: string, worker: Worker): Reduced | undefined {
  const notice = worker.semaphoreNotice;
  const cleared = notice === undefined ? state : patch(state, ptyId, { semaphoreNotice: undefined }).state;
  if (notice !== undefined && isInTurn(state, ptyId, notice.semaphore)) return delivered(cleared, ptyId, worker, notice.text);
  if (worker.freeSession !== true && hasPlace(state, ptyId)) return held(cleared, ptyId);
  return notice === undefined ? undefined : patch(cleared, ptyId, IDLE);
}
