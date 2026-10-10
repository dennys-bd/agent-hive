import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, expect, test, vi } from 'vitest';
import { WorkspaceScopePicker } from '@/components/settings/WorkspaceScopePicker';
import { setLanguage } from '@/i18n';
import type { WorkspaceScope } from '../../src/types';

beforeEach(() => setLanguage('pt'));

function Harness({ initial, onScope }: { initial: WorkspaceScope; onScope(scope: WorkspaceScope): void }) {
  const [scope, setScope] = useState(initial);
  return <WorkspaceScopePicker label="workspaces de ruff" scope={scope} names={['hive', 'web']} onChange={(next) => { onScope(next); setScope(next); }} />;
}

test('all shows one chip, todos os workspaces; unticking a workspace from all leaves the others; unticking all leaves none (#780)', async () => {
  const user = userEvent.setup();
  const onScope = vi.fn();
  render(<Harness initial="all" onScope={onScope} />);
  const button = screen.getByRole('button', { name: 'workspaces de ruff' });
  expect(button).toHaveTextContent('todos os workspaces');
  await user.click(button);
  expect(screen.getByText('todos os workspaces inclui os que você adicionar depois')).toBeInTheDocument();
  await user.click(screen.getByRole('menuitemcheckbox', { name: 'web' }));
  expect(onScope).toHaveBeenLastCalledWith(['hive']);
  await user.click(screen.getByRole('menuitemcheckbox', { name: 'todos os workspaces' }));
  expect(onScope).toHaveBeenLastCalledWith('all');
  await user.click(screen.getByRole('menuitemcheckbox', { name: 'todos os workspaces' }));
  expect(onScope).toHaveBeenLastCalledWith([]);
  await user.keyboard('{Escape}');
  expect(button).toHaveTextContent('nenhum');
});
