import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useBenchmark } from '@/components/benchmark/benchmark-dock';
import { ExperimentHeader } from '@/components/benchmark/ExperimentHeader';
import { setLanguage } from '@/i18n';
import type { Experiment } from '../../src/types';
import { DONE, EXPERIMENTS, stubDownload } from './benchmark-fixtures';

function Head({ experiment }: { experiment: Experiment }) {
  const benchmark = useBenchmark(EXPERIMENTS);
  return <ExperimentHeader benchmark={benchmark} experiment={experiment} />;
}

beforeEach(() => setLanguage('pt'));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test('with the default slots the ⋯ menu offers exportar report.md, which fetches report.md and downloads it (#467)', async () => {
  const user = userEvent.setup();
  const fetchMock = vi.fn(async () => new Response('# report'));
  vi.stubGlobal('fetch', fetchMock);
  const clicks = stubDownload();
  render(<Head experiment={DONE} />);
  await user.click(screen.getByRole('button', { name: 'mais ações' }));
  await user.click(await screen.findByRole('menuitem', { name: 'exportar report.md' }));
  await waitFor(() => expect(clicks).toEqual([{ href: 'blob:report', download: 'report.md' }]));
  expect(fetchMock).toHaveBeenCalledWith(`/benchmark/experiments/${DONE.id}/report.md`);
});
