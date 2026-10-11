import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOCALE, MESSAGES, setLanguage, workerEventText, statusText, t, tPlural } from '../src/ui/i18n.js';

test('pt and en have exactly the same keys and no empty text', () => {
  const en = Object.keys(MESSAGES.en).sort();
  assert.deepEqual(Object.keys(MESSAGES.pt).sort(), en);
  assert.ok(en.length > 60, `only ${en.length} keys`);
  for (const language of ['pt', 'en'] as const) {
    for (const [key, text] of Object.entries(MESSAGES[language])) assert.ok(text.trim().length > 0, `${language}.${key} is empty`);
  }
  assert.deepEqual(LOCALE, { pt: 'pt-BR', en: 'en-US' });
});

test('statusText and workerEventText follow the language: tool shows the detail, waiting prefixes it', () => {
  setLanguage('pt');
  assert.equal(statusText('empty'), 'vazio');
  assert.equal(statusText('waiting'), 'esperando você');
  assert.equal(statusText('review'), 'aguardando review');
  assert.equal(statusText('approval'), 'aguardando aprovação');
  assert.equal(workerEventText({ kind: 'starting' }), 'iniciando');
  assert.equal(workerEventText({ kind: 'tool', detail: 'Bash: pnpm test' }), 'Bash: pnpm test');
  assert.equal(workerEventText({ kind: 'waiting', detail: 'permission_prompt' }), 'aguardando: permission_prompt');
  assert.equal(workerEventText({ kind: 'turn' }), 'turno encerrado');
  assert.equal(workerEventText({ kind: 'continuing' }), 'continuando na mesma sessão');
  assert.equal(workerEventText({ kind: 'ask' }), 'perguntou');
  assert.equal(t('task.setupStep', { detail: 'RUN pnpm install' }), 'preparando: RUN pnpm install'); // #351: the task's, no longer a worker event
  assert.equal(workerEventText({ kind: 'background', detail: '2' }), 'em segundo plano: 2'); // #367
  setLanguage('en');
  assert.equal(statusText('working'), 'working');
  assert.equal(statusText('waiting'), 'waiting for you');
  assert.equal(statusText('approval'), 'awaiting approval');
  assert.equal(workerEventText({ kind: 'prompt' }), 'prompt sent');
  assert.equal(workerEventText({ kind: 'tool', detail: 'Bash: pnpm test' }), 'Bash: pnpm test');
  assert.equal(workerEventText({ kind: 'waiting', detail: 'idle_prompt' }), 'waiting: idle_prompt');
  assert.equal(workerEventText({ kind: 'pr' }), 'PR open');
  assert.equal(workerEventText({ kind: 'continuing' }), 'continuing in the same session');
  assert.equal(workerEventText({ kind: 'ask' }), 'asked');
  assert.equal(t('task.setupStep', { detail: 'COPY .env' }), 'preparing: COPY .env');
  assert.equal(workerEventText({ kind: 'background', detail: '1' }), 'in the background: 1');
  assert.equal(workerEventText({ kind: 'tool' }), '', 'a tool event without a summary shows nothing');
});

test('t fills {placeholders} from vars and leaves the text alone otherwise', () => {
  setLanguage('en');
  assert.equal(t('footer.workers', { active: 1, max: 2 }), 'workers 1/2');
  assert.equal(t('settings.rules.error', { n: 3, source: 'x' }), 'rule 3 (x): set a percentage 0–100, a consequence and its value');
  assert.equal(t('settings.rules.measure.session'), 'session window (5h)');
  assert.equal(t('footer.rule.cap', { n: 4 }), 'max 4 workers');
  assert.equal(t('task.blockedBy', { ids: '4, 5' }), 'blocked by 4, 5');
  assert.equal(t('stage.resetSourceOrder'), 'reset to source order');
  assert.equal(t('stage.actions'), 'stage actions');
  assert.equal(t('task.drag'), 'drag to reorder');
  assert.match(t('settings.stages.prompt.hint'), /\{id\}/, 'no vars: literal braces stay');
  assert.equal(t('settings.stages.error', { n: 2 }), 'stage 2: enter a name and, if set, max. workers ≥ 0 and an after like "30m", "12h" or "5d"');
  assert.match(t('settings.stages.maxWorkers.hint'), /a later stage takes a free worker first/); // #316, #524: moved from the removed help paragraph
  assert.doesNotMatch(t('settings.stages.maxWorkers.hint'), /weight/i);
  assert.equal(t('limits.at', { other: 'x' }), 'read at {time}', 'an unknown placeholder stays');
  setLanguage('pt');
  assert.equal(t('settings.section.rules.hint'), 'tokens, GitHub, regras de uso'); // #526
  assert.equal(t('settings.stages.error', { n: 2 }), 'etapa 2: informe nome e, se preenchidos, máx. workers inteiro ≥ 0 e depois de como "30m", "12h" ou "5d"');
  assert.match(t('settings.stages.maxWorkers.hint'), /etapa mais adiante pega o worker livre primeiro/);
  assert.doesNotMatch(t('settings.stages.maxWorkers.hint'), /peso/i);
  assert.equal(t('footer.workers', { active: 1, max: 2 }), 'workers 1/2');
  assert.equal(t('settings.rules.error', { n: 3, source: 'x' }), 'regra 3 (x): preencha um percentual 0–100, uma consequência e o valor');
  assert.equal(t('settings.rules.effect.maxWorkers'), 'limitar workers a');
  assert.equal(t('signal.locked', { rules: 'sessão ≥ 80%' }), 'travado pela regra: sessão ≥ 80%');
});

test('the flow and stage keys exist in both languages', () => {
  for (const key of ['task.start', 'task.missing', 'task.close', 'task.keep', 'task.freeSession', 'confirm.close', 'confirm.closeMissing', 'confirm.closeMissingAll', 'confirm.closeMissingRunning', 'stage.missing', 'stage.closeMissing', 'confirm.deleteActivity', 'detail.deleteActivity', 'detail.deleteActivityBlocked.running', 'detail.deleteActivityBlocked.deleting', 'detail.deleteActivityBlocked.nothingToDelete', 'confirm.forceDeleteActivity', 'task.force', 'settings.stages', 'settings.stages.add', 'settings.stages.error', 'flow.end', 'flow.node.list', 'flow.list.footer', 'activity.delete', 'task.delete', 'settings.stages.action', 'settings.stages.action.prompt', 'settings.stages.action.deleteActivity', 'settings.stages.after', 'settings.rules.from', 'settings.rules.value', 'settings.group.rules.hint', 'settings.rules.measure', 'settings.rules.now', 'settings.rules.caption', 'settings.rules.measure.week', 'settings.rules.effect', 'settings.rules.effect.maxWorkers', 'settings.rules.effect.signal', 'settings.rules.effect.stageWorkers', 'settings.baseBranch', 'settings.baseBranch.auto', 'settings.baseBranch.hint', 'signal.locked', 'maxWorkers.locked', 'footer.rules', 'footer.paused', 'pause.title', 'pause.resume', 'settings.section.maintenance', 'worktrees.empty', 'worktrees.noTask', 'worktrees.detached', 'worktrees.deleteActivityFailed', 'worktrees.cleanOrphans', 'worktrees.removed', 'worktrees.refused', 'worktrees.hint', 'worktrees.remove', 'confirm.removeOrphanWorktree', 'confirm.cleanOrphans'] as const) {
    assert.ok(MESSAGES.en[key].length > 0 && MESSAGES.pt[key].length > 0, key);
  }
  for (const key of ['task.markManual', 'task.unmarkManual', 'task.cleanup', 'task.manual', 'task.noProject']) {
    assert.equal(key in MESSAGES.en || key in MESSAGES.pt, false, `${key} is gone (#542)`);
  }
  assert.equal('setup.stages.weight' in MESSAGES.en || 'setup.stages.weight' in MESSAGES.pt, false, 'setup.stages.weight is gone (#316)');
  const retired = (key: string): boolean => key.split('.')[0] === 'column';
  assert.equal([...Object.keys(MESSAGES.en), ...Object.keys(MESSAGES.pt)].some(retired), false, 'no key keeps the column prefix (#316, #542, #572)');
  for (const key of ['setup.terminal', 'setup.terminal.internal', 'setup.terminal.fallback', 'focus.attach']) assert.equal(key in MESSAGES.en || key in MESSAGES.pt, false, `${key} is gone (#378)`);
  assert.equal('queue.title' in MESSAGES.en, false, 'the queue panel is gone');
  assert.equal('event.paused' in MESSAGES.en, false);
  assert.equal('setup.rules.signal' in MESSAGES.en, false, 'the signal is a consequence now');
  for (const key of ['setup.rules.source', 'setup.rules.addEffect', 'setup.rules.stageSignal'] as const) assert.equal(key in MESSAGES.en, false, `${key}: one consequence per row (#512)`);
  for (const key of ['setup.rules.measuredIn', 'setup.ladder.label']) assert.equal(key in MESSAGES.en || key in MESSAGES.pt, false, `${key} is gone (#526)`);
  assert.equal('confirm.kill' in MESSAGES.en, false, 'the action is close now');
  assert.equal('confirm.raiseMax' in MESSAGES.en, false, 'a start over the cap needs no approval (#116)');
  assert.equal(MESSAGES.en['confirm.deleteActivity'].includes('too'), false, 'close no longer asks about the worktree (#182); task.remove is back only as the local task remove (#132)');
  assert.equal('detail.removeWorktree' in MESSAGES.en, false, 'renamed detail.deleteActivity: the detail button is the delete activity (#210)');
  for (const key of ['task.createWorktree', 'session.claudeNew', 'session.resume']) {
    assert.equal(key in MESSAGES.en, false, `${key}: a manual task starts in one popup now (#237)`);
  }
  for (const key of ['card.session', 'task.session', 'slot.approvalLeft', 'terminal.panel.kind.shell']) assert.equal(key in MESSAGES.en || key in MESSAGES.pt, false, `${key}: the glossary's name now (#570)`);
  assert.deepEqual(
    [MESSAGES.en['start.mode.free'], MESSAGES.pt['start.mode.free'], MESSAGES.en['terminal.panel.kind.terminal'], MESSAGES.pt['terminal.panel.kind.terminal']],
    ['free session', 'sessão livre', 'terminal', 'terminal'],
    'free session, not open session; terminal, not shell (#570)',
  );
  assert.ok(MESSAGES.en['worker.approvalLeft'].length > 0 && MESSAGES.pt['worker.approvalLeft'].length > 0);
  assert.deepEqual([MESSAGES.en['detail.deleteActivity'], MESSAGES.pt['detail.deleteActivity']], ['delete activity', 'excluir atividade']); // the delete activity confirm's button (#573)
  for (const key of ['confirm.deleteActivity', 'confirm.cleanOrphans'] as const) assert.equal(/sessions? (of the tasks that own them )?are deleted/.test(MESSAGES.en[key]), false, `${key}: the task keeps its session (#210)`);
  // #524: the help paragraph is gone; what it said about delete activity and about archive/remove/delete now lives on the fields that describe
  // them. The paragraph's "cleanup retries" detail is dropped on purpose, per the issue.
  // them. The paragraph's "delete activity retries" detail is dropped on purpose, per the issue.
  assert.equal('settings.stages.hint' in MESSAGES.en || 'settings.stages.hint' in MESSAGES.pt, false, 'the help paragraph became field hints (#524)');
  assert.match(MESSAGES.en['settings.stages.action.deleteActivity.hint'], /never uses force/);
  assert.match(MESSAGES.pt['settings.stages.action.deleteActivity.hint'], /nunca usa force/);
  assert.match(MESSAGES.pt['settings.stages.exit.actionsHint'], /tiram a tarefa do Hive/); // #286
  assert.match(MESSAGES.en['settings.stages.exit.actionsHint'], /take the task out of the Hive/);
  assert.deepEqual(['archive', 'remove', 'close', 'delete'].map((a) => MESSAGES.pt[`settings.stages.finish.${a}` as keyof typeof MESSAGES.pt]), ['arquivar', 'remover da source', 'concluir', 'apagar'], 'the sai block\'s words (#515)');
});

test('no copy says board in either language, and no key keeps the board prefix (#703)', () => {
  for (const language of ['en', 'pt'] as const) {
    const saying = Object.entries(MESSAGES[language]).filter(([, text]) => /\bboard\b/i.test(text)).map(([key]) => key);
    assert.deepEqual(saying, [], language);
    assert.deepEqual(Object.keys(MESSAGES[language]).filter((key) => key.split('.')[0] === 'board'), [], `${language}: board.title is gone`);
  }
  assert.deepEqual([MESSAGES.en['settings.back'], MESSAGES.pt['settings.back']], ['back', 'voltar'], 'the button returns to whichever view was open (#510)');
});

test('the agent copy (#516): neutral delete activity texts, the execution hint, the new keys in both languages; only the open-session kind names Claude', (ctx) => {
  ctx.after(() => setLanguage('en'));
  for (const language of ['pt', 'en'] as const) {
    for (const key of ['confirm.deleteActivity.session', 'settings.deleteActivity.session', 'settings.deleteActivity.transcripts.hint'] as const) assert.doesNotMatch(MESSAGES[language][key], /claude/i, `${language}.${key}`);
    const naming = Object.entries(MESSAGES[language]).filter(([, text]) => /claude/i.test(text)).map(([key]) => key);
    assert.deepEqual(naming, ['session.claude'], language);
  }
  assert.deepEqual([MESSAGES.pt['settings.section.execution.hint'], MESSAGES.en['settings.section.execution.hint']], ['agente, branches, excluir atividade', 'agent, branches, delete activity']);
  assert.deepEqual([MESSAGES.pt['settings.defaultAgent'], MESSAGES.en['settings.defaultAgent']], ['agente padrão', 'default agent']);
  assert.match(MESSAGES.pt['settings.defaultAgent.hint'], /^usado quando a etapa não escolhe outro/);
  setLanguage('pt');
  assert.deepEqual([t('settings.stages.agent.default', { agent: 'claude' }), t('settings.agent.offPath')], ['padrão (claude)', 'fora do PATH']);
  assert.equal(t('settings.defaultAgent.missing', { agent: 'claude' }), 'claude está fora do PATH: as etapas dele não começam até ele ser instalado e o Hive reiniciado');
});

test('the main process texts follow the language: the Quit / Restart confirmation by count, its buttons, the menu lines (#242)', (ctx) => {
  ctx.after(() => setLanguage('en'));
  setLanguage('pt');
  assert.equal(tPlural('main.confirm.quit', 1, { n: 1 }), '1 worker está executando e será parado. Sair mesmo assim?');
  assert.equal(tPlural('main.confirm.quit', 3, { n: 3 }), '3 workers estão executando e serão parados. Sair mesmo assim?');
  assert.equal(tPlural('main.confirm.restart', 3, { n: 3 }), '3 workers estão executando e serão parados. Reiniciar mesmo assim?');
  assert.deepEqual([t('main.quit'), t('main.restart'), t('main.cancel'), t('main.settings')], ['Sair', 'Reiniciar', 'Cancelar', 'Configurações…']);
  assert.equal(t('main.signalHeld', { signal: 'Red' }), 'Sinal: Red (regra de uso)', 'the signal name is never translated');
  setLanguage('en');
  assert.equal(tPlural('main.confirm.quit', 1, { n: 1 }), '1 worker is running and will be stopped. Quit anyway?');
  assert.equal(tPlural('main.confirm.quit', 3, { n: 3 }), '3 workers are running and will be stopped. Quit anyway?');
  assert.equal(tPlural('main.confirm.restart', 1, { n: 1 }), '1 worker is running and will be stopped. Restart anyway?');
  assert.deepEqual([t('main.status.blocked'), t('main.noWorkers'), t('main.menu.front')], ['Hive can\'t start', 'No workers running', 'Bring All to Front']);
});

test('the execution copy (#527)', () => {
  assert.deepEqual(
    [
      MESSAGES.pt['settings.approvalMinutes.hint'], MESSAGES.pt['settings.shutdownIdle.hint'], MESSAGES.pt['settings.group.branches.hint'],
      MESSAGES.pt['settings.deleteActivity'], MESSAGES.pt['settings.deleteActivity.hint'], MESSAGES.pt['settings.branch.insert'],
    ],
    [
      'quanto tempo o worker que espera aprovação fica aberto. só segura se a próxima etapa tiver vaga; depois disso, fecha e a tarefa continua esperando.',
      'só para tarefas com "desligar" armado: fecha o worker que ficou parado, esperando resposta.',
      'usados quando a etapa executa sozinha · ao iniciar uma tarefa na mão, o diálogo pergunta',
      'excluir atividade',
      'sempre a worktree, o branch local e os terminais · o branch remoto e a memória do agente nunca são tocados',
      'inserir',
    ],
  );
  assert.ok(!('settings.branch.hint' in MESSAGES.en) && !('settings.branch.hint' in MESSAGES.pt));
  assert.equal(MESSAGES.pt['settings.baseBranch.hint'], 'de onde partem as worktrees que os workers criam · vazio = a branch padrão do repositório base'); // #854: the handoff's hint
});

test('the glossary sweep (#573): no settings-screen setup. key and no limits, ladder or delete activity key; no string saying limits, queue / fila, delete activity / limpar / limpeza, remove worktree or a masculine worktree', () => {
  const keys = Object.keys(MESSAGES.en);
  assert.deepEqual(keys.filter((key) => key.startsWith('setup.') || /ladder|cleanup|removeWorktree|settings\.section\.limits/.test(key)), []);
  // clearing, not deleting an activity: a session's limpar (#304), the console's and the terminal's, a stage's filter (#374), a field's value (#686)
  const CLEAR: readonly string[] = ['detail.clearSession', 'console.clear', 'shortcuts.clear', 'stage.clearFilter', 'field.clear'];
  const retired: Record<'en' | 'pt', RegExp[]> = {
    en: [/\blimits\b/, /\bqueue[ds]?\b/i, /\bclean(?:ing)? ?up\b/i, /\bremove (?:the )?worktree\b/i],
    pt: [
      /\blimites\b/i, /\bfila\b/i, /enfileir/i, /\blimpar\b/i, /\blimpeza\b/i, /\blimpo\b/i,
      /\b(?:o|os|um|uns|do|dos|no|nos|num|ao|aos|pelo|esse|este|desse|deste|nesse|neste)\s+worktrees?\b/i, /\bworktrees?\s+(?:novos?|órfãos?|preparados?)\b/i,
    ],
  };
  for (const language of ['en', 'pt'] as const) {
    const found = Object.entries(MESSAGES[language]).filter(([key, text]) => !CLEAR.includes(key) && retired[language].some((word) => word.test(text))).map(([key]) => key);
    assert.deepEqual(found, [], language);
  }
});

test('the restart dialog\'s copy (#580): both languages, the commit count by number, and the Portuguese branch sentence says etapa', (ctx) => {
  ctx.after(() => setLanguage('en'));
  setLanguage('pt');
  assert.deepEqual(
    [t('restart.title', { stage: 'dev' }), t('restart.discards'), t('restart.returnsTo'), t('restart.keeps'), t('restart.confirm'), t('restart.and')],
    ['Reiniciar etapa dev', 'descarta', 'volta para', 'mantém', 'descartar e reiniciar', 'e'],
  );
  assert.equal(t('restart.lead'), 'o trabalho desta etapa é descartado e ela executa de novo com uma sessão nova.');
  assert.deepEqual([tPlural('restart.commits', 1, { n: 1 }), tPlural('restart.commits', 4, { n: 4 }), t('restart.session', { id: 'a42d1861' })], ['1 commit', '4 commits', 'sessão a42d1861']);
  assert.deepEqual(
    [t('restart.stageEnd', { stage: 'plan' }), t('restart.stageStart', { stage: 'dev' }), t('restart.results', { stages: 'backlog e plan' })],
    ['fim da etapa plan', 'início da etapa dev', 'resultados de backlog e plan'],
  );
  assert.doesNotMatch(MESSAGES.pt['restart.branch'], /estágio/);
  setLanguage('en');
  assert.deepEqual(
    [t('restart.title', { stage: 'dev' }), t('restart.lead'), t('restart.confirm'), t('restart.stageEnd', { stage: 'plan' })],
    ['Restart stage dev', 'This stage\'s work is discarded and it runs again in a new session.', 'discard and restart', 'end of stage plan'],
  );
});

test('the shortcut map\'s copy (#639): its title and its link to settings, in both languages, named as the glossary names them', () => {
  assert.deepEqual([MESSAGES.en['shortcutMap.title'], MESSAGES.pt['shortcutMap.title']], ['shortcuts', 'atalhos']);
  assert.deepEqual([MESSAGES.en['shortcutMap.edit'], MESSAGES.pt['shortcutMap.edit']], ['edit in settings › shortcuts', 'editar em configurações › atalhos']);
});

test('the editor pane\'s copy (#717, #818, #850): the IDE\'s keys and the retired abrir no editor are gone, and the pane\'s name is gone with its header', () => {
  for (const key of ['files.openInEditor', 'files.openInIde', 'editor.openInIde', 'editor.noIde', 'settings.ide']) assert.equal(key in MESSAGES.en, false, key);
  assert.equal('editor.title' in MESSAGES.en || 'editor.title' in MESSAGES.pt, false);
  for (const language of ['en', 'pt'] as const) assert.equal(Object.values(MESSAGES[language]).some((text) => /abrir no editor|open in editor|abrir na IDE|open in IDE/.test(text)), false, language);
});

test('the sessions table copy (#778): the rows the handoff got wrong say what the code does, the terminal row has its own options, and the sleep row takes the key as {keys}', () => {
  assert.deepEqual(
    [MESSAGES.pt['settings.sessions.sleepAll.sub'], MESSAGES.pt['settings.sessions.sleepAll.what'], MESSAGES.en['settings.sessions.sleepAll.what']],
    ['as sessões e os terminais de uma atividade', 'pede confirmação com mais de uma execução ou um terminal', 'asks first when there is more than one run or any terminal'],
  );
  assert.deepEqual(
    [MESSAGES.pt['settings.sessions.rateLimit.before'], MESSAGES.pt['settings.sessions.rateLimit.after'], MESSAGES.en['settings.sessions.rateLimit.after']],
    ['se o reset vier em até', 'min, espera; senão, para na hora com o erro', 'min, it waits; otherwise it stops at once with the error'],
  );
  assert.deepEqual(
    [MESSAGES.pt['settings.closeTab.terminal.keep'], MESSAGES.pt['settings.closeTab.terminal.sleep'], MESSAGES.en['settings.closeTab.terminal.keep'], MESSAGES.en['settings.closeTab.terminal.sleep']],
    ['manter executando: o terminal continua ativo', 'dormir: o terminal para e guarda a saída', 'keep running: the terminal stays active', 'sleep: the terminal stops and keeps its output'],
  );
  for (const language of ['pt', 'en'] as const) assert.match(MESSAGES[language]['settings.sessions.sleep.sub'], /\{keys\}$/, language);
  assert.equal('settings.closeTabNotice.hint' in MESSAGES.en || 'settings.closeTabNotice.hint' in MESSAGES.pt, false, 'the avisar column says it now (#778)');
});

test('the activity home\'s copy (#759): its subtitle, its block labels and its new-run label in both languages, aba and never tab in Portuguese', () => {
  const keys = ['center.empty.subtitle', 'center.empty.sessions', 'center.empty.terminals', 'center.empty.new'] as const;
  assert.deepEqual(keys.map((key) => MESSAGES.pt[key]), [
    'fechar uma aba não encerra a sessão. abra uma sessão desta atividade ou comece outra.', 'sessões · {n}', 'terminais · {n}', 'nova sessão em {activity}',
  ]);
  assert.deepEqual(keys.map((key) => MESSAGES.en[key]), [
    'closing a tab doesn\'t end its session. open one of this activity\'s sessions or start another.', 'sessions · {n}', 'terminals · {n}', 'new session in {activity}',
  ]);
});

test('Settings › editor\'s copy (#780): the language names and the new card in both languages; the per-workspace keys of #749 and the bar\'s save are gone', () => {
  for (const key of ['settings.format.supported', 'settings.format.supportedHint', 'settings.format.installed', 'settings.format.notInstalled', 'settings.format.custom', 'settings.format.customHint', 'settings.format.custom.add', 'settings.format.custom.col.name', 'editor.save', 'editor.saveUnformattedHint']) {
    assert.equal(key in MESSAGES.en, false, key);
  }
  assert.deepEqual([MESSAGES.en['editor.language.other'], MESSAGES.pt['editor.language.other']], ['other', 'outras']);
  assert.deepEqual([MESSAGES.en['settings.install.requires'], MESSAGES.pt['settings.install.requires']], ['requires {tool}', 'requer {tool}']);
});

test('a commands stage\'s progress, output link and failure read as the spec writes them, in both languages (#755)', () => {
  const keys = ['stageCommands.running', 'stageCommands.viewOutput', 'stageCommands.failed'] as const;
  assert.deepEqual(keys.map((key) => MESSAGES.pt[key]), ['executando {name} · {n}/{total}', 'ver saída', 'checks falharam: {list}']);
  assert.deepEqual(keys.map((key) => MESSAGES.en[key]), ['running {name} · {n}/{total}', 'view output', 'checks failed: {list}']);
});

test('the commands stage\'s Settings copy reads as the spec and the per-workspace handoff write it, in both languages (#755)', () => {
  const keys = [
    'settings.stages.action.commands', 'settings.stages.commands', 'settings.stages.commands.add', 'settings.stages.commands.remove',
    'settings.stages.commands.hint', 'settings.stages.commands.stopOnFailure', 'settings.stages.commands.stopOnFailure.hint', 'settings.stages.commands.note',
    'settings.stages.commands.missingFails', 'settings.stages.commands.missingSkips', 'settings.stages.commands.onMissing', 'settings.stages.commands.onMissing.fail',
    'settings.stages.commands.onMissing.skip', 'settings.stages.commands.onMissing.fail.hint', 'settings.stages.commands.onMissing.skip.hint',
  ] as const;
  assert.deepEqual(keys.map((key) => MESSAGES.pt[key]), [
    'executar comandos', 'comandos', '+ comando', 'remover comando {name}',
    'os comandos de workspaces › comandos, na ordem, na worktree · cada workspace executa o seu', 'parar no primeiro que falhar', 'senão executa todos e junta as saídas',
    'veredito pelo código de saída: todos 0 = "passou" · a saída de quem falhou entra em {result.commands.output}',
    'não existe em {workspace} · falha', 'não existe em {workspace} · pula', 'se o workspace não tiver um comando', 'falhar a etapa', 'pular o comando',
    'falha antes de executar qualquer comando, com "{comando} não existe em {workspace}" · a outra opção é pular o comando',
    'executa os que existem e registra "pulado · não existe em {workspace}" na tarefa · se nenhum existir, a etapa passa',
  ]);
  assert.deepEqual(keys.map((key) => MESSAGES.en[key]), [
    'run commands', 'commands', '+ command', 'remove command {name}',
    'the commands from workspaces › commands, in order, in the worktree · each workspace runs its own', 'stop at the first failure', 'otherwise runs all and joins the outputs',
    'verdict by exit code: all 0 = "passed" · the failing output goes into {result.commands.output}',
    'missing in {workspace} · fails', 'missing in {workspace} · skips', 'if the workspace lacks a command', 'fail the stage', 'skip the command',
    'fails before running any command, with "{command} missing in {workspace}" · the other option is to skip the command',
    'runs the ones that exist and logs "skipped · missing in {workspace}" on the task · if none exist, the stage passes',
  ]);
  assert.equal('settings.stages.commands.missing' in MESSAGES.en, false);
});

test('the per-workspace commands editor reads as the handoff writes it, in both languages; the enabled-in keys are gone (#755)', () => {
  const keys = [
    'settings.commands.col.impls', 'settings.commands.all', 'settings.commands.others', 'settings.commands.addImpl', 'settings.commands.addImplFor', 'settings.commands.missing',
    'settings.commands.col.menu', 'settings.commands.stagesOnly', 'settings.commands.menu', 'settings.commands.removeImpl', 'settings.error.commandImpls',
  ] as const;
  assert.deepEqual(keys.map((key) => MESSAGES.pt[key]), [
    'comando em cada workspace', 'todos os workspaces', 'os demais workspaces', '+ workspace', 'adicionar workspace a {name}', 'não existe em {list}',
    'no menu', 'só etapas', '{name} no menu da tarefa', 'remover {name} de {workspace}', '{name} precisa de um comando em pelo menos um workspace',
  ]);
  assert.deepEqual(keys.map((key) => MESSAGES.en[key]), [
    'command in each workspace', 'all workspaces', 'the other workspaces', '+ workspace', 'add a workspace to {name}', 'missing in {list}',
    'in menu', 'stages only', '{name} in the task menu', 'remove {name} from {workspace}', '{name} needs a command in at least one workspace',
  ]);
  for (const key of ['settings.commands.col.workspaces', 'settings.commands.col.command', 'settings.commands.workspaces', 'settings.commands.nowhere']) {
    assert.equal(key in MESSAGES.en || key in MESSAGES.pt, false, key);
  }
});

test('a wait for CI\'s card copy reads as the spec writes it, in both languages (#834)', () => {
  const keys = ['stageCi.waiting', 'stageCi.waitingPr', 'stageCi.failed'] as const;
  assert.deepEqual(keys.map((key) => MESSAGES.pt[key]), ['aguardando CI · {n}/{total}', 'aguardando PR', 'CI falhou: {list}']);
  assert.deepEqual(keys.map((key) => MESSAGES.en[key]), ['waiting for CI · {n}/{total}', 'waiting for PR', 'CI failed: {list}']);
});

test('the wait for CI\'s Settings copy reads as the spec writes it, in both languages, and never says rodar (#834)', () => {
  const keys = [
    'settings.stages.action.waitForCi', 'settings.stages.ci.from', 'settings.stages.ci.from.prChecks', 'settings.stages.ci.which', 'settings.stages.ci.which.required',
    'settings.stages.ci.which.all', 'settings.stages.ci.which.list', 'settings.stages.ci.checks.placeholder', 'settings.stages.ci.timeout', 'settings.stages.ci.timeout.placeholder',
    'settings.stages.ci.rerunOnce',
  ] as const;
  assert.deepEqual(keys.map((key) => MESSAGES.pt[key]), ['aguardar CI', 'de onde', 'checks do PR da tarefa', 'quais checks', 'os obrigatórios da branch', 'todos', 'só estes', 'nome ou padrão', 'espera até', 'sem limite', 'executar de novo uma vez']);
  assert.deepEqual(keys.map((key) => MESSAGES.en[key]), ['wait for CI', 'from', 'checks of the task\'s PR', 'which checks', 'the branch\'s required ones', 'all', 'only these', 'name or pattern', 'waits up to', 'no limit', 're-run once']);
  const ours = Object.entries(MESSAGES.pt).filter(([key]) => key.startsWith('settings.stages.ci.') || key.startsWith('stageCi.'));
  assert.equal(ours.some(([, text]) => /\brod(ar|ando)\b/.test(text)), false);
});

test('the decomposition\'s confirm reads in both languages: criar issues, the counts with their plurals, the problems with their line (#865)', () => {
  setLanguage('pt');
  assert.equal(t('decomposition.create'), 'criar issues');
  assert.equal(`${tPlural('decomposition.issues', 5, { n: 5 })}, ${tPlural('decomposition.blockers', 3, { n: 3 })}`, '5 issues, 3 bloqueios');
  assert.equal(tPlural('decomposition.suggestions', 1, { n: 1 }), '1 sugestão fica de fora');
  assert.equal(t('decomposition.problem', { line: 12, message: 'x' }), 'linha 12: x');
  setLanguage('en');
  assert.equal(t('decomposition.create'), 'create issues');
  assert.equal(`${tPlural('decomposition.issues', 1, { n: 1 })}, ${tPlural('decomposition.blockers', 1, { n: 1 })}`, '1 issue, 1 blocker');
  assert.equal(t('decomposition.title'), 'Create issues');
});

test('the running block\'s copy reads as the spec writes it, in both languages (#914)', () => {
  const keys = ['running.ci', 'running.commands', 'running.stage', 'running.loop', 'running.silent', 'running.skipped', 'running.output', 'running.stop'] as const;
  assert.deepEqual(keys.map((key) => MESSAGES.pt[key]), ['aguardando CI', 'executando checks', 'etapa {name}', 'volta {n}/{max}', 'sem saída há {n} min · {name}', 'pulado', 'ver saída', 'parar']);
  assert.deepEqual(keys.map((key) => MESSAGES.en[key]), ['waiting for CI', 'running checks', 'stage {name}', 'loop {n}/{max}', 'no output for {n} min · {name}', 'skipped', 'see output', 'stop']);
});

test('the tries and exhausted blocks\' copy reads as the spec writes it, in both languages (#916)', () => {
  const keys = [
    'tries.exhausted.title', 'tries.exhausted.text', 'tries.exhausted.gone', 'tries.exhausted.retry', 'tries.exhausted.move',
    'tries.exhausted.openSession', 'tries.exhausted.note', 'tries.section', 'tries.sectionOf', 'tries.line',
  ] as const;
  assert.deepEqual(keys.map((key) => MESSAGES.pt[key]), [
    'tentativas esgotadas', '{stage} {trigger} {max} de {max} vezes e voltou para {destination} a cada vez. a tarefa parou aqui e espera você.',
    '{stage} esgotou as tentativas.', 'tentar de novo', 'mover para…', 'abrir sessão', 'tentar de novo zera o contador e executa {destination}.',
    'tentativas', 'tentativas · {trigger} {n}/{max}', '{n}/{max} ✕ {cause}',
  ]);
  assert.deepEqual(keys.map((key) => MESSAGES.en[key]), [
    'out of tries', '{stage} {trigger} {max} of {max} times and went back to {destination} each time. the task stopped here and waits for you.',
    '{stage} ran out of tries.', 'try again', 'move to…', 'open session', 'try again resets the counter and runs {destination}.',
    'tries', 'tries · {trigger} {n}/{max}', '{n}/{max} ✕ {cause}',
  ]);
});

test('a failed start\'s short messages, in both languages; the toggle says details (#945)', () => {
  assert.deepEqual([MESSAGES.en['start.failed.checkout_dirty'], MESSAGES.pt['start.failed.checkout_dirty']], [
    'the workspace has uncommitted changes: commit or stash them, then start again',
    'o workspace tem mudanças não commitadas: faça commit ou stash e inicie de novo',
  ]);
  assert.deepEqual([MESSAGES.en['start.failed.error'], MESSAGES.pt['start.failed.error']], ['the task could not start', 'a tarefa não pôde iniciar']);
  assert.deepEqual([MESSAGES.en['start.failed.details'], MESSAGES.pt['start.failed.details']], ['details', 'detalhes']);
});

test('the blockers add row\'s copy (#57): both languages, the handoff\'s Portuguese', () => {
  const keys = ['blockers.kind', 'blockers.blockedBy', 'blockers.blocking', 'blockers.search', 'blockers.addRef', 'blockers.suggestions'] as const;
  assert.deepEqual(keys.map((key) => MESSAGES.pt[key]), ['tipo', 'bloqueada por', 'bloqueia', '#número ou título…', 'adicionar {id}', 'sugestões']);
  assert.deepEqual(keys.map((key) => MESSAGES.en[key]), ['type', 'blocked by', 'blocks', '#number or title…', 'add {id}', 'suggestions']);
});

test('the blockers section\'s copy (#57): both languages, the handoff\'s Portuguese, one line per route code', () => {
  const keys = ['blockers.title', 'blockers.add', 'blockers.closed', 'blockers.open', 'blockers.remove', 'blockers.note'] as const;
  assert.deepEqual(keys.map((key) => MESSAGES.pt[key]), [
    'bloqueios', '+ adicionar', 'fechada', 'aberta', 'remover {id}', 'são as dependências da issue no GitHub. a tarefa bloqueada não inicia até o bloqueio fechar.',
  ]);
  assert.deepEqual(keys.map((key) => MESSAGES.en[key]), [
    'blockers', '+ add', 'closed', 'open', 'remove {id}', 'these are the issue\'s dependencies on GitHub. a blocked task does not start until the blocker closes.',
  ]);
  const codes = ['unknownItem', 'unknownRef', 'crossSource', 'self', 'cycle', 'refused', 'badRequest', 'unexpected'] as const;
  for (const code of codes) assert.ok(MESSAGES.en[`blockers.${code}`].length > 0 && MESSAGES.pt[`blockers.${code}`].length > 0, code);
  assert.deepEqual([MESSAGES.en['blockers.unexpected'], MESSAGES.pt['blockers.unexpected']], ['Unexpected error', 'Erro inesperado']);
});

test('issue › on the details panel\'s title row reads the same in both languages (#64)', () => {
  assert.equal(MESSAGES.en['detail.issueLink'], 'issue ›');
  assert.equal(MESSAGES.pt['detail.issueLink'], 'issue ›');
});

test('the pages\' properties column and its activity block are gone: the details panel draws them (#64)', () => {
  for (const key of ['issue.props', 'issue.activity', 'issue.openActivity']) assert.equal(key in MESSAGES.en || key in MESSAGES.pt, false, `${key} is gone (#64)`);
});
