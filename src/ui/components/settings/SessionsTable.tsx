import { CircleHelp } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { type MessageKey, t } from '@/i18n';
import { isMinutes, type SettingsDraft } from '@/lib/settings-form';
import { settingAnchor } from '@/lib/settings-search';
import { binding, isMac } from '@/lib/shortcut-bindings';
import { displayBinding } from '../../../shortcuts';
import { APPROVAL_HOLD_MAX_MIN, CLOSE_TAB_ACTIONS, type CloseTabAction, RATE_LIMIT_WAIT_MAX, SHUTDOWN_IDLE_MAX } from '../../../types';

// Every row, the header's included, is the same three-column grid, at least 52px tall (#778): quando, o que acontece, avisar.
const ROW = 'grid min-h-13 grid-cols-[minmax(0,1fr)_24rem_4rem] items-center gap-4 px-3 py-2';
const MUTED = 'text-muted-foreground text-xs';

export type SessionRowName = 'closeSession' | 'closeStage' | 'closeTerminal' | 'sleep' | 'sleepAll' | 'auto' | 'idle' | 'approval' | 'rateLimit';
type CloseTabOptions = Record<CloseTabAction, MessageKey>;

// The session rows keep #614's words; a terminal's tab gets its own, since those talk about a session (#778).
const SESSION_OPTIONS: CloseTabOptions = { keep: 'settings.closeTab.keep', sleep: 'settings.closeTab.sleep' };
const TERMINAL_OPTIONS: CloseTabOptions = { keep: 'settings.closeTab.terminal.keep', sleep: 'settings.closeTab.terminal.sleep' };

// The row's situation labels every control on it: the sentence replaces the old visible labels (#778). Ids from useId, never settings-*,
// so the card's settings-* ids stay the controls' own (#689 targets them).
const labelOf = (base: string, row: SessionRowName): string => `${base}-${row}`;
const warnHeaderOf = (base: string): string => `${base}-warn`;

/** Each row's old field label (#689): the Settings search still finds a row by it. */
export const SESSION_SYNONYMS: ReadonlyArray<[SessionRowName, MessageKey]> = [
  ['closeSession', 'settings.closeSessionTab'], ['closeStage', 'settings.closeStageTab'], ['closeTerminal', 'settings.closeTerminalTab'],
  ['sleep', 'settings.sleepNotice'], ['sleepAll', 'settings.sleepAllNotice'], ['auto', 'settings.sleepAutoNotice'],
  ['idle', 'settings.shutdownIdle'], ['approval', 'settings.approvalMinutes'], ['rateLimit', 'settings.rateLimitWait'],
];

interface SessionsTableProps { draft: SettingsDraft; onChange(patch: Partial<SettingsDraft>): void }
interface RowsProps extends SessionsTableProps { base: string }

function Row({ id, className, children }: { id?: string; className: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a <tr> cannot be its own grid, which every row needs; the role keeps the table for a screen reader (#778)
    // biome-ignore lint/a11y/useFocusableInteractive: a row is not a widget; nothing on it takes the focus but its own controls (#778)
    <div role="row" id={id} className={className}>{children}</div>
  );
}

function Cell({ header, id, className, children }: { header?: boolean; id?: string; className?: string; children: ReactNode }) {
  return <div role={header ? 'columnheader' : 'cell'} id={id} className={className}>{children}</div>;
}

// Rows 7–9's long hints (#233, #268, #805) sit one hover or one Tab away instead of on the page (#778).
function HelpTip({ label, hint }: { label: string; hint: MessageKey }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label={label} className="rounded-sm text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
          <CircleHelp aria-hidden="true" className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent>{t(hint)}</TooltipContent>
    </Tooltip>
  );
}

interface SessionRowProps { base: string; row: SessionRowName; sub?: string; help?: MessageKey; what: ReactNode; warn?: ReactNode }

// One situation: when it happens (and a second line), what the Hive does, and its notice switch, or a dash when it has none.
function SessionRow({ base, row, sub, help, what, warn }: SessionRowProps) {
  const situation = t(`settings.sessions.${row}`);
  return (
    <Row id={settingAnchor(`settings.sessions.${row}`)} className={`${ROW} border-t`}>
      <Cell className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-1.5">
          <span id={labelOf(base, row)} className="text-sm">{situation}</span>
          {help && <HelpTip label={situation} hint={help} />}
        </span>
        {sub && <span className={MUTED}>{sub}</span>}
      </Cell>
      <Cell className="min-w-0">{what}</Cell>
      <Cell className="flex justify-center">{warn ?? <span className={MUTED}>—</span>}</Cell>
    </Row>
  );
}

interface CloseTabSelectProps { id: string; base: string; row: SessionRowName; options: CloseTabOptions; value: CloseTabAction; onChange(action: CloseTabAction): void }

// What closing a tab does to its run (#614, #696): one choice, as OnCloseSelect's (#513).
function CloseTabSelect({ id, base, row, options, value, onChange }: CloseTabSelectProps) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as CloseTabAction)}>
      <SelectTrigger id={id} aria-labelledby={labelOf(base, row)} className="w-full"><SelectValue /></SelectTrigger>
      <SelectContent>{CLOSE_TAB_ACTIONS.map((a) => <SelectItem key={a} value={a}>{t(options[a])}</SelectItem>)}</SelectContent>
    </Select>
  );
}

interface WarnSwitchProps { id: string; base: string; row: SessionRowName; checked: boolean; onCheckedChange(checked: boolean): void }

// Named by its row and the avisar header, so the three close-tab switches no longer read as one setting repeated (#778).
function WarnSwitch({ id, base, row, checked, onCheckedChange }: WarnSwitchProps) {
  return <Switch id={id} aria-labelledby={`${labelOf(base, row)} ${warnHeaderOf(base)}`} checked={checked} onCheckedChange={onCheckedChange} />;
}

function WhatText({ text }: { text: MessageKey }) {
  return <p className={MUTED}>{t(text)}</p>;
}

interface MinutesFieldProps { id: string; row: 'idle' | 'approval' | 'rateLimit'; label: MessageKey; max: number; value: string; onChange(value: string): void }

// A whole-minutes field inside its row's sentence (#233, #268, #805). Its old label stays its accessible name, and aria-invalid uses the
// predicate validateSettings uses, so the field and the footer's message never disagree (#778).
function MinutesField({ id, row, label, max, value, onChange }: MinutesFieldProps) {
  return (
    <div className={`flex items-center gap-2 ${MUTED}`}>
      <span>{t(`settings.sessions.${row}.before`)}</span>
      <Input
        id={id} type="number" min={1} max={max} aria-label={t(label)} aria-invalid={isMinutes(value, max) ? undefined : true}
        className="w-20 shrink-0" defaultValue={value} onChange={(e) => onChange(e.target.value)}
      />
      <span>{t(`settings.sessions.${row}.after`)}</span>
    </div>
  );
}

// Rows 1–3: you close a tab (#614, #696).
function CloseTabRows({ base, draft, onChange }: RowsProps) {
  return (
    <>
      <SessionRow
        base={base} row="closeSession"
        what={<CloseTabSelect id="settings-close-session-tab" base={base} row="closeSession" options={SESSION_OPTIONS} value={draft.closeSessionTab} onChange={(closeSessionTab) => onChange({ closeSessionTab })} />}
        warn={<WarnSwitch id="settings-close-session-tab-notice" base={base} row="closeSession" checked={draft.closeSessionTabNotice} onCheckedChange={(closeSessionTabNotice) => onChange({ closeSessionTabNotice })} />}
      />
      <SessionRow
        base={base} row="closeStage" sub={t('settings.sessions.closeStage.sub')}
        what={<CloseTabSelect id="settings-close-stage-tab" base={base} row="closeStage" options={SESSION_OPTIONS} value={draft.closeStageTab} onChange={(closeStageTab) => onChange({ closeStageTab })} />}
        warn={<WarnSwitch id="settings-close-stage-tab-notice" base={base} row="closeStage" checked={draft.closeStageTabNotice} onCheckedChange={(closeStageTabNotice) => onChange({ closeStageTabNotice })} />}
      />
      <SessionRow
        base={base} row="closeTerminal"
        what={<CloseTabSelect id="settings-close-terminal-tab" base={base} row="closeTerminal" options={TERMINAL_OPTIONS} value={draft.closeTerminalTab} onChange={(closeTerminalTab) => onChange({ closeTerminalTab })} />}
        warn={<WarnSwitch id="settings-close-terminal-tab-notice" base={base} row="closeTerminal" checked={draft.closeTerminalTabNotice} onCheckedChange={(closeTerminalTabNotice) => onChange({ closeTerminalTabNotice })} />}
      />
    </>
  );
}

// Row 4's second line names the sleepSession key as bound on this platform, read at render as KeyHint does; while it is off, the key drops (#778).
function sleepSub(): string {
  const keys = binding('sleepSession');
  return keys === null ? t('settings.sessions.sleep.subNoKey') : t('settings.sessions.sleep.sub', { keys: displayBinding(keys, isMac()) });
}

// Rows 4–6: you sleep one session or all of an activity's, and the auto flow sleeps a stage's session (#672, #696).
function SleepRows({ base, draft, onChange }: RowsProps) {
  return (
    <>
      <SessionRow
        base={base} row="sleep" sub={sleepSub()} what={<WhatText text="settings.sessions.sleep.what" />}
        warn={<WarnSwitch id="settings-sleep-notice" base={base} row="sleep" checked={draft.sleepNotice} onCheckedChange={(sleepNotice) => onChange({ sleepNotice })} />}
      />
      <SessionRow
        base={base} row="sleepAll" sub={t('settings.sessions.sleepAll.sub')} what={<WhatText text="settings.sessions.sleepAll.what" />}
        warn={<WarnSwitch id="settings-sleep-all-notice" base={base} row="sleepAll" checked={draft.sleepAllNotice} onCheckedChange={(sleepAllNotice) => onChange({ sleepAllNotice })} />}
      />
      <SessionRow
        base={base} row="auto" what={<WhatText text="settings.sessions.auto.what" />}
        warn={<WarnSwitch id="settings-sleep-auto-notice" base={base} row="auto" checked={draft.sleepAutoNotice} onCheckedChange={(sleepAutoNotice) => onChange({ sleepAutoNotice })} />}
      />
    </>
  );
}

// Rows 7–9: what the Hive does on its own after a wait (#233, #268, #805). The approval window and the plan-limit wait have no notice.
function WindowRows({ base, draft, onChange }: RowsProps) {
  return (
    <>
      <SessionRow
        base={base} row="idle" sub={t('settings.sessions.idle.sub')} help="settings.shutdownIdle.hint"
        what={<MinutesField id="settings-shutdown-idle" row="idle" label="settings.shutdownIdle" max={SHUTDOWN_IDLE_MAX} value={draft.shutdownIdleMinutes} onChange={(shutdownIdleMinutes) => onChange({ shutdownIdleMinutes })} />}
        warn={<WarnSwitch id="settings-sleep-idle-notice" base={base} row="idle" checked={draft.sleepIdleNotice} onCheckedChange={(sleepIdleNotice) => onChange({ sleepIdleNotice })} />}
      />
      <SessionRow
        base={base} row="approval" sub={t('settings.sessions.approval.sub')} help="settings.approvalMinutes.hint"
        what={<MinutesField id="settings-approval-minutes" row="approval" label="settings.approvalMinutes" max={APPROVAL_HOLD_MAX_MIN} value={draft.approvalMinutes} onChange={(approvalMinutes) => onChange({ approvalMinutes })} />}
      />
      <SessionRow
        base={base} row="rateLimit" sub={t('settings.sessions.rateLimit.sub')} help="settings.rateLimitWait.hint"
        what={<MinutesField id="settings-rate-limit-wait" row="rateLimit" label="settings.rateLimitWait" max={RATE_LIMIT_WAIT_MAX} value={draft.rateLimitWaitMinutes} onChange={(rateLimitWaitMinutes) => onChange({ rateLimitWaitMinutes })} />}
      />
    </>
  );
}

function HeaderRow({ base }: { base: string }) {
  return (
    <Row className={`${ROW} ${MUTED}`}>
      <Cell header>{t('settings.sessions.col.when')}</Cell>
      <Cell header>{t('settings.sessions.col.what')}</Cell>
      <Cell header id={warnHeaderOf(base)} className="text-center">{t('settings.sessions.col.warn')}</Cell>
    </Row>
  );
}

/** Settings › execution's sessions and waiting (#778): one row per situation, saying when it happens, what the Hive does and whether it
 * warns, with a note under the box. Plain divs with table roles, since a <table> row cannot be its own grid. */
export function SessionsTable({ draft, onChange }: SessionsTableProps) {
  const base = useId();
  return (
    <TooltipProvider>
      <div className="flex flex-col gap-3">
        {/* biome-ignore lint/a11y/useSemanticElements: the rows are grids, which a <table> cannot hold; the role keeps the table for a screen reader (#778) */}
        <div role="table" className="rounded-md border">
          <HeaderRow base={base} />
          <CloseTabRows base={base} draft={draft} onChange={onChange} />
          <SleepRows base={base} draft={draft} onChange={onChange} />
          <WindowRows base={base} draft={draft} onChange={onChange} />
        </div>
        <p className={MUTED}>{t('settings.sessions.note')}</p>
      </div>
    </TooltipProvider>
  );
}
