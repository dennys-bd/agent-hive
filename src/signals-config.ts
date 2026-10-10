// The `signals` key of hive.config.json (#727), out of config.ts, which is over 400 lines. Required, no default: a missing or bad value names
// its key and what it accepts, and red may never be looser than yellow. The problem comes back as a sentence; config.ts adds the file's name.
import { isOrdered } from './signals.js';
import { SIGNAL_ON_OPEN, STARTED_BEHAVIOURS, type SignalBehaviour, type SignalOnOpen, type SignalSettings, type StartedBehaviour } from './types.js';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function parseRow(raw: unknown, row: 'yellow' | 'red'): SignalBehaviour | string {
  if (!isRecord(raw)) return `"signals.${row}" must be an object with newTasks, started, workerless`;
  if (typeof raw.newTasks !== 'boolean') return `"signals.${row}.newTasks" must be true or false`;
  if (!STARTED_BEHAVIOURS.includes(raw.started as StartedBehaviour)) return `"signals.${row}.started" must be one of: ${STARTED_BEHAVIOURS.join(', ')}`;
  if (typeof raw.workerless !== 'boolean') return `"signals.${row}.workerless" must be true or false`;
  return { newTasks: raw.newTasks, started: raw.started as StartedBehaviour, workerless: raw.workerless };
}

/** The parsed key, or the first problem as a sentence without the file's name. */
export function parseSignals(raw: unknown): SignalSettings | string {
  if (!isRecord(raw)) return '"signals" must be an object with yellow, red, onOpen';
  const yellow = parseRow(raw.yellow, 'yellow');
  if (typeof yellow === 'string') return yellow;
  const red = parseRow(raw.red, 'red');
  if (typeof red === 'string') return red;
  if (!SIGNAL_ON_OPEN.includes(raw.onOpen as SignalOnOpen)) return `"signals.onOpen" must be one of: ${SIGNAL_ON_OPEN.join(', ')}`;
  if (!isOrdered({ yellow, red })) return '"signals.red" may not allow more than "signals.yellow": per behaviour, stay < continueOnly < resumeAndContinue and false < true';
  return { yellow, red, onOpen: raw.onOpen as SignalOnOpen };
}
