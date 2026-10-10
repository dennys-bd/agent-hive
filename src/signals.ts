// What each signal lets the Hive do on its own (#727): green is fixed, yellow and red are the user's rows of hive.config.json's `signals`.
// Pure and free of Node, so the reducer, the config parser and the dashboard read one rule.
import { STARTED_BEHAVIOURS, type Signal, type SignalBehaviour, type SignalOnOpen, type SignalSettings, type StartedBehaviour } from './types.js';

/** Green: every behaviour on, never configurable. */
export const GREEN_BEHAVIOUR: SignalBehaviour = { newTasks: true, started: 'resumeAndContinue', workerless: true };

/** What `signal` lets the Hive do on its own: green's fixed row, else the settings' own. */
export const behaviourOf = (signal: Signal, settings: Pick<SignalSettings, 'yellow' | 'red'>): SignalBehaviour =>
  (signal === 'green' ? GREEN_BEHAVIOUR : settings[signal]);

const rank = (started: StartedBehaviour): number => STARTED_BEHAVIOURS.indexOf(started);

// Whether `strict` allows nothing `loose` does not, field by field: false < true, stay < continueOnly < resumeAndContinue
const isWithin = (strict: SignalBehaviour, loose: SignalBehaviour): boolean =>
  (!strict.newTasks || loose.newTasks) && rank(strict.started) <= rank(loose.started) && (!strict.workerless || loose.workerless);

/** Red never looser than yellow (#727), so "the most restrictive wins" means something when a rule and the manual signal disagree. parseConfig
 * refuses otherwise; the Settings card disables what would break it. */
export const isOrdered = (settings: Pick<SignalSettings, 'yellow' | 'red'>): boolean => isWithin(settings.red, settings.yellow);

/** Red brought down to yellow wherever it now allows more: what a yellow edit in the Settings card leaves, so the pair stays ordered. */
export function clampedRed(yellow: SignalBehaviour, red: SignalBehaviour): SignalBehaviour {
  return {
    newTasks: red.newTasks && yellow.newTasks,
    started: rank(red.started) <= rank(yellow.started) ? red.started : yellow.started,
    workerless: red.workerless && yellow.workerless,
  };
}

/** Resume: the fill gives a free worker to a started task that has none. */
export const mayResume = (behaviour: SignalBehaviour): boolean => behaviour.started === 'resumeAndContinue';
/** Continue: a session that ends its stage goes on in place into the next one. */
export const mayContinue = (behaviour: SignalBehaviour): boolean => behaviour.started !== 'stay';

/** The signal a boot opens on (#727): a saved red always stays red, `last` keeps the saved one, yellow and green are what they say. */
export const openingSignal = (saved: Signal, onOpen: SignalOnOpen): Signal => (saved === 'red' || onOpen === 'last' ? saved : onOpen);

/** What a row holds back, in the order the footer names it (#727). */
export type SignalEffect = 'noNewTasks' | 'noResume' | 'noMoveOn' | 'noWorkerless';

/** The effects of a row; none means it lets the Hive do what green does. */
export function effectOf(behaviour: SignalBehaviour): SignalEffect[] {
  const started: SignalEffect[] = behaviour.started === 'continueOnly' ? ['noResume'] : behaviour.started === 'stay' ? ['noMoveOn'] : [];
  return [...(behaviour.newTasks ? [] : ['noNewTasks' as const]), ...started, ...(behaviour.workerless ? [] : ['noWorkerless' as const])];
}
