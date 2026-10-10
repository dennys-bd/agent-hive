import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { WorkspaceBases } from '@/components/settings/WorkspaceBases';
import { setLanguage } from '@/i18n';
import { draftFrom, emptyWorkspace, type SettingsDraft } from '@/lib/settings-form';

const REMOTES = [{ name: 'origin', repository: 'me/app' }, { name: 'upstream', repository: 'acme/app' }];
beforeEach(() => {
  setLanguage('pt');
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(REMOTES), { status: 200, headers: { 'content-type': 'application/json' } })));
});
afterEach(() => vi.unstubAllGlobals());

const draft: SettingsDraft = {
  ...draftFrom(), baseBranch: '',
  workspaces: [
    { ...emptyWorkspace(), name: 'hive', path: '/hive', fork: null },
    { ...emptyWorkspace(), name: 'excalidraw', path: '/ex', fork: { remote: 'upstream', pr: 'original' } },
    { ...emptyWorkspace(), name: 'core', path: '/core', fork: { remote: 'upstream', pr: 'fork', sync: 'manual' } },
  ],
};

test('each workspace\'s base field shows its effective base as the placeholder and the hint for its fork, following the draft live; typing changes that workspace only (#854)', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  const { rerender } = render(<WorkspaceBases draft={draft} onChange={onChange} />);
  expect(screen.getByLabelText('branch base de hive')).toHaveAttribute('placeholder', 'origin/HEAD');
  expect(screen.getByLabelText('branch base de excalidraw')).toHaveAttribute('placeholder', 'upstream/HEAD');
  expect(screen.getByLabelText('branch base de core')).toHaveAttribute('placeholder', 'origin/HEAD');
  expect(screen.getByText('vazio = a padrão do repositório')).toBeInTheDocument();
  expect(await screen.findByText('vazio = a padrão do original, acme/app')).toBeInTheDocument();
  expect(await screen.findByText('vazio = a padrão da fork, me/app')).toBeInTheDocument();
  await user.type(screen.getByLabelText('branch base de core'), 'd');
  expect(onChange).toHaveBeenLastCalledWith({ workspaces: [draft.workspaces[0], draft.workspaces[1], { ...draft.workspaces[2], baseBranch: 'd' }] });
  rerender(<WorkspaceBases draft={{ ...draft, baseBranch: 'main', workspaces: [{ ...draft.workspaces[0], fork: { remote: 'upstream', pr: 'ask', sync: 'github' } }] }} onChange={onChange} />);
  expect(screen.getByLabelText('branch base de hive')).toHaveAttribute('placeholder', 'upstream/main');
});
