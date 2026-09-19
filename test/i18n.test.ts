import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOCALE, MESSAGES, setLanguage, slotEventText, statusText, t } from '../src/ui/i18n.js';

test('pt and en have exactly the same keys and no empty text', () => {
  const en = Object.keys(MESSAGES.en).sort();
  assert.deepEqual(Object.keys(MESSAGES.pt).sort(), en);
  assert.ok(en.length > 60, `only ${en.length} keys`);
  for (const language of ['pt', 'en'] as const) {
    for (const [key, text] of Object.entries(MESSAGES[language])) assert.ok(text.trim().length > 0, `${language}.${key} is empty`);
  }
  assert.deepEqual(LOCALE, { pt: 'pt-BR', en: 'en-US' });
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
  assert.equal(slotEventText({ kind: 'continuing' }), 'continuando na mesma sessão');
  setLanguage('en');
  assert.equal(statusText('working'), 'working');
  assert.equal(statusText('waiting'), 'waiting for you');
  assert.equal(slotEventText({ kind: 'prompt' }), 'prompt sent');
  assert.equal(slotEventText({ kind: 'tool', detail: 'Bash: pnpm test' }), 'Bash: pnpm test');
  assert.equal(slotEventText({ kind: 'waiting', detail: 'idle_prompt' }), 'waiting: idle_prompt');
  assert.equal(slotEventText({ kind: 'pr' }), 'PR open');
  assert.equal(slotEventText({ kind: 'continuing' }), 'continuing in the same session');
  assert.equal(slotEventText({ kind: 'tool' }), '', 'a tool event without a summary shows nothing');
});

test('t fills {placeholders} from vars and leaves the text alone otherwise', () => {
  setLanguage('en');
  assert.equal(t('header.activeWorkers', { active: 1, max: 2 }), '1/2 active workers');
  assert.equal(t('setup.rules.error', { n: 3 }), 'tier 3: enter max. workers or a signal');
  assert.equal(t('card.blockedBy', { ids: '4, 5' }), 'blocked by 4, 5');
  assert.match(t('setup.columns.hint'), /\{id\}/, 'no vars: literal braces stay');
  assert.equal(t('setup.columns.error', { n: 2 }), 'column 2: enter a name, an integer weight ≥ 0 and, if set, an integer visible ≥ 0');
  assert.equal(t('column.cards', { n: 13 }), '13 cards');
  assert.equal(t('column.weight', { w: 3 }), 'weight 3');
  assert.equal(t('column.more', { n: 8 }), '+8 more');
  assert.equal(t('limits.at', { other: 'x' }), 'read at {time}', 'an unknown placeholder stays');
  setLanguage('pt');
  assert.equal(t('header.activeWorkers', { active: 1, max: 2 }), '1/2 workers ativos');
  assert.equal(t('setup.rules.error', { n: 3 }), 'faixa 3: informe máx. workers ou sinal');
  assert.equal(t('column.more', { n: 8 }), '+8 mais');
  assert.equal(t('column.less'), 'mostrar menos');
});

test('the board and column keys exist in both languages', () => {
  for (const key of ['board.title', 'card.start', 'card.missing', 'card.close', 'card.keep', 'card.orphan', 'confirm.close', 'setup.columns', 'setup.columns.add', 'setup.columns.hint', 'setup.columns.error', 'column.cards', 'column.weight', 'column.more', 'column.less', 'setup.columns.visible'] as const) {
    assert.ok(MESSAGES.en[key].length > 0 && MESSAGES.pt[key].length > 0, key);
  }
  assert.equal('queue.title' in MESSAGES.en, false, 'the queue panel is gone');
  assert.equal('event.paused' in MESSAGES.en, false);
});
