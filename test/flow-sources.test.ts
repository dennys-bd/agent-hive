import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLanguage, t } from '../src/ui/i18n.js';
import { jiraDefaults, sourceOwner, sourceSummary, TYPE_LABEL, needsGithubToken, NEW_SOURCE_TYPES, newSourceDraft, newSourceProblem } from '../src/ui/lib/flow-sources.js';
import { GITHUB_ENTRY, JIRA_ENTRY } from './fakes.js';
import { EMPTY_JIRA, jiraDraft } from '../src/ui/lib/settings-jira.js';
import { emptySource } from '../src/ui/lib/settings-form.js';
import type { JiraIssueType, JiraLinkType } from '../src/sources/jira-queries.js';
import type { TaskRuleDraft } from '../src/ui/lib/setup-source-task-props.js';

const SCOPE = { flows: [{ id: 'f1', name: 'delivery' }], stages: [] };
const fields = { type: 'github' as const, owner: ' acme ', number: '7', jira: EMPTY_JIRA, name: ' agent-hive ', workspace: 'hive' };

test('sourceSummary: project, filter, then one part per task property in registry order, joined by " · " (#514, #688)', () => {
  setLanguage('pt');
  const gh = { ...emptySource('hive', 'f1'), name: 'hive', number: '7' };
  assert.equal(sourceSummary(gh, SCOPE, 'agent-hive'), `#7 agent-hive · ${t('settings.sources.noFilter')} · workspace fixo: hive · entra em fixo: delivery · auto fixo: sim`);
  assert.equal(sourceSummary({ ...gh, number: '' }, SCOPE).split(' · ')[0], t('settings.sources.noProject'));
  assert.equal(sourceSummary(gh, SCOPE).split(' · ')[0], '#7', 'no title until the list loads');
  const one = { ...gh, filter: [{ field: 'assignee' as const, op: 'any' as const, values: ['@me', 'ana'] }] };
  assert.equal(sourceSummary(one, SCOPE).split(' · ')[1], t('settings.sources.filter', { rule: `${t('settings.filter.field.assignee')} ${t('settings.filter.op.any')} @me, ana` }));
  const blocked = { ...gh, filter: [{ field: 'blocked' as const, op: 'any' as const }] };
  assert.equal(sourceSummary(blocked, SCOPE).split(' · ')[1], t('settings.sources.filter', { rule: `${t('settings.filter.op.is')} ${t('settings.filter.field.blocked')}` }));
  assert.equal(sourceSummary({ ...gh, filter: [...one.filter, ...blocked.filter] }, SCOPE).split(' · ')[1], t('settings.sources.filters', { n: 2 }));
  const rule = (set: TaskRuleDraft['set']): TaskRuleDraft => ({ id: 'r', field: 'labels', op: 'icontains', value: 'x', set });
  const routed = { ...gh, taskProps: { defaults: { workspace: '', auto: false, entry: { flowId: 'f1' } }, rules: [rule({ workspace: 'hive' }), rule({ workspace: 'hive', auto: true })] } };
  assert.deepEqual(sourceSummary(routed, SCOPE).split(' · ').slice(2), ['workspace dinâmico, 2 regras', 'entra em fixo: delivery', 'auto dinâmico, 1 regra']);
  assert.equal(sourceSummary({ ...routed, taskProps: { ...routed.taskProps, rules: [] } }, SCOPE).split(' · ')[4], 'auto fixo: não');
});

test('sourceSummary: the entry part comes right after the workspace part, before auto (#670)', () => {
  setLanguage('en');
  const scope = { flows: [{ id: 'f1', name: 'delivery' }], stages: [] };
  const gh = { ...emptySource('hive', 'f1'), name: 'hive', number: '7' };
  assert.deepEqual(sourceSummary(gh, scope).split(' · ').slice(2), ['workspace fixed: hive', 'enters at fixed: delivery', 'auto fixed: yes']);
  const rule: TaskRuleDraft = { id: 'r', field: 'labels', op: 'icontains', value: 'x', set: { entry: null } };
  const routed = { ...gh, taskProps: { ...gh.taskProps, rules: [rule] } };
  assert.equal(sourceSummary(routed, scope).split(' · ')[3], 'enters at dynamic, 1 rule');
  assert.deepEqual(newSourceDraft(fields, 'f1').taskProps.defaults.entry, { flowId: 'f1' });
});

test('newSourceProblem: a picked workspace, a valid free name, a workspace; newSourceDraft builds a fixed github row, trimmed (#514)', () => {
  setLanguage('pt');
  assert.deepEqual(NEW_SOURCE_TYPES, ['github', 'jira']);
  assert.equal(newSourceProblem(fields, ['work']), undefined);
  assert.equal(newSourceProblem({ ...fields, number: '' }, []), t('settings.error.project'));
  for (const name of ['', 'local', 'hive', '-x', 'a b']) assert.equal(newSourceProblem({ ...fields, name }, []), t('newSource.error.name'), name);
  assert.equal(newSourceProblem(fields, ['agent-hive']), t('settings.error.sourceDuplicate', { name: 'agent-hive' }));
  assert.equal(newSourceProblem({ ...fields, workspace: '' }, []), t('newSource.error.workspace'));
  const row = newSourceDraft(fields, 'f1');
  assert.deepEqual({ ...row, id: 'x' }, { ...emptySource('hive', 'f1'), id: 'x', name: 'agent-hive', owner: 'acme', number: '7', type: 'github' });
  assert.equal(row.savedName, '', 'a new row renames nothing (#278)');
});

test('needsGithubToken: only api without a connected account (#514)', () => {
  assert.equal(needsGithubToken('cli', undefined), false);
  assert.equal(needsGithubToken('api', { connected: false }), true);
  assert.equal(needsGithubToken('api', { connected: true, login: 'ana' }), false);
});

test('a jira source has its label, its site as its owner part, and its type copy in both languages (#820)', () => {
  assert.equal(TYPE_LABEL.jira, 'settings.sources.type.jira');
  assert.deepEqual([sourceOwner(GITHUB_ENTRY), sourceOwner(JIRA_ENTRY)], ['acme', 'acme.example']);
  for (const [language, project] of [['en', 'jira project'], ['pt', 'projeto jira']] as const) {
    setLanguage(language);
    assert.deepEqual([t('settings.sources.type.jira'), t('flow.source.type.jira'), t('tasks.header.source.jira')], ['Jira', project, project], language);
  }
});

test('a jira row\'s summary starts with its project key (#820)', () => {
  setLanguage('pt');
  assert.equal(sourceSummary({ ...emptySource('hive', 'f1'), name: 'tickets', type: 'jira', jira: jiraDraft(JIRA_ENTRY) }, SCOPE).split(' · ')[0], 'ABC');
});

test('a jira row with no project yet reads as none in its summary (#822)', () => {
  setLanguage('pt');
  assert.equal(sourceSummary({ ...emptySource('hive', 'f1'), name: 'tickets', type: 'jira' }, SCOPE).split(' · ')[0], t('settings.sources.noProject'));
});

const LINKS: JiraLinkType[] = [{ name: 'Relates', inward: 'relates to', outward: 'relates to' }, { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }];

test('jiraDefaults picks Done, Task, Subtask and Blocks when the project has them, both tree levels on (#822)', () => {
  const types: JiraIssueType[] = [{ id: '1', name: 'Story', subtask: false, hierarchyLevel: 0 }, { id: '2', name: 'Task', subtask: false, hierarchyLevel: 0 }, { id: '3', name: 'Sub-task', subtask: true, hierarchyLevel: -1 }, { id: '4', name: 'Subtask', subtask: true, hierarchyLevel: -1 }];
  assert.deepEqual(jiraDefaults(['To Do', 'Done', 'Archived'], types, LINKS), {
    tree: { epics: true, subtasks: true }, blockingLinkTypes: ['Blocks'], issueType: 'Task', subtaskType: 'Subtask', doneStatus: 'Done',
  });
});

test('jiraDefaults falls back to the last status, the first type of each kind, an empty sub-task type and no blocking link type (#822)', () => {
  const types: JiraIssueType[] = [{ id: '1', name: 'Story', subtask: false, hierarchyLevel: 0 }, { id: '2', name: 'Bug', subtask: false, hierarchyLevel: 0 }, { id: '3', name: 'Sub-task', subtask: true, hierarchyLevel: -1 }];
  assert.deepEqual(jiraDefaults(['Open', 'Closed'], types, LINKS.slice(0, 1)), {
    tree: { epics: true, subtasks: true }, blockingLinkTypes: [], issueType: 'Story', subtaskType: 'Sub-task', doneStatus: 'Closed',
  });
  const bare = jiraDefaults([], types.slice(0, 2), []);
  assert.deepEqual([bare.subtaskType, bare.doneStatus], ['', ''], 'no sub-task type and no status: left empty for validateSettings to refuse');
});

test('newSourceProblem refuses a jira row with no site or no project; newSourceDraft builds a complete jira row (#822)', () => {
  setLanguage('pt');
  const jira = { ...EMPTY_JIRA, site: 'acme.atlassian.net', project: 'ABC', issueType: 'Task', subtaskType: 'Subtask', doneStatus: 'Done', blockingLinkTypes: ['Blocks'] };
  const picked = { ...fields, type: 'jira' as const, number: '', jira };
  assert.equal(newSourceProblem(picked, []), undefined, 'a jira row needs no GitHub project number');
  assert.equal(newSourceProblem({ ...picked, jira: { ...jira, site: '' } }, []), t('newSource.error.site'));
  assert.equal(newSourceProblem({ ...picked, jira: { ...jira, project: '' } }, []), t('settings.error.project'));
  const row = newSourceDraft(picked, 'f1');
  assert.deepEqual({ ...row, id: 'x' }, { ...emptySource('hive', 'f1'), id: 'x', type: 'jira', name: 'agent-hive', jira });
  assert.deepEqual(row.jira.tree, { epics: true, subtasks: true });
});
