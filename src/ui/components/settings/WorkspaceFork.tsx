import { GitForkIcon, type LucideIcon } from 'lucide-react';
import { useId } from 'react';
import { FORK_SYNCS, type ForkSync, type GitRemote, PR_TARGETS, type State, type WorkspaceFork as Fork } from '../../../types';
import { LastSync, ManualSync } from '@/components/settings/ForkSyncStatus';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useRemotes } from '@/hooks/use-remotes';
import { t } from '@/i18n';
import type { WorkspaceDraft } from '@/lib/settings-form';
import { settingAnchor } from '@/lib/settings-search';
import { isForkSync, isPrTarget, repositoryOf, SUGGESTED_FORK, SUGGESTED_REMOTE, suggestsFork, withPrTarget } from '@/lib/settings-fork';

const HINT = 'text-muted-foreground text-xs';
type Synced = Extract<Fork, { sync: ForkSync }>;
type Change = (fork: Fork | false | null) => void;

// The suggestion's first line with a name in mono: the sentence is translated whole and the name found in it
function MonoIn({ text, mono }: { text: string; mono: string }) {
  const at = text.lastIndexOf(mono);
  if (at === -1) return <span className="text-sm">{text}</span>;
  return <span className="text-sm">{text.slice(0, at)}<span className="font-mono">{mono}</span>{text.slice(at + mono.length)}</span>;
}

export interface SuggestionProps { icon: LucideIcon; line: string; mono: string; hint: string; dismiss: string; accept: string; onDismiss(): void; onAccept(): void }

/** What the Hive found and suggests (#854's fork, #653's nested repo): the dismissal is config, never shown again; accept applies it. */
export function Suggestion({ icon: Icon, line, mono, hint, dismiss, accept, onDismiss, onAccept }: SuggestionProps) {
  return (
    <div role="status" className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 rounded-lg border bg-background p-3">
      <Icon aria-hidden="true" className="size-4 text-muted-foreground" />
      <div className="flex flex-col"><MonoIn text={line} mono={mono} /><span className={HINT}>{hint}</span></div>
      <div className="flex gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>{dismiss}</Button>
        <Button type="button" size="sm" onClick={onAccept}>{accept}</Button>
      </div>
    </div>
  );
}

// Item 4: an undecided workspace with an upstream remote; não é fork saves false, aceitar the suggested fork
const ForkSuggestion = ({ original, onChange }: { original: string; onChange: Change }) => (
  <Suggestion
    icon={GitForkIcon} line={t('settings.fork.found', { original })} mono={original} hint={t('settings.fork.suggestion')}
    dismiss={t('settings.fork.dismiss')} accept={t('settings.fork.accept')} onDismiss={() => onChange(false)} onAccept={() => onChange(SUGGESTED_FORK)}
  />
);

// Item 1: é uma fork. On, the first remote that is not origin is the original's, PRs to it
function ForkSwitch({ fork, remotes, context, onChange }: { fork: Fork | false | null; remotes: GitRemote[]; context: string; onChange: Change }) {
  const id = useId();
  const hasUpstream = remotes.some((r) => r.name === SUGGESTED_REMOTE);
  const hint = fork ? 'settings.fork.on' : hasUpstream ? 'settings.fork.offUpstream' : 'settings.fork.off';
  const turnOn = (): Fork => ({ remote: remotes.find((r) => r.name !== 'origin')?.name ?? SUGGESTED_REMOTE, pr: 'original' });
  return (
    <div id={settingAnchor('settings.fork.isFork', context)} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
      <Switch id={id} className="row-span-2 self-center" aria-label={t('settings.fork.isForkAria')} checked={Boolean(fork)} onCheckedChange={(on) => onChange(on ? turnOn() : false)} />
      <Label htmlFor={id}>{t('settings.fork.isFork')}</Label>
      <p className={`col-start-2 ${HINT}`}>{t(hint)}</p>
    </div>
  );
}

// Items 1 and 2: the original's remote and where the workers' PRs go
function ForkFields({ fork, remotes, context, onChange }: { fork: Fork; remotes: GitRemote[]; context: string; onChange: Change }) {
  const id = useId();
  const original = repositoryOf(remotes, fork.remote);
  const own = repositoryOf(remotes, 'origin');
  const names = remotes.filter((r) => r.name !== 'origin').map((r) => r.name);
  const options = names.includes(fork.remote) ? names : [fork.remote, ...names];
  return (
    <div className="grid grid-cols-[repeat(2,minmax(0,1fr))] gap-3">
      <div id={settingAnchor('settings.fork.remote', context)} className="flex flex-col gap-2">
        <Label htmlFor={`${id}-remote`}>{t('settings.fork.remote')}</Label>
        <Select value={fork.remote} onValueChange={(remote) => onChange({ ...fork, remote })}>
          <SelectTrigger id={`${id}-remote`} className="w-full font-mono"><SelectValue /></SelectTrigger>
          <SelectContent>{options.map((name) => <SelectItem key={name} value={name} className="font-mono">{name}</SelectItem>)}</SelectContent>
        </Select>
        <span className={`font-mono ${HINT}`}>{t('settings.fork.remoteLine', { remote: fork.remote, original, fork: own })}</span>
      </div>
      <div id={settingAnchor('settings.fork.pr', context)} className="flex flex-col gap-2">
        <Label id={`${id}-pr`}>{t('settings.fork.pr')}</Label>
        <ToggleGroup type="single" variant="outline" size="sm" aria-labelledby={`${id}-pr`} value={fork.pr} onValueChange={(pr) => { if (isPrTarget(pr)) onChange(withPrTarget(fork, pr)); }}>
          {PR_TARGETS.map((pr) => <ToggleGroupItem key={pr} value={pr}>{t(`settings.fork.pr.${pr}`)}</ToggleGroupItem>)}
        </ToggleGroup>
        <span className={HINT}>{t(`settings.fork.pr.${fork.pr}.hint`, { original, fork: own })}</span>
      </div>
    </div>
  );
}

// Items 3, 6 and 7: how the fork keeps up; the manual sync, or the last automatic one
function ForkSyncFields({ fork, workspace, context, saved, state, onChange }: { fork: Synced; workspace: string; context: string; saved: boolean; state?: State; onChange: Change }) {
  const id = useId();
  return (
    <div id={settingAnchor('settings.fork.sync', context)} className="flex flex-col gap-2">
      <Label id={`${id}-sync`}>{t('settings.fork.sync')}</Label>
      <ToggleGroup type="single" variant="outline" size="sm" aria-labelledby={`${id}-sync`} value={fork.sync} onValueChange={(sync) => { if (isForkSync(sync)) onChange({ ...fork, sync }); }}>
        {FORK_SYNCS.map((sync) => <ToggleGroupItem key={sync} value={sync}>{t(`settings.fork.sync.${sync}`)}</ToggleGroupItem>)}
      </ToggleGroup>
      <span className={HINT}>{t(`settings.fork.sync.${fork.sync}.hint`)}</span>
      {fork.sync === 'manual' ? <ManualSync workspace={workspace} saved={saved} /> : <LastSync workspace={workspace} remote={fork.remote} state={state} />}
    </div>
  );
}

export interface WorkspaceForkProps { row: WorkspaceDraft; saved: boolean; state?: State; onChange(patch: Partial<WorkspaceDraft>): void }

/** Settings › workspaces › repositório (#854, handoff items 1-4, 6, 7): the suggestion, the fork switch, the original's remote and the PR target,
 * and how the fork keeps up. The remotes come from GET /settings/remotes, never the draft. */
export function WorkspaceFork({ row, saved, state, onChange }: WorkspaceForkProps) {
  const remotes = useRemotes(row.path);
  const { fork } = row;
  const set: Change = (next) => onChange({ fork: next });
  return (
    <div className="flex flex-col gap-3">
      {suggestsFork(fork, remotes) && <ForkSuggestion original={repositoryOf(remotes, SUGGESTED_REMOTE)} onChange={set} />}
      <ForkSwitch fork={fork} remotes={remotes} context={row.id} onChange={set} />
      {fork && <ForkFields fork={fork} remotes={remotes} context={row.id} onChange={set} />}
      {fork && fork.pr !== 'original' && <ForkSyncFields fork={fork} context={row.id} workspace={row.name.trim()} saved={saved} state={state} onChange={set} />}
    </div>
  );
}
