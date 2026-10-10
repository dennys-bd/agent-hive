import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLanguage, t } from '../src/ui/i18n.js';
import {
  type CommandDraft, commandDraft, commandFrom, commandsProblem, emptyCommand, emptyEnvRow, emptyImpl, type EnvRowDraft, freeWorkspaces, type ImplDraft, missingWorkspaces, overrides, stackedImpls,
} from '../src/ui/lib/settings-commands.js';
import { emptyWorkspace, type WorkspaceDraft } from '../src/ui/lib/settings-form.js';
import { type Command, RESERVED_ENV_NAMES } from '../src/types.js';

const row = (name: string, value: string): EnvRowDraft => ({ ...emptyEnvRow(), name, value });
const workspace = (name: string, env: EnvRowDraft[] = []): WorkspaceDraft => ({ ...emptyWorkspace(), name, path: `/${name}`, env });
const A = workspace('a', [row('PORT', '8')]);
const B = workspace('b', [row('PORT', '3')]);
const impl = (workspace: string | null, command = 'pnpm dev'): ImplDraft => ({ ...emptyImpl(workspace), command });
const command = (patch: Partial<CommandDraft>): CommandDraft => ({ ...emptyCommand(), name: 'dev', impls: [impl(null)], ...patch });

test('commandDraft / commandFrom round-trip a saved command over the workspace rows: a line\'s workspace as a row id, back as its name; own lines by name, the other workspaces last (#755)', () => {
  const saved: Command = { name: 'dev', impls: [{ workspace: 'a', command: 'pytest' }, { workspace: 'b', command: 'pnpm test' }, { workspace: null, command: 'make test' }], menu: false, env: { PORT: '1' }, timeout: '10m' };
  const draft = commandDraft(saved, [A, B]);
  assert.deepEqual(draft.impls.map((i) => [i.workspace, i.command]), [[A.id, 'pytest'], [B.id, 'pnpm test'], [null, 'make test']]);
  assert.deepEqual([draft.menu, draft.timeout], [false, '10m']);
  assert.deepEqual(commandFrom(draft, [A, B]), saved);
  assert.equal('timeout' in commandFrom({ ...draft, timeout: ' ' }, [A, B]), false, 'an empty timeout sends no key');
  const shuffled = { ...draft, impls: [draft.impls[2], draft.impls[1], impl('gone'), draft.impls[0]] };
  assert.deepEqual(commandFrom(shuffled, [A, B]).impls, saved.impls, 'a removed row\'s line is dropped; own lines by name, the other workspaces last');
  assert.deepEqual(commandDraft({ ...saved, impls: [{ workspace: 'nope', command: 'x' }, { workspace: 'a', command: 'y' }] }, [A, B]).impls.map((i) => i.workspace), [A.id], 'an unknown name is dropped');
  assert.deepEqual(
    commandFrom(command({ name: ' dev ', impls: [impl(A.id, ' pnpm dev ')], timeout: ' 30s ' }), [{ ...A, name: ' core ' }]),
    { name: 'dev', impls: [{ workspace: 'core', command: 'pnpm dev' }], menu: true, env: {}, timeout: '30s' },
  );
});

test('emptyCommand runs in all workspaces and is in the menu (#755)', () => {
  const fresh = emptyCommand();
  assert.deepEqual([fresh.name, fresh.impls.map((i) => [i.workspace, i.command]), fresh.menu, fresh.env, fresh.timeout], ['', [[null, '']], true, [], '']);
  assert.notEqual(emptyCommand().id, emptyCommand().id);
});

test('freeWorkspaces offers the workspaces with no line of their own; missingWorkspaces names them only when no line covers the other workspaces; stackedImpls orders own lines by name, the other workspaces last (#755)', () => {
  const own = command({ impls: [impl(B.id)] });
  assert.deepEqual([freeWorkspaces(own, [A, B]), missingWorkspaces(own, [A, B])], [[A], [A]]);
  const covered = command({ impls: [impl(B.id), impl(null)] });
  assert.deepEqual([freeWorkspaces(covered, [A, B]), missingWorkspaces(covered, [A, B])], [[A], []]);
  assert.deepEqual(missingWorkspaces(command({ impls: [] }), [A, B]), [A, B]);
  assert.deepEqual(stackedImpls(command({ impls: [impl(null), impl(B.id), impl('gone'), impl(A.id)] }), [A, B]).map((i) => i.workspace), [A.id, B.id, null]);
});
test('commandsProblem: the workspace env first, then a nameless, duplicate, lineless, bad-timeout or bad-env command, each on workspaces (#511)', () => {
  setLanguage('en');
  const on = (commands: CommandDraft[], workspaces: WorkspaceDraft[] = [A]) => commandsProblem({ workspaces, commands });
  const problem = (message: string) => ({ section: 'workspaces', message });
  assert.equal(on([command({})]), undefined);
  assert.deepEqual(on([command({}), command({ name: ' ' })]), problem(t('settings.error.commandName', { n: 2 })));
  assert.deepEqual(on([command({}), command({ name: ' dev ' })]), problem(t('settings.error.commandDuplicate', { name: 'dev' })));
  assert.deepEqual(on([command({ impls: [] })]), problem(t('settings.error.commandImpls', { name: 'dev' })));
  assert.deepEqual(on([command({ impls: [impl('gone')] })]), problem(t('settings.error.commandImpls', { name: 'dev' })), 'a line of a removed workspace is no line');
  assert.deepEqual(on([command({ impls: [impl(A.id), impl(null, ' ')] })]), problem(t('settings.error.command', { n: 1 })));
  assert.deepEqual(on([command({ timeout: '10' })]), problem(t('settings.error.commandTimeout', { n: 1 })));
  assert.equal(on([command({ timeout: ' 10m ' })]), undefined, 'trimmed');
  assert.deepEqual(on([command({ env: [row('1X', 'y')] })]), problem(t('settings.error.commandEnv', { n: 1 })));
  assert.deepEqual(on([command({ name: '' })], [workspace('a', [row('', 'x')])]), problem(t('settings.error.workspaceEnv', { workspace: 'a' })), 'the workspace env is reported first');
});

test('overrides lists every workspace the command runs in that sets the same name, with its value; none for no match or a blank name (#511, #755)', () => {
  const both = [A, B];
  assert.deepEqual(overrides(command({ impls: [impl(A.id)] }), both, 'PORT'), [{ workspace: 'a', value: '8' }]);
  assert.deepEqual(overrides(command({ impls: [impl(A.id), impl(null)] }), both, 'PORT'), [{ workspace: 'a', value: '8' }, { workspace: 'b', value: '3' }], 'the other workspaces line covers b');
  assert.deepEqual(overrides(command({}), both, 'HOST'), []);
  assert.deepEqual(overrides(command({}), both, ''), []);
});

test('commandsProblem refuses a name the Hive sets, in a workspace env and in a command env, trimmed; PATH and HISTFILE pass (#738)', () => {
  setLanguage('en');
  const on = (commands: CommandDraft[], workspaces: WorkspaceDraft[] = [A]) => commandsProblem({ workspaces, commands });
  const problem = (message: string) => ({ section: 'workspaces', message });
  for (const name of RESERVED_ENV_NAMES) {
    assert.deepEqual(on([command({})], [workspace('a', [row(` ${name} `, 'x')])]), problem(t('settings.error.workspaceEnv', { workspace: 'a' })), name);
    assert.deepEqual(on([command({ env: [row(name, 'x')] })]), problem(t('settings.error.commandEnv', { n: 1 })), name);
  }
  assert.equal(on([command({ env: [row('PATH', '/opt/bin'), row('HISTFILE', '/elsewhere/history')] })], [workspace('a', [row('PATH', '/ws/bin')])]), undefined);
});

test('both env errors name every reserved name, in English and in Portuguese (#738)', () => {
  for (const language of ['en', 'pt'] as const) {
    setLanguage(language);
    for (const key of ['settings.error.workspaceEnv', 'settings.error.commandEnv'] as const) {
      const text = t(key, { workspace: 'a', n: 1 });
      for (const name of RESERVED_ENV_NAMES) assert.ok(text.includes(name), `${language} ${key}: ${name}`);
    }
  }
  setLanguage('en');
});
