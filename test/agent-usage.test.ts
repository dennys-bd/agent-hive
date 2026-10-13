import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLanguage, tPlural } from '../src/ui/i18n.js';
import { chipTitle, highestPercent, readAgo, refreshTitle, shownReadings, topAgent, usageWindows } from '../src/ui/lib/agent-usage.js';
import type { RateLimits } from '../src/types.js';

const NOW = Date.parse('2026-10-12T12:00:00.000Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const ahead = (ms: number): string => new Date(NOW + ms).toISOString();
const CLAUDE: RateLimits = {
  at: ago(2 * MIN),
  windows: {
    seven_day: { usedPercent: 19.4, resetsAt: ahead((5 * 24 + 3) * HOUR) },
    five_hour: { usedPercent: 4.6, resetsAt: ahead(99 * MIN) },
    seven_day_opus: { usedPercent: 80, resetsAt: ahead(MIN) }, // a window the footer does not show
  },
};
const CODEX: RateLimits = { at: ago(0), windows: { thirty_day: { usedPercent: 91, resetsAt: ahead(HOUR) } } };

test('usageWindows: five_hour, seven_day, thirty_day in that order, rounded; a key the footer does not show is skipped (#223)', () => {
  setLanguage('pt');
  assert.deepEqual(usageWindows(CLAUDE), [
    { key: 'five_hour', short: '5h', long: 'sessão', percent: 5, resetsAt: CLAUDE.windows.five_hour.resetsAt },
    { key: 'seven_day', short: 'sem', long: 'semana', percent: 19, resetsAt: CLAUDE.windows.seven_day.resetsAt },
  ]);
  assert.deepEqual(usageWindows(CODEX).map((w) => [w.short, w.long]), [['30d', '30 dias']]);
  setLanguage('en');
  assert.deepEqual(usageWindows(CLAUDE).map((w) => [w.short, w.long]), [['5h', 'session'], ['wk', 'week']]);
});

test('highestPercent: the highest shown window, rounded; nothing to measure is undefined (#223)', () => {
  assert.equal(highestPercent(CLAUDE), 19, 'seven_day_opus is not shown, so its 80 never counts');
  assert.equal(highestPercent(undefined), undefined);
  assert.equal(highestPercent({ at: ago(0), windows: {} }), undefined);
});

test('topAgent: the highest % in any window, the first on a tie; an agent without a reading wins only when none has one (#223)', () => {
  assert.equal(topAgent(['claude', 'codex'], { claude: CLAUDE, codex: CODEX }), 'codex');
  assert.equal(topAgent(['claude', 'codex'], { claude: CLAUDE }), 'claude');
  assert.equal(topAgent(['claude', 'codex'], { codex: CODEX }), 'codex', 'claude has no reading: it never wins');
  assert.equal(topAgent(['claude', 'codex'], { claude: CODEX, codex: CODEX }), 'claude', 'a tie: the first');
  assert.equal(topAgent(['codex', 'claude'], {}), 'codex', 'none has a reading: the first agent');
  assert.equal(topAgent([], {}), undefined);
});

test('readAgo: agora under a minute, then whole minutes, hours and days; a future or unparseable at reads as now (#223)', () => {
  setLanguage('pt');
  const cases: [number, string][] = [
    [0, 'agora'], [MIN - 1, 'agora'], [MIN, 'há 1 min'], [HOUR - 1, 'há 59 min'],
    [HOUR, 'há 1 h'], [24 * HOUR - 1, 'há 23 h'], [24 * HOUR, 'há 1 d'], [-5 * MIN, 'agora'],
  ];
  for (const [age, text] of cases) assert.equal(readAgo(ago(age), NOW), text, String(age));
  assert.equal(readAgo('not a date', NOW), 'agora');
  setLanguage('en');
  assert.deepEqual([readAgo(ago(0), NOW), readAgo(ago(2 * MIN), NOW), readAgo(ago(3 * HOUR), NOW), readAgo(ago(48 * HOUR), NOW)], ['just now', '2 min ago', '3 h ago', '2 d ago']);
});

test('chipTitle: the agent, each window with its % and reset, and the reading\'s age; without a reading, sem leitura (#223)', () => {
  setLanguage('pt');
  assert.equal(chipTitle('claude', CLAUDE, NOW), 'claude · 5h 5% · reinicia 1h39m · sem 19% · reinicia 5d3h · lido há 2 min');
  assert.equal(chipTitle('codex', undefined, NOW), 'codex · sem leitura');
  setLanguage('en');
  assert.equal(chipTitle('claude', CLAUDE, NOW), 'claude · 5h 5% · resets 1h39m · wk 19% · resets 5d3h · read 2 min ago');
});

test('refreshTitle: atualizar {agent} · lido {ago}, or sem leitura without a reading (#223)', () => {
  setLanguage('pt');
  assert.equal(refreshTitle('claude', CLAUDE, NOW), 'atualizar claude · lido há 2 min');
  assert.equal(refreshTitle('codex', undefined, NOW), 'atualizar codex · sem leitura');
  setLanguage('en');
  assert.equal(refreshTitle('claude', CLAUDE, NOW), 'refresh claude · read 2 min ago');
});

test('the panel counts its agents with a plural (#223)', () => {
  setLanguage('pt');
  assert.deepEqual([tPlural('usage.panel.count', 1, { n: 1 }), tPlural('usage.panel.count', 2, { n: 2 })], ['1 agente', '2 agentes']);
  setLanguage('en');
  assert.deepEqual([tPlural('usage.panel.count', 1, { n: 1 }), tPlural('usage.panel.count', 2, { n: 2 })], ['1 agent', '2 agents']);
});

test('shownReadings: a reading with no window the footer shows reads as no reading (#223)', () => {
  const unknown = { at: ago(0), windows: { seven_day_opus: { usedPercent: 50, resetsAt: ago(0) } } };
  assert.deepEqual(shownReadings({ claude: CLAUDE, codex: unknown }), { claude: CLAUDE });
  assert.deepEqual(shownReadings({ codex: { at: ago(0), windows: {} } }), {});
});
