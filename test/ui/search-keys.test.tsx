import { expect, test, vi } from 'vitest';
import { onShortcutKey } from '@/lib/dock-layout';
import { SEARCH_PANE_ATTR } from '@/lib/search-keys';
import { setShortcuts } from '@/lib/shortcut-bindings';

test('inside the pane Alt+C is match case, never openDiff; outside it openDiff keeps its key (#868)', () => {
  setShortcuts({ openDiff: 'CmdOrCtrl+Alt+C', searchMatchCase: 'CmdOrCtrl+Alt+C' }); // jsdom is off macOS: the macOS pair, rebound to collide here
  const diff = vi.fn();
  const off = onShortcutKey([[true, 'openDiff']], diff);
  const pane = document.createElement('div');
  pane.setAttribute(SEARCH_PANE_ATTR, '');
  const input = document.createElement('input');
  pane.append(input);
  const outside = document.createElement('button');
  document.body.append(pane, outside);
  const press = { key: 'c', code: 'KeyC', ctrlKey: true, altKey: true, bubbles: true, cancelable: true };
  input.dispatchEvent(new KeyboardEvent('keydown', press));
  expect(diff).not.toHaveBeenCalled();
  outside.dispatchEvent(new KeyboardEvent('keydown', press));
  expect(diff).toHaveBeenCalledOnce();
  off();
  pane.remove();
  outside.remove();
  setShortcuts({});
});
