import { describe, expect, it } from 'vitest';
import { MESSAGES, type MessageKey } from '@/i18n';

// #570: the ⌘2 view is "tasks" / "tarefas"; "flow" keeps naming only the stages and transitions.
const VIEW_KEYS: MessageKey[] = [
  'rail.flow', 'header.flow', 'dock.automation', 'shortcuts.viewFlow', 'back.flow',
  'home.flow', 'shortcuts.scope.flow', 'detail.showFlow', 'settings.sidebarsPerView.rightTab.hint',
];

describe('the tasks view copy', () => {
  it('never calls the view flow / fluxo', () => {
    for (const key of VIEW_KEYS) {
      expect(MESSAGES.en[key], key).not.toMatch(/\bflow\b/i);
      expect(MESSAGES.pt[key], key).not.toMatch(/fluxo/i);
    }
  });

  it('names the view tasks / tarefas in the rail, header, dock and shortcuts', () => {
    for (const key of ['rail.flow', 'header.flow', 'dock.automation', 'shortcuts.viewFlow'] as const) {
      expect(MESSAGES.en[key], key).toMatch(/tasks/i);
      expect(MESSAGES.pt[key], key).toMatch(/tarefas/i);
    }
  });
});
