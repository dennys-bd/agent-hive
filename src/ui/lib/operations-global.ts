// The global group (#584): always listed, in the spec's order. The ones that are a shortcut run through the key's own listener (runShortcut),
// so the search does exactly what the key does.
import { liveDefaultAgent } from '../../agents';
import type { AgentId, OperationId, UsageRule } from '../../types';
import { act } from '@/components/actions';
import { firedRules, ruleKey, ruleLabel } from '@/lib/rule-effects';
import { SIGNALS } from '@/components/SignalToggle';
import { type MessageKey, t } from '@/i18n';
import { runShortcut } from '@/lib/dock-layout';
import type { Operation } from '@/lib/operations';
import { type PauseChoice, pauseUntil, ruleTarget } from '@/lib/usage';

const keyed = (id: OperationId, label: MessageKey): Operation => ({
  id, group: 'global', shortcut: id, label: () => t(label), available: () => true, run: () => runShortcut(id),
});

// One pick of a › page: always there, run at once
const leaf = (id: string, label: string, run: () => void): Operation => ({ id, group: 'global', label: () => label, available: () => true, run });

// sinal › (the flow sidebar's toggle, redesign 09): the signals the fired rules' floor leaves, the stored one checked; the same POST
const signal: Operation = {
  id: 'signal', group: 'global', label: () => t('flow.signal'), available: () => true,
  children: (ctx) => {
    const floor = SIGNALS.indexOf(ctx.effective?.floor.signal ?? 'green');
    return SIGNALS.filter((_, rank) => rank >= floor).map((value): Operation => ({
      ...leaf(`signal.${value}`, value, () => void act('/signal', { signal: value })), checked: (c) => c.state.signal === value,
    }));
  },
};

// The footer's horizons (redesign 02); personalizado… needs its date field and stays in the rules panel
const HORIZONS: ReadonlyArray<[PauseChoice, MessageKey]> = [
  ['reset', 'pause.reset'], ['quarter', 'pause.quarter'], ['hour', 'pause.hour'], ['fourHours', 'pause.fourHours'], ['tomorrow', 'pause.tomorrow'],
];

// A rule's page: retomar agora while paused, then the horizons, posting what the rules panel's popover posts
function ruleOperation(rule: UsageRule, isPaused: boolean, defaultAgent: AgentId): Operation {
  const body = ruleTarget(rule);
  const horizons = HORIZONS.map(([choice, key]) => leaf(`pause.${choice}`, t(key), () => void act('/rules/disable', { ...body, until: pauseUntil(choice, Date.now()) })));
  const resume = isPaused ? [leaf('pause.resume', t('pause.resume'), () => void act('/rules/enable', body))] : [];
  return { id: `pause.${ruleKey(rule)}`, group: 'global', label: () => ruleLabel(rule, defaultAgent), available: () => true, children: () => [...resume, ...horizons] };
}

// pausar regra › (the rules panel's rows, #224): each fired rule, then each paused one; listed only while there is one
const pause: Operation = {
  id: 'pauseRule', group: 'global', label: () => t('pause.title'),
  available: (ctx) => ctx.effective !== undefined && firedRules(ctx.effective).length + ctx.effective.disabledRules.length > 0,
  children: (ctx) => (ctx.effective === undefined ? [] : [
    ...firedRules(ctx.effective).map((rule) => ruleOperation(rule, false, liveDefaultAgent(ctx.state))),
    ...ctx.effective.disabledRules.map((status) => ruleOperation(status.rule, true, liveDefaultAgent(ctx.state))),
  ]),
};

const settings: Operation = {
  id: 'settings', group: 'global', label: () => t('search.op.settings'), available: (ctx) => ctx.nav.openSettings !== undefined, run: (ctx) => ctx.nav.openSettings?.(),
};

/** atividades, fluxo, plugins (#746, #313); the two sides, the console; nova atividade, novo terminal (the workspace picker with no activity open, as ⌘T),
 * the shortcut map (#639); then sinal ›, pausar regra › and configurações. */
export const GLOBAL_OPERATIONS: readonly Operation[] = [
  keyed('viewActivities', 'shortcuts.viewActivities'), keyed('viewFlow', 'shortcuts.viewFlow'), keyed('viewPlugins', 'shortcuts.viewPlugins'),
  keyed('toggleLeft', 'shortcuts.toggleLeft'), keyed('toggleRight', 'shortcuts.toggleRight'), keyed('toggleConsole', 'shortcuts.toggleConsole'),
  keyed('newActivity', 'shortcuts.newActivity'), keyed('newTerminal', 'shortcuts.newTerminal'), keyed('shortcutMap', 'shortcuts.shortcutMap'),
  signal, pause, settings,
];
