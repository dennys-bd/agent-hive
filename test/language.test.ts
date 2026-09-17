import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LANGUAGES, languageFrom, systemLanguage } from '../src/language.js';

test('languageFrom reads any locale that starts with pt as pt and everything else, including nothing, as en', () => {
  assert.equal(languageFrom('pt-BR'), 'pt');
  assert.equal(languageFrom('pt'), 'pt');
  assert.equal(languageFrom('PT-PT'), 'pt');
  assert.equal(languageFrom('en-US'), 'en');
  assert.equal(languageFrom('fr'), 'en');
  assert.equal(languageFrom(''), 'en');
  assert.equal(languageFrom(undefined), 'en');
  assert.equal(languageFrom('ptx'), 'en', 'pt must be the whole language tag');
});

test('systemLanguage is one of LANGUAGES and matches the Node locale', () => {
  assert.deepEqual(LANGUAGES, ['pt', 'en']);
  const detected = systemLanguage();
  assert.ok(LANGUAGES.includes(detected));
  assert.equal(detected, languageFrom(Intl.DateTimeFormat().resolvedOptions().locale));
});
