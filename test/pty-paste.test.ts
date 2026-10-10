import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bracketedPaste, withoutControls } from '../src/pty-paste.js';

test('withoutControls keeps tab and newline, turns CR and CRLF into LF and drops every other control, ESC included (#591)', () => {
  assert.equal(withoutControls('a\tb\r\nc\rd\x1b[201~e\x07f\u009bg'), 'a\tb\nc\nd[201~efg');
});

test('bracketedPaste frames the text and submits it (#591)', () => {
  assert.equal(bracketedPaste('hi'), '\x1b[200~hi\x1b[201~\r');
});
