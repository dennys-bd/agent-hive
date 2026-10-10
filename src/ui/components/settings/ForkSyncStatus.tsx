import { CheckIcon, CircleAlertIcon, RefreshCwIcon } from 'lucide-react';
import { useState } from 'react';
import type { ForkSyncAnswer, ForkSyncResult, State } from '../../../types';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';
import { postJson } from '@/lib/api';
import { relativeTime } from '@/lib/home';
import { lastSync } from '@/lib/settings-fork';

interface Lines { ok: boolean; first: string; second?: string }

// One status line (handoff item 6): a 14px icon and two lines. Success takes no status colour (green is working); a failure is destructive
function StatusLine({ ok, first, second }: Lines) {
  const Icon = ok ? CheckIcon : CircleAlertIcon;
  return (
    <div role="status" className="flex items-start gap-2">
      <Icon aria-hidden="true" className={`mt-0.5 size-3.5 shrink-0 ${ok ? 'text-muted-foreground' : 'text-destructive'}`} />
      <div className="flex flex-col">
        <span className="text-sm">{first}</span>
        {second !== undefined && <span className="text-muted-foreground text-xs">{second}</span>}
      </div>
    </div>
  );
}

/** What a manual sync answered, in words (#854). */
export function manualLines(answer: ForkSyncAnswer): Lines {
  const now = t('home.now');
  const n = answer.commits ?? 0;
  if (answer.result === 'synced') return { ok: true, first: t('settings.fork.synced'), second: `${t('settings.fork.got', { n })} · ${now}` };
  if (answer.result === 'current') return { ok: true, first: t('settings.fork.current'), second: `${t('settings.fork.noNew')} · ${now}` };
  if (answer.result === 'diverged') return { ok: false, first: t('settings.fork.diverged'), second: t('settings.fork.onlyFork', { n }) };
  if (answer.result === 'offline') return { ok: false, first: t('settings.fork.failed', { reason: t('settings.fork.offline') }) };
  return { ok: false, first: t('settings.fork.failed', { reason: answer.reason ?? '' }), second: t('settings.fork.checkGh') };
}

/** sincronizar agora (#854): POST /workspaces/:name/sync once, its answer beside the button; off until the workspace is saved. */
export function ManualSync({ workspace, saved }: { workspace: string; saved: boolean }) {
  const [isSyncing, setSyncing] = useState(false);
  const [lines, setLines] = useState<Lines>();
  const sync = (): void => {
    setSyncing(true);
    postJson<ForkSyncAnswer>(`/workspaces/${encodeURIComponent(workspace)}/sync`)
      .then((answer) => setLines(manualLines(answer)), (err: Error) => setLines({ ok: false, first: t('settings.fork.failed', { reason: err.message }) }))
      .finally(() => setSyncing(false));
  };
  return (
    <div className="flex flex-wrap items-start gap-3 pt-1">
      <Button type="button" variant="outline" size="sm" disabled={!saved || isSyncing} onClick={sync}>
        <RefreshCwIcon />{t(isSyncing ? 'settings.fork.syncing' : 'settings.fork.syncNow')}
      </Button>
      {lines && <StatusLine {...lines} />}
    </div>
  );
}

/** The last automatic sync in words (#854, handoff item 7): the task, how long ago, and what the worktree started from. */
export function lastLines(sync: ForkSyncResult, task: string, remote: string): Lines {
  const when = relativeTime(sync.at);
  const branch = sync.base.slice(sync.base.indexOf(':') + 1);
  const merged = `${remote}/${branch}`;
  const asItWas = t('settings.fork.last.asItWas', { ref: `origin/${branch}` });
  const n = sync.commits ?? 0;
  if (sync.result === 'synced' || sync.result === 'current') {
    return { ok: true, first: t('settings.fork.last.synced', { task, when }), second: sync.mode === 'github' ? t('settings.fork.got', { n }) : t('settings.fork.last.merged', { ref: merged, n }) };
  }
  if (sync.result === 'diverged') return { ok: false, first: t('settings.fork.last.failed', { task, when, reason: t('settings.fork.divergedShort') }), second: `${asItWas} · ${t('settings.fork.onlyForkN', { n })}` };
  if (sync.result === 'conflict') {
    return { ok: false, first: t('settings.fork.last.conflict', { ref: merged, task, when }), second: t('settings.fork.last.undid', { ref: `origin/${branch}`, file: (sync.files ?? []).join(', ') }) };
  }
  const reason = sync.result === 'offline' ? t('settings.fork.offline') : sync.reason ?? '';
  return { ok: false, first: t('settings.fork.last.failed', { task, when, reason }), second: asItWas };
}

/** The workspace's newest automatic sync (#854), in place of the button; nothing before the first worktree. */
export function LastSync({ workspace, remote, state }: { workspace: string; remote: string; state?: State }) {
  const last = lastSync(state, workspace);
  return last === undefined ? null : <StatusLine {...lastLines(last.sync, last.task, remote)} />;
}
