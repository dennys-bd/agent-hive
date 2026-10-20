import { expect, test } from 'vitest';
import { MESSAGES, type MessageKey } from '@/i18n';

const KEYS: MessageKey[] = [
  'plugins.assist.placeholder', 'plugins.assist.running', 'plugins.assist.marked', 'plugins.assist.noChange', 'plugins.assist.accept',
  'plugins.assist.discard', 'plugins.assist.acceptNote', 'plugins.assist.proposal', 'plugins.assist.chip', 'plugins.assist.busy',
  'plugins.assist.unavailable', 'plugins.assist.badAnswer', 'plugins.assist.failed', 'plugins.assist.unexpected', 'shortcuts.askAgent',
];

test('every copy of ask the agent exists in English and Portuguese, and the Portuguese says executar, never rodar (#331)', () => {
  for (const key of KEYS) {
    expect(MESSAGES.en[key], key).toBeTruthy();
    expect(MESSAGES.pt[key], key).toBeTruthy();
    expect(MESSAGES.pt[key], key).not.toMatch(/\brod(ar|a)\b/);
  }
  expect([MESSAGES.en['plugins.assist.marked'], MESSAGES.pt['plugins.assist.acceptNote']]).toEqual(['change marked in the text (lines {from}–{to})', 'o revisor executa de novo depois']);
});
