import { afterEach, expect, test, vi } from 'vitest';
import { onShortcutKey } from '@/lib/dock-layout';
import { isHiveKey, passHiveKeys } from '@/lib/monaco-keys';
import { setShortcuts } from '@/lib/shortcut-bindings';

afterEach(() => setShortcuts({}));

// jsdom runs as off macOS: CmdOrCtrl is Ctrl
const key = (init: KeyboardEventInit): KeyboardEvent => new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
const SEARCH = { key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true }; // search, a global shortcut off macOS

test('a key a global or an activity\'s shortcut binds passes to the Hive; the editor\'s own keys, a flow key among them, stay in the editor (#717)', () => {
  expect(isHiveKey(key(SEARCH))).toBe(true);
  expect(isHiveKey(key({ key: 'K', code: 'KeyK', ctrlKey: true, shiftKey: true }))).toBe(true); // clear, an activity's
  expect(isHiveKey(key({ key: 's', code: 'KeyS', ctrlKey: true }))).toBe(false); // the editor's save
  expect(isHiveKey(key({ key: 'f', code: 'KeyF', ctrlKey: true }))).toBe(false); // searchTasks is the flow's: Monaco's find keeps it
  expect(isHiveKey(key({ key: 'a', code: 'KeyA' }))).toBe(false);
  setShortcuts({ search: null });
  expect(isHiveKey(key(SEARCH))).toBe(false); // a shortcut turned off is the editor's again
});

test('passHiveKeys stops a Hive key at the editor\'s host, before Monaco\'s listeners below it, until it is undone; any other key goes through (#717)', () => {
  const host = document.createElement('div');
  const textarea = document.createElement('textarea'); // where Monaco takes its keys
  host.append(textarea);
  document.body.append(host);
  const seen = vi.fn();
  textarea.addEventListener('keydown', seen);
  const stop = passHiveKeys(host);
  textarea.dispatchEvent(key(SEARCH));
  textarea.dispatchEvent(key({ key: 'a', code: 'KeyA' }));
  expect(seen).toHaveBeenCalledTimes(1);
  stop();
  textarea.dispatchEvent(key(SEARCH));
  expect(seen).toHaveBeenCalledTimes(2);
  host.remove();
});

test('the sleep key stays Monaco\'s quick fix inside an editor and still sleeps the session anywhere else (#780)', () => {
  const sleep = vi.fn();
  const stop = onShortcutKey([[true, 'sleepSession']], sleep);
  const editor = document.createElement('div');
  editor.className = 'monaco-editor';
  const textarea = document.createElement('textarea');
  editor.append(textarea);
  const outside = document.createElement('button');
  document.body.append(editor, outside);
  const press = { key: '.', code: 'Period', ctrlKey: true, shiftKey: true }; // off macOS: Ctrl+Shift+.
  textarea.dispatchEvent(key(press));
  expect(sleep).not.toHaveBeenCalled();
  expect(isHiveKey(key(press))).toBe(false);
  outside.dispatchEvent(key(press));
  expect(sleep).toHaveBeenCalledTimes(1);
  stop();
  editor.remove();
  outside.remove();
});
