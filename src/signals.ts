// What each signal lets the Hive do on its own (#727): green's started and workerless are fixed, its newTasks (#32) and the yellow and red rows
// are the user's, in hive.config.json's `signals`. Pure and free of Node, so the reducer, the config parser and the dashboard read one rule.
import { NEW_TASKS, STARTED_BEHAVIOURS, type NewTasks, type Signal, type SignalBehaviour, type SignalOnOpen, type SignalSettings } from './types.js';

type Rows = Pick<SignalSettings, 'green' | 'yellow' | 'red'>;

/** What `signal` lets the Hive do on its own: green resumes, continues and runs workerless stages always, with the newTasks the user set (#32). */
export const behaviourOf = (signal: Signal, settings: Rows): SignalBehaviour =>
  (signal === 'green' ? { newTasks: settings.green.newTasks, started: 'resumeAndContinue', workerless: true } : settings[signal]);

// The stricter of two values on a scale given most restrictive first
const lower = <T>(order: readonly T[], a: T, b: T): T => (order.indexOf(a) <= order.indexOf(b) ? a : b);

// Whether `strict` allows nothing `loose` does not, field by field: never < tree < always, stay < continueOnly < resumeAndContinue, false < true
const isWithin = (strict: SignalBehaviour, loose: SignalBehaviour): boolean =>
  lower<NewTasks>(NEW_TASKS, strict.newTasks, loose.newTasks) === strict.newTasks
  && lower(STARTED_BEHAVIOURS, strict.started, loose.started) === strict.started && (!strict.workerless || loose.workerless);

/** Green ≥ yellow ≥ red (#727, #32), so "the most restrictive wins" means something when a rule and the manual signal disagree. parseConfig
 * refuses otherwise; the Settings card disables what would break it. */
export const isOrdered = (settings: Rows): boolean =>
  isWithin(settings.yellow, behaviourOf('green', settings)) && isWithin(settings.red, settings.yellow);

/** `strict` brought down to `loose` wherever it now allows more: what an edit to a looser signal leaves on the next one in the Settings card
 * (green → yellow, yellow → red), so the order holds. */
export function clamped(loose: SignalBehaviour, strict: SignalBehaviour): SignalBehaviour {
  return {
    newTasks: lower(NEW_TASKS, strict.newTasks, loose.newTasks),
    started: lower(STARTED_BEHAVIOURS, strict.started, loose.started),
    workerless: strict.workerless && loose.workerless,
  };
}

/** Resume: the fill gives a free worker to a started task that has none. */
export const mayResume = (behaviour: SignalBehaviour): boolean => behaviour.started === 'resumeAndContinue';
/** Continue: a session that ends its stage goes on in place into the next one. */
export const mayContinue = (behaviour: SignalBehaviour): boolean => behaviour.started !== 'stay';

/** The signal a boot opens on (#727): a saved red always stays red, `last` keeps the saved one, yellow and green are what they say. */
export const openingSignal = (saved: Signal, onOpen: SignalOnOpen): Signal => (saved === 'red' || onOpen === 'last' ? saved : onOpen);

/** What a row holds back, in the order the footer names it (#727): tree starts new tasks only from a started tree (#32). */
export type SignalEffect = 'noNewTasks' | 'newTasksFromTree' | 'noResume' | 'noMoveOn' | 'noWorkerless';

const NEW_TASKS_EFFECT: Record<NewTasks, SignalEffect[]> = { always: [], tree: ['newTasksFromTree'], never: ['noNewTasks'] };

/** The effects of a row; none means it lets the Hive do what an always-green does. */
export function effectOf(behaviour: SignalBehaviour): SignalEffect[] {
  const started: SignalEffect[] = behaviour.started === 'continueOnly' ? ['noResume'] : behaviour.started === 'stay' ? ['noMoveOn'] : [];
  return [...NEW_TASKS_EFFECT[behaviour.newTasks], ...started, ...(behaviour.workerless ? [] : ['noWorkerless' as const])];
}
