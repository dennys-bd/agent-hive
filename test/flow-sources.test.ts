import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLanguage, t } from '../src/ui/i18n.js';
import { sourceSummary, needsGithubToken, NEW_SOURCE_TYPES, newSourceDraft, newSourceProblem } from '../src/ui/lib/flow-sources.js';
import { emptySource } from '../src/ui/lib/settings-form.js';
import type { TaskRuleDraft } from '../src/ui/lib/setup-source-task-props.js';

const fields = { owner: ' acme ', number: '7', name: ' agent-hive ', workspace: 'hive' };

test('sourceSummary: project, filter, then one part per task property in registry order, joined by " · " (#514, #688)', () => {
  setLanguage('pt');
  const gh = { ...emptySource('hive'), name: 'hive', number: '7' };
  assert.equal(sourceSummary(gh, 'agent-hive'), `#7 agent-hive · ${t('settings.sources.noFilter')} · workspace fixo: hive · auto fixo: sim`);
  assert.equal(sourceSummary({ ...gh, number: '' }).split(' · ')[0], t('settings.sources.noProject'));
  assert.equal(sourceSummary(gh).split(' · ')[0], '#7', 'no title until the list loads');
  const one = { ...gh, filter: [{ field: 'assignee' as const, op: 'any' as const, values: ['@me', 'ana'] }] };
  assert.equal(sourceSummary(one).split(' · ')[1], t('settings.sources.filter', { rule: `${t('settings.filter.field.assignee')} ${t('settings.filter.op.any')} @me, ana` }));
  const blocked = { ...gh, filter: [{ field: 'blocked' as const, op: 'any' as const }] };
  assert.equal(sourceSummary(blocked).split(' · ')[1], t('settings.sources.filter', { rule: `${t('settings.filter.op.is')} ${t('settings.filter.field.blocked')}` }));
  assert.equal(sourceSummary({ ...gh, filter: [...one.filter, ...blocked.filter] }).split(' · ')[1], t('settings.sources.filters', { n: 2 }));
  const rule = (set: TaskRuleDraft['set']): TaskRuleDraft => ({ id: 'r', field: 'labels', op: 'icontains', value: 'x', set });
  const routed = { ...gh, taskProps: { defaults: { workspace: '', auto: false }, rules: [rule({ workspace: 'hive' }), rule({ workspace: 'hive', auto: true })] } };
  assert.deepEqual(sourceSummary(routed).split(' · ').slice(2), ['workspace dinâmico, 2 regras', 'auto dinâmico, 1 regra']);
  assert.equal(sourceSummary({ ...routed, taskProps: { ...routed.taskProps, rules: [] } }).split(' · ')[3], 'auto fixo: não');
});

test('newSourceProblem: a picked workspace, a valid free name, a workspace; newSourceDraft builds a fixed github row, trimmed (#514)', () => {
  setLanguage('pt');
  assert.deepEqual(NEW_SOURCE_TYPES, ['github'], 'no Jira adapter yet');
  assert.equal(newSourceProblem(fields, ['work']), undefined);
  assert.equal(newSourceProblem({ ...fields, number: '' }, []), t('settings.error.project'));
  for (const name of ['', 'local', 'hive', '-x', 'a b']) assert.equal(newSourceProblem({ ...fields, name }, []), t('newSource.error.name'), name);
  assert.equal(newSourceProblem(fields, ['agent-hive']), t('settings.error.sourceDuplicate', { name: 'agent-hive' }));
  assert.equal(newSourceProblem({ ...fields, workspace: '' }, []), t('newSource.error.workspace'));
  const row = newSourceDraft(fields);
  assert.deepEqual({ ...row, id: 'x' }, { ...emptySource('hive'), id: 'x', name: 'agent-hive', owner: 'acme', number: '7', type: 'github' });
  assert.equal(row.savedName, '', 'a new row renames nothing (#278)');
});

test('needsGithubToken: only api without a connected account (#514)', () => {
  assert.equal(needsGithubToken('cli', undefined), false);
  assert.equal(needsGithubToken('api', { connected: false }), true);
  assert.equal(needsGithubToken('api', { connected: true, login: 'ana' }), false);
});
