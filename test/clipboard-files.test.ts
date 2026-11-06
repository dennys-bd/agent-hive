import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLIPBOARD_FILES_MAX, clipboardFilesPlist, dropFilesBuffer, isClipboardPathList, parseClipboardFiles, parseDropFiles } from '../src/clipboard-files.js';

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
  assert.equal(isClipboardPathList(['/a/one.txt', '/a/two dir', '/a/ü 日本 😀.txt'], 'darwin'), true);
  for (const bad of [undefined, 'x', [], ['rel/a'], ['/a', 3], ['/a/\0b'], ['/a/\x08b'], ['/a/\x1Fb']]) assert.equal(isClipboardPathList(bad, 'darwin'), false, JSON.stringify(bad));
  assert.equal(isClipboardPathList(Array.from({ length: CLIPBOARD_FILES_MAX }, (_, i) => `/a/${i}`), 'linux'), true);
  assert.equal(isClipboardPathList(Array.from({ length: CLIPBOARD_FILES_MAX + 1 }, (_, i) => `/a/${i}`), 'linux'), false);
});

test('isClipboardPathList leaves tab, newline and carriage return alone: XML carries them and a file name may hold one (#818)', () => {
  assert.equal(isClipboardPathList(['/a/tab\there', '/a/line\nbreak', '/a/cr\rname'], 'darwin'), true);
});

const WIN_HEADER_BYTES = 20;
const utf16 = (text: string): Buffer => Buffer.from(text, 'utf16le');
// A DROPFILES struct by hand, so the parser is not checked against the builder alone
const drop = (list: string, { pFiles = WIN_HEADER_BYTES, wide = 1 } = {}): Buffer => {
  const header = Buffer.alloc(WIN_HEADER_BYTES);
  header.writeUInt32LE(pFiles, 0);
  header.writeInt32LE(wide, 16);
  return Buffer.concat([header, utf16(list)]);
};

test('parseDropFiles reads every path of a CF_HDROP buffer, in order (#650)', () => {
  assert.deepEqual(parseDropFiles(drop('C:\\a\\one.txt\0D:\\two dir\\b.txt\0\0')), ['C:\\a\\one.txt', 'D:\\two dir\\b.txt']);
});

test('parseDropFiles gives [] for a short buffer, a pFiles out of range, ANSI paths and an empty list (#650)', () => {
  assert.deepEqual(parseDropFiles(Buffer.alloc(0)), []);
  assert.deepEqual(parseDropFiles(Buffer.alloc(WIN_HEADER_BYTES - 1)), []);
  assert.deepEqual(parseDropFiles(drop('C:\\a\0\0', { pFiles: 4096 })), []);
  assert.deepEqual(parseDropFiles(drop('C:\\a\0\0', { pFiles: 0xffffffff })), []);
  assert.deepEqual(parseDropFiles(drop('C:\\a\0\0', { wide: 0 })), []);
  assert.deepEqual(parseDropFiles(drop('\0')), []);
});

test('parseDropFiles keeps only the terminated paths of a list with no final double null, and never throws (#650)', () => {
  assert.deepEqual(parseDropFiles(drop('C:\\a\0C:\\cut')), ['C:\\a']);
  assert.deepEqual(parseDropFiles(drop('C:\\no-terminator')), []);
  assert.deepEqual(parseDropFiles(Buffer.concat([drop('C:\\a\0\0'), Buffer.from([0x41])])), ['C:\\a']);
});

test('dropFilesBuffer writes the 20-byte header then null-terminated UTF-16LE paths (#650)', () => {
  const buffer = dropFilesBuffer(['C:\\a']);
  assert.equal(buffer.readUInt32LE(0), WIN_HEADER_BYTES);
  assert.deepEqual([buffer.readInt32LE(4), buffer.readInt32LE(8), buffer.readInt32LE(12), buffer.readInt32LE(16)], [0, 0, 0, 1]);
  assert.deepEqual(buffer, drop('C:\\a\0\0'));
});

test('parseDropFiles(dropFilesBuffer(paths)) gives the paths back: spaces, non-ASCII, several (#650)', () => {
  for (const paths of [['C:\\my dir\\a b.txt'], ['C:\\çã\\文件.txt'], ['C:\\a\\1.txt', '\\\\srv\\share\\2 😀.txt', 'D:/x/3']]) {
    assert.deepEqual(parseDropFiles(dropFilesBuffer(paths)), paths);
  }
});

test('isClipboardPathList on win32 takes a drive path with either slash and a UNC path, and refuses the rest (#650)', () => {
  assert.equal(isClipboardPathList(['C:\\a\\b.txt', 'c:/a', '\\\\server\\share\\f.txt'], 'win32'), true);
  for (const bad of ['\\a', 'a\\b', 'C:a', '/a/b', 'C:', 'rel/a', 'C:\\a\0b', '\\\\?\\C:\\a', '\\\\.\\pipe\\x']) assert.equal(isClipboardPathList([bad], 'win32'), false, bad);
  assert.equal(isClipboardPathList(Array.from({ length: CLIPBOARD_FILES_MAX + 1 }, (_, i) => `C:\\a${i}`), 'win32'), false);
});

test('isClipboardPathList off win32 still wants a leading slash, and a drive path is relative there (#650)', () => {
  assert.equal(isClipboardPathList(['C:\\a\\b.txt'], 'darwin'), false);
  assert.equal(isClipboardPathList(['C:/a'], 'linux'), false);
  assert.equal(isClipboardPathList(['/a'], 'linux'), true);
});

test('parseDropFiles refuses a runaway buffer past CLIPBOARD_FILES_MAX KiB without decoding it (#650)', () => {
  const huge = Buffer.concat([dropFilesBuffer(['C:\\a']), Buffer.alloc(CLIPBOARD_FILES_MAX * 1024)]);
  assert.deepEqual(parseDropFiles(huge), []);
});
