import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grammarFor, languageConfigurationOf, manifestOf, parseJsonc } from '../src/ui/lib/syntax-package.js';

const MANIFEST = {
  contributes: {
    grammars: [{ language: 'c', scopeName: 'source.c', path: './syntaxes/c.tmLanguage.json' }, { language: 'cpp', scopeName: 'source.cpp', path: './syntaxes/cpp.tmLanguage.json' }, { scopeName: 'source.cpp.embedded', path: 'x.json' }],
    languages: [{ id: 'c', extensions: ['.c', '.H'], configuration: './language-configuration.json' }, { id: 'cpp', extensions: ['.cpp', '.hpp'] }],
  },
};

test('a manifest\'s grammars and languages, paths without ./, extensions lowercased; the grammar of the language taking the extension (#780)', () => {
  const manifest = manifestOf(MANIFEST);
  assert.equal(manifest.grammars[0].path, 'syntaxes/c.tmLanguage.json');
  assert.deepEqual(manifest.languages[0], { id: 'c', extensions: ['.c', '.h'], configuration: 'language-configuration.json' });
  assert.equal(grammarFor(manifest, '.h')?.scopeName, 'source.c');
  assert.equal(grammarFor(manifest, '.hpp')?.scopeName, 'source.cpp');
  assert.equal(grammarFor(manifest, '.rs'), undefined);
  assert.deepEqual(manifestOf('junk'), { grammars: [], languages: [] });
});

test('JSON with comments and trailing commas reads; a // inside a string stays (#780)', () => {
  assert.deepEqual(parseJsonc('{ // a comment\n "a": "http://x", /* b */ "c": [1, 2,], }'), { a: 'http://x', c: [1, 2] });
});

test('a language configuration as Monaco takes it: regexes built from strings or { pattern, flags }, a bad one left out (#780)', () => {
  const config = languageConfigurationOf({
    comments: { lineComment: '#', blockComment: ['"""', '"""'] }, brackets: [['(', ')']],
    autoClosingPairs: [['{', '}'], { open: '"', close: '"', notIn: ['string'] }], surroundingPairs: [['(', ')']],
    wordPattern: { pattern: '\\w+', flags: 'g' }, indentationRules: { increaseIndentPattern: ':\\s*$', decreaseIndentPattern: '^\\s*(else)' },
    folding: { markers: { start: '^#region', end: '(' } },
  });
  assert.deepEqual(config.comments, { lineComment: '#', blockComment: ['"""', '"""'] });
  assert.deepEqual(config.autoClosingPairs, [{ open: '{', close: '}' }, { open: '"', close: '"', notIn: ['string'] }]);
  assert.equal(String(config.wordPattern), '/\\w+/g');
  assert.equal(String(config.indentationRules?.increaseIndentPattern), '/:\\s*$/');
  assert.equal(config.folding, undefined, 'its end marker is no regex');
});
