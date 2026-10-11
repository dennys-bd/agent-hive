import { expect, test } from 'vitest';
import { readRepoListWidths, writeRepoListWidths } from '@/lib/repo-list-views';
import { readView, resetViewState } from '@/lib/view-state';

test('writeRepoListWidths keeps the other list and the other repositories; readRepoListWidths reads each back (#59)', () => {
  resetViewState({ repoLists: { 'acme/site': { prs: { review: 160 } }, 'acme/other': { issues: { pr: 90 } } } });
  writeRepoListWidths('acme/site', 'issues', { labels: 102 });
  expect(readView('repoLists')).toEqual({ 'acme/site': { prs: { review: 160 }, issues: { labels: 102 } }, 'acme/other': { issues: { pr: 90 } } });
  expect(readRepoListWidths('acme/site', 'issues')).toEqual({ labels: 102 });
  expect(readRepoListWidths('acme/site', 'prs')).toEqual({ review: 160 });
  expect(readRepoListWidths('acme/other', 'prs')).toEqual({});
});

test('readRepoListWidths: nothing saved, or a value it cannot read, is {} (#59)', () => {
  resetViewState();
  expect(readRepoListWidths('acme/site', 'issues')).toEqual({});
  const bad: unknown[] = [null, 'x', [1], { 'acme/site': 'x' }, { 'acme/site': { issues: { labels: '102' } } }, { 'acme/site': { issues: [102] } }];
  for (const value of bad) {
    resetViewState({ repoLists: value });
    expect(readRepoListWidths('acme/site', 'issues')).toEqual({});
  }
  resetViewState({ repoLists: { 'acme/site': { issues: { labels: 102 } } } });
  expect(readRepoListWidths('toString', 'issues')).toEqual({}); // own keys only
});
