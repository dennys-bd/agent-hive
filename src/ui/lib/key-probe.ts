// A debug probe for dead keys in a terminal (#732). It records only what tells which layer lost a composition: a dead or accent keydown,
// the composition events, and the first data after a dead key or a composition. Anything else typed in a terminal can be a password, so
// it never reaches the probe; hive.log gets the batches only at logLevel debug, the daemon drops them below that.
import type { Terminal } from '@xterm/xterm';
import { FOCUS_REPORTS } from '@/lib/pty-stream';
import type { KeyProbeEvent } from '../../terminal-wire.js';

export const ACCENT_KEYS: ReadonlySet<string> = new Set(["'", '`', '~', '^', '"']);
// One message per burst of accents. A timer, not a frame: the reproduction hides the tab, and a hidden tab's frames are throttled
export const BATCH_MS = 100;
const DATA_KEPT_MAX = 2; // a composed character, or the broken two-character `'e`; longer data is a paste or a reply, kept as its length
const COMPOSITION_KINDS = ['compositionstart', 'compositionupdate', 'compositionend'] as const;

type ProbeDraft = Omit<KeyProbeEvent, 'at'>;

/** Whether a keydown is one the probe records: a dead key or an accent character, never a letter, a digit or any other key. */
export const isProbedKey = (key: string): boolean => key === 'Dead' || ACCENT_KEYS.has(key);

/** The data event the probe keeps: the data itself up to two characters, only its length beyond that. */
export function dataEvent(data: string): ProbeDraft {
  const length = [...data].length; // characters, not UTF-16 units
  return length <= DATA_KEPT_MAX ? { kind: 'data', data } : { kind: 'data', length };
}

// The first draft opens a window of BATCH_MS and is at 0; the window's end sends what it gathered as one batch
function batcher(send: (events: KeyProbeEvent[]) => void): { record(draft: ProbeDraft): void; drop(): void } {
  let batch: KeyProbeEvent[] = [];
  let start = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = (): void => {
    const events = batch;
    batch = [];
    timer = undefined;
    send(events);
  };
  return {
    record: (draft) => {
      const now = Date.now();
      if (timer === undefined) {
        start = now;
        timer = setTimeout(flush, BATCH_MS);
      }
      batch = [...batch, { ...draft, at: now - start }];
    },
    drop: () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      batch = [];
    },
  };
}

/** Records the probe's events on `term`, whose open() already ran so its textarea exists, and hands each batch to `send`. Returns the
 * teardown, which drops a batch still pending. A terminal with no textarea records nothing. */
export function probeKeys(term: Terminal, send: (events: KeyProbeEvent[]) => void): () => void {
  const { textarea } = term;
  if (!textarea) return () => undefined;
  const batch = batcher(send);
  // A composition is recorded only when a Dead keydown opened it: an IME's (Japanese, Chinese, Korean) carries the typed text itself.
  // The next data is recorded only after that Dead key or its composition; after an accent character it is the user's next key
  let isDead = false;
  let isArmed = false;
  const onKeydown = (event: KeyboardEvent): void => {
    if (!isProbedKey(event.key)) {
      // a key outside the composition ends it, and Escape always does: inside a composition it comes with isComposing, and a Dead key it
      // cancels must not arm the password typed next
      if (!event.isComposing || event.key === 'Escape') isDead = isArmed = false;
      return;
    }
    isDead = isArmed = event.key === 'Dead';
    batch.record({ kind: 'keydown', key: event.key, code: event.code, isComposing: event.isComposing });
  };
  const compositions = COMPOSITION_KINDS.map((kind) => [kind, (event: CompositionEvent): void => {
    if (!isDead) return;
    if (kind === 'compositionend') isDead = false;
    isArmed = kind !== 'compositionend' || event.data !== ''; // a cancelled composition ends empty: nothing typed after it is its data
    const { data, length } = dataEvent(event.data);
    batch.record(data === undefined ? { kind, length } : { kind, data });
  }] as const);
  textarea.addEventListener('keydown', onKeydown);
  for (const [kind, listener] of compositions) textarea.addEventListener(kind, listener);
  const typed = term.onData((data) => {
    if (!isArmed || FOCUS_REPORTS.has(data)) return;
    isArmed = false;
    batch.record(dataEvent(data));
  });
  return () => {
    isDead = isArmed = false; // a terminal whose onData cannot be unsubscribed must still record nothing after the teardown
    batch.drop();
    textarea.removeEventListener('keydown', onKeydown);
    for (const [kind, listener] of compositions) textarea.removeEventListener(kind, listener);
    typed.dispose();
  };
}
