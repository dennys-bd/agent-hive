import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLIPBOARD_FILES_MAX, clipboardFilesPlist, isClipboardPathList, parseClipboardFiles } from '../src/clipboard-files.js';

const plist = (...paths: string[]): string =>
  `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><array>${paths.map((p) => `<string>${p}</string>`).join('')}</array></plist>`;

test('parseClipboardFiles lists every path of the plist, in order', () => {
  assert.deepEqual(parseClipboardFiles(plist('/Users/a/one.txt', '/Users/a/two dir'), ''), ['/Users/a/one.txt', '/Users/a/two dir']);
});

test('parseClipboardFiles decodes XML entities', () => {
  assert.deepEqual(parseClipboardFiles(plist('/Users/a/R&amp;D &lt;x&gt; &quot;q&quot; &apos;s&apos; &#233;'), ''), ['/Users/a/R&D <x> "q" \'s\' é']);
});

test('parseClipboardFiles gives [] for an empty or absent clipboard, and for text that is not a path', () => {
  assert.deepEqual(parseClipboardFiles('', ''), []);
  assert.deepEqual(parseClipboardFiles('', '   '), []);
  assert.deepEqual(parseClipboardFiles('', 'just some copied text'), []);
  assert.deepEqual(parseClipboardFiles(plist('not a path'), ''), []);
});

test('parseClipboardFiles falls back to the file URL when the plist is empty', () => {
  assert.deepEqual(parseClipboardFiles('', 'file:///Users/a/my%20file.txt\n'), ['/Users/a/my file.txt']);
});

test('parseClipboardFiles prefers the plist over the file URL', () => {
  assert.deepEqual(parseClipboardFiles(plist('/x/a', '/x/b'), 'file:///x/a'), ['/x/a', '/x/b']);
});

test('clipboardFilesPlist writes what parseClipboardFiles reads back, its XML entities escaped (#818)', () => {
  const paths = ['/Users/a/one.txt', '/Users/a/R&D <x> "q" \'s\' é'];
  assert.deepEqual(parseClipboardFiles(clipboardFilesPlist(paths), ''), paths);
  assert.match(clipboardFilesPlist(['/a&b']), /<string>\/a&amp;b<\/string>/);
});

test('isClipboardPathList takes absolute paths only, no control characters, at most CLIPBOARD_FILES_MAX of them (#818)', () => {
  assert.equal(isClipboardPathList(['/a/one.txt', '/a/two dir', '/a/ü 日本 😀.txt']), true);
  for (const bad of [undefined, 'x', [], ['rel/a'], ['/a', 3], ['/a/\0b'], ['/a/\x08b'], ['/a/\x1Fb']]) assert.equal(isClipboardPathList(bad), false, JSON.stringify(bad));
  assert.equal(isClipboardPathList(Array.from({ length: CLIPBOARD_FILES_MAX }, (_, i) => `/a/${i}`)), true);
  assert.equal(isClipboardPathList(Array.from({ length: CLIPBOARD_FILES_MAX + 1 }, (_, i) => `/a/${i}`)), false);
});

test('isClipboardPathList leaves tab, newline and carriage return alone: XML carries them and a file name may hold one (#818)', () => {
  assert.equal(isClipboardPathList(['/a/tab\there', '/a/line\nbreak', '/a/cr\rname']), true);
});
