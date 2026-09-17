import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Setup } from '@/components/setup/Setup';
import { setLanguage, t } from '@/i18n';
import type { SetupInfo } from '../../src/types';

const info: SetupInfo = {
  configured: true, repo: '/repo', language: 'pt',
  config: {
    board: { type: 'github', owner: 'acme', number: 1 }, workers: 'embedded', epics: 'ignore', logLevel: 'info',
    columns: [], maxConcurrent: 0, port: 47821, claudeArgs: [], budget: {}, usageRules: [],
  },
};

const jsonResponse = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.startsWith('/setup/projects')) return jsonResponse([{ number: 1, title: 'One', url: '' }, { number: 2, title: 'Two', url: '' }]);
  if (url.startsWith('/setup/columns')) return jsonResponse(['Ready', 'In progress']);
  return jsonResponse({});
});

beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

test('picking a different project loads columns for the newly picked project, not the one left behind', async () => {
  const user = userEvent.setup();
  render(<Setup info={info} onSaved={vi.fn()} />);

  // the mount effect loads the current project's (1) columns; wait for it to settle before the assertion below.
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/setup/columns?type=github&owner=acme&number=1'));
  fetchMock.mockClear();

  await user.click(screen.getByLabelText(t('setup.project')));
  await user.click(await screen.findByRole('option', { name: '#2 Two' }));

  await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith('/setup/columns?type=github&owner=acme&number=2'));
});
