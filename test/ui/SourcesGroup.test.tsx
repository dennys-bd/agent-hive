import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { SourcesGroup } from '@/components/settings/SourcesGroup';
import { setLanguage, t } from '@/i18n';
import { emptySource } from '@/lib/settings-form';

const row = (name: string, repository = '') => ({ ...emptySource('hive'), name, savedName: name, number: '1', repository });
const BASE = { githubProjects: {}, auth: 'cli' as const, workspaces: ['hive'], prefix: 'HIVE', onEdit: vi.fn(), onAdd: vi.fn(), onPrefix: vi.fn() };

beforeEach(() => setLanguage('en'));

// A pointer click on a Radix Select trigger can leave it closed in jsdom: the keyboard opens it.
async function openSelect(user: ReturnType<typeof userEvent.setup>, trigger: HTMLElement): Promise<void> {
  trigger.focus();
  await user.keyboard('{Enter}');
}

test('the hive row is a switch that turns off only with a source; create tasks in offers hive while on and every source with a repository (#846)', async () => {
  const user = userEvent.setup();
  const onHiveSource = vi.fn();
  const onCreateIn = vi.fn();
  const sources = [row('roadmap', 'acme/app'), row('notes')];
  const { rerender } = render(<SourcesGroup {...BASE} sources={[]} hiveSource createIn="hive" onHiveSource={onHiveSource} onCreateIn={onCreateIn} />);
  expect(screen.getByRole('switch', { name: t('settings.sources.local.switch') })).toBeDisabled();
  expect(screen.getByText(t('settings.sources.local.needsSource'))).toBeInTheDocument();
  rerender(<SourcesGroup {...BASE} sources={sources} hiveSource createIn="hive" onHiveSource={onHiveSource} onCreateIn={onCreateIn} />);
  await user.click(screen.getByRole('switch', { name: t('settings.sources.local.switch') }));
  expect(onHiveSource).toHaveBeenCalledWith(false);
  await openSelect(user, screen.getByRole('combobox', { name: t('settings.sources.createIn') }));
  expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['hive', 'roadmap']);
  await user.click(screen.getByRole('option', { name: 'roadmap' }));
  expect(onCreateIn).toHaveBeenCalledWith(sources[0].id);
});

test('with hive off, create tasks in lists only the sources with a repository (#846)', async () => {
  render(<SourcesGroup {...BASE} sources={[row('roadmap', 'acme/app')]} hiveSource={false} createIn="x" onHiveSource={vi.fn()} onCreateIn={vi.fn()} />);
  await openSelect(userEvent.setup(), screen.getByRole('combobox', { name: t('settings.sources.createIn') }));
  expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['roadmap']);
});

test('turning hive off while create tasks in is hive moves it to the first source with a repository; with none, or on another source, it is left (#846)', async () => {
  const user = userEvent.setup();
  const onCreateIn = vi.fn();
  const sources = [row('notes'), row('roadmap', 'acme/app')];
  const { rerender } = render(<SourcesGroup {...BASE} sources={sources} hiveSource createIn="hive" onHiveSource={vi.fn()} onCreateIn={onCreateIn} />);
  await user.click(screen.getByRole('switch', { name: t('settings.sources.local.switch') }));
  expect(onCreateIn).toHaveBeenCalledExactlyOnceWith(sources[1].id);
  onCreateIn.mockClear();
  rerender(<SourcesGroup {...BASE} sources={sources} hiveSource createIn={sources[1].id} onHiveSource={vi.fn()} onCreateIn={onCreateIn} />);
  await user.click(screen.getByRole('switch', { name: t('settings.sources.local.switch') }));
  rerender(<SourcesGroup {...BASE} sources={[row('notes')]} hiveSource createIn="hive" onHiveSource={vi.fn()} onCreateIn={onCreateIn} />);
  await user.click(screen.getByRole('switch', { name: t('settings.sources.local.switch') }));
  expect(onCreateIn).not.toHaveBeenCalled();
});
