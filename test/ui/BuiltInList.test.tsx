import { render, screen, within } from '@testing-library/react';
import { beforeEach, expect, test } from 'vitest';
import { NO_BUILT_INS } from '../../src/template';
import type { WorkspaceBuiltIns } from '../../src/types';
import { BuiltInList } from '@/components/plugins/BuiltInList';
import { setLanguage } from '@/i18n';

const BUILT_INS: WorkspaceBuiltIns = {
  'agent-hive': { fork: { remote: 'upstream', pr: 'original', baseRemote: 'upstream' }, baseBranch: 'develop', nestedRepos: ['docs', 'site'], gitlabHosts: ['gitlab.com', 'git.example.com'] },
  'hive-site': NO_BUILT_INS,
};
const WORKSPACES = ['agent-hive', 'hive-site'];
const show = (viewAs?: string) => render(<BuiltInList workspaces={WORKSPACES} values={{ variables: {}, builtIns: BUILT_INS }} viewAs={viewAs} />);
const card = (name: string, list = 'built-in'): HTMLElement => within(screen.getByRole('list', { name: list })).getByRole('listitem', { name });

beforeEach(() => setLanguage('en'));

test('one read-only card per built-in, in the template order, under a built-in region (#742)', () => {
  show();
  const region = screen.getByRole('region', { name: 'built-in' });
  expect(within(region).getAllByRole('listitem').map((li) => li.getAttribute('aria-label'))).toEqual(['workspace', 'fork', 'baseBranch', 'nestedRepos', 'gitlabHosts']);
  for (const role of ['button', 'textbox', 'combobox', 'switch']) expect(within(region).queryAllByRole(role)).toEqual([]);
  expect(within(region).getByText(/never declares them/)).toBeInTheDocument();
});

test('each workspace line shows its value, and absence reads as words in the sans face (#742)', () => {
  show();
  expect(within(card('workspace')).getByTitle('workspace · agent-hive')).toHaveTextContent('agent-hive');
  expect(within(card('fork')).getByTitle('fork · agent-hive')).toHaveTextContent('upstream · PRs to the original');
  expect(within(card('fork')).getByTitle('fork · hive-site')).toHaveTextContent('not a fork');
  expect(within(card('fork')).getByTitle('fork · hive-site')).toHaveClass('text-muted-foreground');
  expect(within(card('fork')).getByTitle('fork · hive-site')).not.toHaveClass('font-mono');
  expect(within(card('baseBranch')).getByTitle('baseBranch · agent-hive')).toHaveTextContent('develop');
  expect(within(card('baseBranch')).getByTitle('baseBranch · agent-hive')).toHaveClass('font-mono');
  expect(within(card('baseBranch')).getByTitle('baseBranch · hive-site')).toHaveTextContent('none');
  expect(within(card('nestedRepos')).getByTitle('nestedRepos · agent-hive')).toHaveTextContent('docs, site');
  expect(within(card('nestedRepos')).getByTitle('nestedRepos · hive-site')).toHaveTextContent('none');
  expect(within(card('gitlabHosts')).getByTitle('gitlabHosts · agent-hive')).toHaveTextContent('gitlab.com, git.example.com');
  expect(within(card('gitlabHosts')).getByTitle('gitlabHosts · agent-hive')).toHaveClass('font-mono');
  expect(within(card('gitlabHosts')).getByTitle('gitlabHosts · hive-site')).toHaveTextContent('gitlab.com'); // #1044: never empty, so no "none"
});

test('the fork line says where the PRs go for each target (#742)', () => {
  const pr = (target: 'fork' | 'ask') => ({ ...BUILT_INS['agent-hive'], fork: { remote: 'upstream', pr: target, baseRemote: 'upstream' } });
  const { rerender } = render(<BuiltInList workspaces={['a']} values={{ variables: {}, builtIns: { a: pr('fork') } }} />);
  expect(screen.getByTitle('fork · a')).toHaveTextContent('upstream · PRs to the fork');
  rerender(<BuiltInList workspaces={['a']} values={{ variables: {}, builtIns: { a: pr('ask') } }} />);
  expect(screen.getByTitle('fork · a')).toHaveTextContent('upstream · asks where each PR goes');
});

test('"view as" dims the other workspaces lines, and none when unset (#742)', () => {
  const { unmount } = show('hive-site');
  expect(within(card('fork')).getByTitle('fork · agent-hive').parentElement).toHaveClass('opacity-40');
  expect(within(card('fork')).getByTitle('fork · hive-site').parentElement).not.toHaveClass('opacity-40');
  unmount();
  show();
  expect(within(card('fork')).getByTitle('fork · agent-hive').parentElement).not.toHaveClass('opacity-40');
});

test('the section is in Portuguese when the language is (#742)', () => {
  setLanguage('pt');
  show();
  expect(screen.getByRole('region', { name: 'embutidas' })).toBeInTheDocument();
  expect(within(card('fork', 'embutidas')).getByTitle('fork · hive-site')).toHaveTextContent('não é fork');
});
