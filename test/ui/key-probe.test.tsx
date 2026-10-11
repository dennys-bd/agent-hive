// .tsx without JSX: vitest.config.ts only picks test/ui/**/*.test.tsx.
import type { Terminal } from '@xterm/xterm';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { BATCH_MS, dataEvent, isProbedKey, probeKeys } from '@/lib/key-probe';
import { FakeTerminal, resetFakes } from './xterm-fakes';

beforeEach(() => {
  resetFakes();
  vi.useFakeTimers(); // Date.now too: the events' timestamps are the advances below
});
afterEach(() => {
  vi.useRealTimers();
});

// One probed fake xterm: `key` and `compose` dispatch on its real jsdom textarea, `term.type` drives its onData
function probe() {
  const term = new FakeTerminal();
  const send = vi.fn();
  const stop = probeKeys(term as unknown as Terminal, send);
  const textarea = term.textarea as HTMLTextAreaElement;
  const key = (key: string, code: string, isComposing = false): void =>
    void textarea.dispatchEvent(new KeyboardEvent('keydown', { key, code, isComposing }));
  const compose = (type: string, data: string): void => void textarea.dispatchEvent(new CompositionEvent(type, { data }));
  return { term, send, stop, key, compose };
}

test('the filter keeps a Dead keydown and the accent characters, and drops a letter, a digit and Enter (#732)', () => {
  for (const key of ['Dead', "'", '`', '~', '^', '"']) expect(isProbedKey(key), key).toBe(true);
  for (const key of ['e', 'E', '1', 'Enter', 'Tab', 'Backspace', '´']) expect(isProbedKey(key), key).toBe(false);
});

test('a data event keeps its data up to 2 characters and only its length beyond that (#732)', () => {
  expect(dataEvent('é')).toEqual({ kind: 'data', data: 'é' });
  expect(dataEvent("'e")).toEqual({ kind: 'data', data: "'e" });
  expect(dataEvent('abc')).toEqual({ kind: 'data', length: 3 });
  expect(dataEvent('hunter2')).toEqual({ kind: 'data', length: 7 });
});

test('a healthy dead-key composition reaches send in one batch: the Dead keydown, the composition events and the first data after them, never the letter key (#732)', () => {
  const { term, send, key, compose } = probe();
  key('Dead', 'Quote');
  vi.advanceTimersByTime(2);
  compose('compositionstart', '');
  compose('compositionupdate', '´');
  key('e', 'KeyE', true); // the letter's own keydown, inside the composition, is never recorded
  vi.advanceTimersByTime(40);
  compose('compositionend', 'é');
  vi.advanceTimersByTime(1);
  term.type('é');
  term.type('x'); // only the first data after them
  expect(send).not.toHaveBeenCalled(); // still batching
  vi.advanceTimersByTime(BATCH_MS);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith([
    { kind: 'keydown', key: 'Dead', code: 'Quote', isComposing: false, at: 0 },
    { kind: 'compositionstart', data: '', at: 2 },
    { kind: 'compositionupdate', data: '´', at: 2 },
    { kind: 'compositionend', data: 'é', at: 42 },
    { kind: 'data', data: 'é', at: 43 },
  ]);
});

test('after an accent-character keydown nothing typed is recorded: a broken composition shows as that keydown alone, and letters, digits and Enter never appear (#732)', () => {
  const { term, send, key } = probe();
  key("'", 'Quote');
  key('e', 'KeyE');
  term.type("'e");
  key('1', 'Digit1');
  term.type('1');
  key('Enter', 'Enter');
  term.type('\r');
  vi.advanceTimersByTime(BATCH_MS);
  expect(send).toHaveBeenCalledWith([{ kind: 'keydown', key: "'", code: 'Quote', isComposing: false, at: 0 }]);
});

test('a focus report is never counted as the data after a dead key, and data longer than 2 characters is kept as its length (#732, #599)', () => {
  const { term, send, key } = probe();
  key('Dead', 'Quote');
  term.type('\x1b[I');
  term.type('\x1b[O');
  term.type('abc');
  vi.advanceTimersByTime(BATCH_MS);
  expect(send).toHaveBeenCalledWith([
    { kind: 'keydown', key: 'Dead', code: 'Quote', isComposing: false, at: 0 },
    { kind: 'data', length: 3, at: 0 },
  ]);
});

test('the teardown drops a pending batch and removes the listeners: nothing is sent after it (#732)', () => {
  const { term, send, stop, key, compose } = probe();
  key('Dead', 'Quote');
  stop();
  vi.advanceTimersByTime(BATCH_MS);
  key('Dead', 'Quote');
  compose('compositionend', 'é');
  term.type('é');
  vi.advanceTimersByTime(BATCH_MS);
  expect(send).not.toHaveBeenCalled();
});

test('a terminal with no textarea records nothing and its teardown is safe (#732)', () => {
  const term = new FakeTerminal();
  term.textarea = undefined;
  const send = vi.fn();
  const stop = probeKeys(term as unknown as Terminal, send);
  term.type('é');
  stop();
  vi.advanceTimersByTime(BATCH_MS);
  expect(send).not.toHaveBeenCalled();
});

test('an IME composition no Dead key opened is never recorded, nor the data after it: it carries the typed text itself (#732)', () => {
  const { term, send, compose } = probe();
  compose('compositionstart', '');
  compose('compositionupdate', 'ひみつ');
  compose('compositionend', '秘密');
  term.type('秘密');
  vi.advanceTimersByTime(BATCH_MS);
  expect(send).not.toHaveBeenCalled();
});

test('a key outside the composition disarms a Dead key: after Escape, the next key typed is never recorded (#732)', () => {
  const { term, send, key, compose } = probe();
  key('Dead', 'Quote');
  key('Escape', 'Escape');
  key('p', 'KeyP');
  term.type('p');
  compose('compositionend', 'x');
  vi.advanceTimersByTime(BATCH_MS);
  expect(send).toHaveBeenCalledWith([{ kind: 'keydown', key: 'Dead', code: 'Quote', isComposing: false, at: 0 }]);
});
