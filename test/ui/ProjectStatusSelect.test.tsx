import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ProjectStatusSelect } from '@/components/ProjectStatusSelect';
import { setLanguage } from '@/i18n';
import type { ProjectItem } from '../../src/types';

const ROW: ProjectItem = { itemId: 'roadmap:PVTI_3', id: '3', title: 'T', body: '', url: 'https://github.com/acme/r/issues/3', status: 'Done', labels: [], assignees: [], fields: {}, pullRequests: [] };

const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ fields: [], row: ROW }), { status: 200, headers: { 'content-type': 'application/json' } }));
beforeEach(() => { setLanguage('pt'); fetchMock.mockClear(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => vi.unstubAllGlobals());

test('the status select lists each option with its stage or —, notes where the mapping lives, and posts the chosen option and hands up the re-read row (#756, #686)', async () => {
  const user = userEvent.setup();
  const onRow = vi.fn();
  render(<ProjectStatusSelect source="roadmap" itemId="roadmap:PVTI_3" status="Todo" statuses={[{ name: 'Todo' }, { name: 'Ready', stage: 'dev' }, { name: 'Done' }]} onRow={onRow} />);
  expect(screen.getByRole('button', { name: 'Todo' })).toHaveAttribute('data-slot', 'field-cell');
  screen.getByRole('button', { name: 'Todo' }).focus();
  await user.keyboard('{Enter}');
  expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Todo—', 'Readydev', 'Done—']);
  expect(screen.getByText('status')).toBeInTheDocument();
  expect(screen.getByText('etapa no fluxo')).toBeInTheDocument();
  expect(screen.getByText('as opções vêm do project. o mapeamento para etapas fica em configurar › sources.')).toBeInTheDocument();
  await user.click(screen.getByRole('menuitem', { name: /^Done/ }));
  await waitFor(() => expect(onRow).toHaveBeenCalledWith(ROW));
  expect(fetchMock).toHaveBeenCalledWith('/sources/roadmap/project/status', expect.objectContaining({ method: 'POST', body: JSON.stringify({ itemId: 'roadmap:PVTI_3', status: 'Done' }) }));
});
