// The `signals` key of hive.config.json (#727, #32), out of config.ts, which is over 400 lines. Required, no default: a missing or bad value
// names its key and what it accepts, and the three signals must be ordered. The problem comes back as a sentence; config.ts adds the file's name.
import { isOrdered } from './signals.js';
import {
  NEW_TASKS, SIGNAL_ON_OPEN, STARTED_BEHAVIOURS, type NewTasks, type SignalBehaviour, type SignalOnOpen, type SignalSettings, type StartedBehaviour,
} from './types.js';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isNewTasks = (value: unknown): value is NewTasks => NEW_TASKS.includes(value as NewTasks);
const NEW_TASKS_VALUES = `must be one of: ${NEW_TASKS.join(', ')}`; // a boolean from before #32 is refused by naming the three
const ORDER_MESSAGE = '"signals.red" may not allow more than "signals.yellow", nor "signals.yellow" more than "signals.green": per behaviour, '
  + 'never < tree < always, stay < continueOnly < resumeAndContinue and false < true';

function parseGreen(raw: unknown): SignalSettings['green'] | string {
  if (!isRecord(raw)) return '"signals.green" must be an object with newTasks';
  return isNewTasks(raw.newTasks) ? { newTasks: raw.newTasks } : `"signals.green.newTasks" ${NEW_TASKS_VALUES}`;
}

function parseRow(raw: unknown, row: 'yellow' | 'red'): SignalBehaviour | string {
  if (!isRecord(raw)) return `"signals.${row}" must be an object with newTasks, started, workerless`;
  if (!isNewTasks(raw.newTasks)) return `"signals.${row}.newTasks" ${NEW_TASKS_VALUES}`;
  if (!STARTED_BEHAVIOURS.includes(raw.started as StartedBehaviour)) return `"signals.${row}.started" must be one of: ${STARTED_BEHAVIOURS.join(', ')}`;
  if (typeof raw.workerless !== 'boolean') return `"signals.${row}.workerless" must be true or false`;
  return { newTasks: raw.newTasks, started: raw.started as StartedBehaviour, workerless: raw.workerless };
}

/** The parsed key, or the first problem as a sentence without the file's name. */
export function parseSignals(raw: unknown): SignalSettings | string {
  if (!isRecord(raw)) return '"signals" must be an object with green, yellow, red, onOpen';
  const green = parseGreen(raw.green);
  if (typeof green === 'string') return green;
  const yellow = parseRow(raw.yellow, 'yellow');
  if (typeof yellow === 'string') return yellow;
  const red = parseRow(raw.red, 'red');
  if (typeof red === 'string') return red;
  if (!SIGNAL_ON_OPEN.includes(raw.onOpen as SignalOnOpen)) return `"signals.onOpen" must be one of: ${SIGNAL_ON_OPEN.join(', ')}`;
  const signals: SignalSettings = { green, yellow, red, onOpen: raw.onOpen as SignalOnOpen };
  return isOrdered(signals) ? signals : ORDER_MESSAGE;
}
