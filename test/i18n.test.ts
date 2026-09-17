import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LOCALE, MESSAGES, setLanguage, slotEventText, statusText, t } from '../src/ui/i18n.js';

const INDEX_HTML = new URL('../../src/ui/index.html', import.meta.url); // dist/test → repo root

test('pt and en have exactly the same keys and no empty text', () => {
  const en = Object.keys(MESSAGES.en).sort();
  assert.deepEqual(Object.keys(MESSAGES.pt).sort(), en);
  assert.ok(en.length > 60, `only ${en.length} keys`);
  for (const language of ['pt', 'en'] as const) {
    for (const [key, text] of Object.entries(MESSAGES[language])) assert.ok(text.trim().length > 0, `${language}.${key} is empty`);
  }
  assert.deepEqual(LOCALE, { pt: 'pt-BR', en: 'en-US' });
});

test('every data-i18n key in index.html exists in the dictionary', () => {
  const html = readFileSync(INDEX_HTML, 'utf8');
  const keys = [...html.matchAll(/data-i18n(?:-html|-placeholder)?="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(keys.length > 40, `only ${keys.length} keys in the HTML`);
  const missing = keys.filter((key) => !Object.hasOwn(MESSAGES.en, key));
  assert.deepEqual(missing, []);
});

test('statusText and slotEventText follow the language: tool shows the detail, waiting prefixes it', () => {
  setLanguage('pt');
  assert.equal(statusText('empty'), 'vazio');
  assert.equal(statusText('waiting'), 'esperando você');
  assert.equal(statusText('review'), 'aguardando review');
  assert.equal(slotEventText({ kind: 'starting' }), 'iniciando');
  assert.equal(slotEventText({ kind: 'tool', detail: 'Bash: pnpm test' }), 'Bash: pnpm test');
  assert.equal(slotEventText({ kind: 'waiting', detail: 'permission_prompt' }), 'aguardando: permission_prompt');
  assert.equal(slotEventText({ kind: 'turn' }), 'turno encerrado');
  setLanguage('en');
  assert.equal(statusText('working'), 'working');
  assert.equal(statusText('waiting'), 'waiting for you');
  assert.equal(slotEventText({ kind: 'prompt' }), 'prompt sent');
  assert.equal(slotEventText({ kind: 'tool', detail: 'Bash: pnpm test' }), 'Bash: pnpm test');
  assert.equal(slotEventText({ kind: 'waiting', detail: 'idle_prompt' }), 'waiting: idle_prompt');
  assert.equal(slotEventText({ kind: 'pr' }), 'PR open');
  assert.equal(slotEventText({ kind: 'tool' }), '', 'a tool event without a summary shows nothing');
});

test('t fills {placeholders} from vars and leaves the text alone otherwise', () => {
  setLanguage('en');
  assert.equal(t('header.activeWorkers', { active: 1, max: 2 }), '1/2 active workers');
  assert.equal(t('setup.rules.error', { n: 3 }), 'tier 3: enter max. workers or a signal');
  assert.equal(t('queue.blockedBy', { ids: '4, 5' }), 'blocked by 4, 5');
  assert.match(t('setup.promptPlaceholder'), /\{number\}: \{title\}/, 'no vars: literal braces stay');
  assert.equal(t('limits.at', { other: 'x' }), 'read at {time}', 'an unknown placeholder stays');
  setLanguage('pt');
  assert.equal(t('header.activeWorkers', { active: 1, max: 2 }), '1/2 workers ativos');
  assert.equal(t('setup.rules.error', { n: 3 }), 'faixa 3: informe máx. workers ou sinal');
});
