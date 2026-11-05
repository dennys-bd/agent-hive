import { test } from 'node:test';
import assert from 'node:assert/strict';
import { titleBarOverlayFor, TRAFFIC_LIGHTS, windowChromeOptions } from '../src/window-options.js';

test('titleBarOverlayFor: the theme\'s background behind the caption buttons, its foreground as their ink, at the header\'s 44px (#648)', () => {
  assert.deepEqual(titleBarOverlayFor('dark'), { color: '#111418', symbolColor: '#e6e6e6', height: 44 });
  assert.deepEqual(titleBarOverlayFor('light'), { color: '#f5f6f8', symbolColor: '#1f2328', height: 44 });
});

test('windowChromeOptions on win32: the title bar hidden, the caption overlay in the theme\'s colours, no traffic lights, no auto-hide (Alt would bring the menu back) (#648)', () => {
  for (const theme of ['dark', 'light'] as const) {
    const options = windowChromeOptions('win32', theme);
    assert.deepEqual(options, { titleBarStyle: 'hidden', titleBarOverlay: titleBarOverlayFor(theme), backgroundColor: titleBarOverlayFor(theme).color }, theme);
    assert.equal('trafficLightPosition' in options, false, theme);
  }
});

test('windowChromeOptions on darwin: today\'s options exactly, hiddenInset with the traffic lights and the theme\'s background (#296, #533)', () => {
  assert.deepEqual(TRAFFIC_LIGHTS, { x: 14, y: 16 });
  assert.deepEqual(windowChromeOptions('darwin', 'dark'), { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 16 }, backgroundColor: '#111418' });
  assert.deepEqual(windowChromeOptions('darwin', 'light'), { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 16 }, backgroundColor: '#f5f6f8' });
});

test('windowChromeOptions on linux keeps today\'s options, the same as macOS (#648: Linux chrome is out of scope)', () => {
  assert.deepEqual(windowChromeOptions('linux', 'dark'), windowChromeOptions('darwin', 'dark'));
});
