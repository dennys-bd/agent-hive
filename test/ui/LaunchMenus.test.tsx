import { render, screen, within } from '@testing-library/react';
import { beforeEach, expect, test } from 'vitest';
import { ModelMenu } from '@/components/LaunchMenus';
import { setLanguage, t } from '@/i18n';
import { CLAUDE_ALIASES, CLAUDE_VERSIONS } from '../../src/agents/claude-models';
import type { AgentId } from '../../src/types';

// #694: the menu open before /launch-options answered, which is what every caller passes until then
const opened = (agent: AgentId) => render(<ModelMenu agent={agent} value="" open onOpenChange={() => undefined} onPick={() => undefined} />);

beforeEach(() => setLanguage('pt'));

test('with no answer yet the Claude menu lists Claude\'s aliases and versions (#694)', () => {
  opened('claude');
  const list = within(screen.getByRole('listbox'));
  expect(list.getByText(t('newSession.model.aliases'))).toBeInTheDocument();
  expect(list.getByText(t('newSession.model.versions'))).toBeInTheDocument();
  for (const { id } of [...CLAUDE_ALIASES, ...CLAUDE_VERSIONS]) expect(list.getByText(id)).toBeInTheDocument();
});

test('with no answer yet the Codex menu lists no model (#694)', () => {
  opened('codex');
  const list = within(screen.getByRole('listbox'));
  expect(list.queryByText(t('newSession.model.aliases'))).not.toBeInTheDocument();
  expect(list.queryByText(t('newSession.model.versions'))).not.toBeInTheDocument();
  expect(list.queryByText(CLAUDE_VERSIONS[0].id)).not.toBeInTheDocument();
});
