import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ProjectCreatePopover } from '@/components/ProjectCreatePopover';
import { setLanguage, t } from '@/i18n';
import { CreateTargetsContext, HIVE_ONLY } from '@/lib/create-targets';
import type { State } from '../../src/types';

const STATE = { stages: [{ name: 'fila', from: {} }], workspaces: ['hive'] } as unknown as State; // only what the popover reads
const ITEM = { id: '12', title: 'Fix login', body: 'steps', url: 'https://github.com/acme/app/issues/12', itemId: 'roadmap:PVTI_12' };
const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'HIVE-1', itemId: 'local:1' }), { status: 201, headers: { 'content-type': 'application/json' } }));

beforeEach(() => { setLanguage('en'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

test('fluxo… creates a hive task, naming hive as its source; with hive off it is not offered (#846)', async () => {
  const user = userEvent.setup();
  const { unmount } = render(<ProjectCreatePopover item={ITEM} source="roadmap" state={STATE} onCreated={vi.fn()} />);
  await user.click(screen.getByRole('button', { name: t('project.action.create') }));
  await user.click(screen.getByRole('button', { name: t('project.create.confirm') }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(JSON.parse(String(init.body))).toMatchObject({ source: 'hive', origin: 'roadmap:PVTI_12', auto: false });
  unmount();
  render(<CreateTargetsContext.Provider value={{ ...HIVE_ONLY, hiveSource: false }}><ProjectCreatePopover item={ITEM} source="roadmap" state={STATE} onCreated={vi.fn()} /></CreateTargetsContext.Provider>);
  expect(screen.queryByRole('button', { name: t('project.action.create') })).toBeNull();
});
