import { type ReactNode, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { type MessageKey, t } from '@/i18n';
import { isUpdate } from '@/lib/settings-languages';
import type { InstallAction, InstallState } from '../../../types';

interface InstallRowProps {
  name: string; via: string; state?: InstallState;
  requiresHint?: string; // requer's second line: what installs it and with which tool
  isOff?: boolean; // a server in no workspace: installed, never starts
  scope?: ReactNode; // the server's chips, beside its state
  onAct(action: InstallAction): void;
}
export type Tone = 'working' | 'review' | 'waiting' | 'destructive';
export interface Described { text: string; tone?: Tone; second?: string }
const TEXT: Record<Tone, string> = { working: 'text-working', review: 'text-review', waiting: 'text-waiting', destructive: 'text-destructive' };
const DOT: Record<Tone, string> = { working: 'bg-working', review: 'bg-review', waiting: 'bg-waiting', destructive: 'bg-destructive' };
type Act = { action: InstallAction; label: MessageKey; variant: 'outline' | 'ghost' };
const UPDATE: Act = { action: 'update', label: 'settings.install.do.update', variant: 'outline' };
const ACTIONS: Record<InstallState['state'], Act[]> = {
  absent: [{ action: 'install', label: 'settings.install.do.install', variant: 'outline' }],
  installing: [{ action: 'cancel', label: 'settings.install.do.cancel', variant: 'ghost' }],
  installed: [{ action: 'remove', label: 'settings.install.do.remove', variant: 'ghost' }],
  requires: [{ action: 'recheck', label: 'settings.install.do.recheck', variant: 'outline' }],
  failed: [{ action: 'install', label: 'settings.install.do.retry', variant: 'outline' }],
  builtin: [],
};

// The state's words (#780), coloured only for a status, with its second line when the handoff gives one
export function describeInstall(state: InstallState | undefined, isOff: boolean, requiresHint: string): Described {
  if (state === undefined) return { text: '—' };
  switch (state.state) {
    case 'absent': return { text: t('settings.install.absent') };
    case 'installing': return { text: state.percent === undefined ? t('settings.install.installingNoPct') : t('settings.install.installing', { pct: state.percent }), tone: 'working' };
    case 'requires': return { text: t('settings.install.requires', { tool: state.tool }), tone: 'waiting', second: requiresHint };
    case 'failed': return { text: t('settings.install.failed'), tone: 'destructive', second: t('settings.install.failedAt', { version: state.version, step: state.step }) };
    case 'builtin': return { text: t('settings.install.builtin') };
    case 'installed':
      if (isUpdate(state)) return { text: t('settings.install.update', { version: state.latest }), tone: 'review', second: t('settings.install.installed', { version: state.version }) };
      return { text: isOff ? t('settings.install.off') : t('settings.install.installed', { version: state.version }) };
  }
}

export function StateLine({ described, isPlain }: { described: Described; isPlain: boolean }) {
  const { text, tone, second } = described;
  return (
    <div className="flex min-w-0 flex-col gap-0.5 text-xs">
      <span className={`flex items-center gap-1.5 ${tone ? TEXT[tone] : isPlain ? 'text-foreground' : 'text-muted-foreground'}`}>
        {tone && <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${DOT[tone]}`} />}{text}
      </span>
      {second && <span className="text-muted-foreground">{second}</span>}
    </div>
  );
}

/** The install actions of a state (#780, #782): atualizar first when an update is available. */
export const installActions = (state: InstallState | undefined): Act[] => (state === undefined ? [] : [...(isUpdate(state) ? [UPDATE] : []), ...ACTIONS[state.state]]);

/** One installable item of Settings › editor (#780): its name and how it installs, its state, its actions (they act at once, outside the
 * Settings footer), its progress while installing and its log once failed. */
export function InstallRow({ name, via, state, requiresHint = '', isOff = false, scope, onAct }: InstallRowProps) {
  const [isLogShown, setLogShown] = useState(false);
  const actions = installActions(state);
  const isPlain = state?.state === 'installed' && !isOff;
  return (
    <div className="flex flex-col gap-2 rounded-md border px-3 py-2.5">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
        <div className="flex min-w-0 flex-col">
          <span title={name} className="truncate font-mono text-sm">{name}</span>
          <span className="text-muted-foreground text-xs">{via}</span>
        </div>
        <div className="flex items-center gap-2">
          {state?.state === 'failed' && (
            <Button type="button" variant="link" size="xs" className="h-auto p-0 text-review" onClick={() => setLogShown(!isLogShown)}>{t(isLogShown ? 'settings.install.hideLog' : 'settings.install.showLog')}</Button>
          )}
          {actions.map(({ action, label, variant }) => <Button key={action} type="button" size="sm" variant={variant} onClick={() => onAct(action)}>{t(label)}</Button>)}
        </div>
      </div>
      <div className={scope ? 'grid grid-cols-[minmax(0,1fr)_minmax(0,13rem)] items-center gap-3' : ''}>
        <StateLine described={describeInstall(state, isOff, requiresHint)} isPlain={isPlain} />
        {scope}
      </div>
      {state?.state === 'installing' && <Progress value={state.percent} aria-label={t('settings.install.progress', { name })} className="h-1.5 bg-accent" indicatorClassName="bg-foreground" />}
      {state?.state === 'failed' && isLogShown && <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border bg-background p-2 font-mono text-muted-foreground text-xs">{state.log}</pre>}
    </div>
  );
}
