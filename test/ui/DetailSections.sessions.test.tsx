import { render, screen, within } from '@testing-library/react';
import { beforeEach, expect, test } from 'vitest';
import { SessionsList } from '@/components/DetailSections';
import { setLanguage } from '@/i18n';
import type { Session, Task } from '../../src/types';

const USED = '2026-09-24T15:30:00.000Z';
const task: Task = { item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true };
const ran: Session = { id: 'aaaaaaaa-0000-4000-8000-000000000001', startedAt: USED, stages: ['spec', 'dev'], lastUsedAt: USED };
const free: Session = { id: 'bbbbbbbb-0000-4000-8000-000000000002', startedAt: USED, stages: [], lastUsedAt: USED, free: true };
const answered: Session = { ...free, id: 'cccccccc-0000-4000-8000-000000000003', stages: ['spec'] }; // a feedback run gave it its stage
beforeEach(() => setLanguage('pt'));

test('the session list names a free session sessão livre, before the stages a feedback run gave it; a stage run\'s lists its stages; all still open and clear (#812)', () => {
  const state = { workers: [], activities: [], activityRecords: [{ id: 'a-I1', taskIds: ['I1'], sessions: [ran, free, answered] }] }; // the task's record (#629)
  render(<SessionsList task={task} state={state} locale="pt-BR" />);
  const time = new Date(USED).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const items = within(screen.getByRole('region', { name: 'sessões' })).getAllByRole('listitem').map((li) => li.textContent);
  expect(items).toEqual([
    `aaaaaaaaspec → dev · ${time}abrirlimpar`, `bbbbbbbbsessão livre · ${time}abrirlimpar`, `ccccccccsessão livre · spec · ${time}abrirlimpar`,
  ]);
});
