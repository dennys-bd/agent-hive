import { EllipsisIcon, MoonIcon } from 'lucide-react';
import { type ReactNode, useRef, useState } from 'react';
import type { Experiment, ExperimentStatus } from '../../../types';
import type { Benchmark } from '@/components/benchmark/benchmark-dock';
import { DeleteConfirm, DuplicateConfirm } from '@/components/benchmark/confirms';
import { roundOf } from '@/components/benchmark/sidebar-groups';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { type MessageKey, t } from '@/i18n';

export interface ExperimentHeaderProps { benchmark: Benchmark; experiment: Experiment; primary?: ReactNode }

// running and sleeping read the round; the sleeping chip is static text with the moon (2.8 owns the sleeping header)
const CHIP: Record<ExperimentStatus, { key: MessageKey; className: string }> = {
  running: { key: 'benchmark.header.chip.running', className: 'text-working' },
  sleeping: { key: 'benchmark.header.chip.sleeping', className: 'text-muted-foreground border-empty' },
  draft: { key: 'benchmark.header.chip.draft', className: 'text-empty' },
  done: { key: 'benchmark.header.chip.done', className: 'text-muted-foreground border-empty' },
};
const COMMIT_CHARS = 7;

function creatorOf({ createdBy }: Experiment): string {
  if (createdBy.kind === 'user') return t('benchmark.header.byUser');
  return t('benchmark.header.byMcp', { agent: createdBy.model === undefined ? createdBy.agent : `${createdBy.agent} · ${createdBy.model}` });
}
// The base branch is not in the UI's state, so the baseline names the commit alone
const monoLine = (e: Experiment): string => `${e.id} · ${t('benchmark.header.baseline', { commit: e.seed.commit.slice(0, COMMIT_CHARS) })} · ${creatorOf(e)}`;

function Chip({ experiment }: { experiment: Experiment }) {
  const look = CHIP[experiment.status];
  return (
    <span className={`inline-flex items-center gap-1 rounded-lg border border-current px-1.5 text-[11px] whitespace-nowrap ${look.className}`}>
      {experiment.status === 'sleeping' && <MoonIcon aria-hidden="true" className="size-3" />}
      {t(look.key, roundOf(experiment))}
    </span>
  );
}

// Enter commits (through the blur), Esc cancels; the ref is there because the field unmounts on Esc and a blur may still fire
function NameField({ name, onDone }: { name: string; onDone(next?: string): void }) {
  const isCancelled = useRef(false);
  return (
    <Input
      autoFocus aria-label={t('benchmark.header.nameLabel')} defaultValue={name} className="h-6 min-w-0 flex-1 px-1.5 text-[13px]"
      onBlur={(event) => { if (!isCancelled.current) onDone(event.target.value); }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') {
          isCancelled.current = true;
          onDone(undefined);
        }
      }}
    />
  );
}

interface MoreMenuProps { benchmark: Benchmark; experiment: Experiment; onRename(): void; onDelete(): void }

function MoreMenu({ benchmark, experiment, onRename, onDelete }: MoreMenuProps) {
  const isArchived = experiment.archived === true;
  const { exportReport } = benchmark.slots;
  const isRenamePending = useRef(false);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" size="icon-xs" variant="ghost" aria-label={t('benchmark.header.more')} title={t('benchmark.header.more')}><EllipsisIcon aria-hidden="true" /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        // The field opens once the menu is gone: while it is open its focus trap pulls focus out of the field, and its hand-back to the trigger
        // would blur the field, which commits the rename at once
        onCloseAutoFocus={(event) => {
          if (!isRenamePending.current) return;
          isRenamePending.current = false;
          event.preventDefault();
          onRename();
        }}
      >
        <DropdownMenuItem onSelect={() => { isRenamePending.current = true; }}>{t('benchmark.header.rename')}</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void benchmark.setArchived(experiment.id, !isArchived)}>
          {t(isArchived ? 'benchmark.header.unarchive' : 'benchmark.header.archive')}
        </DropdownMenuItem>
        {exportReport && <DropdownMenuItem onSelect={() => exportReport(experiment)}>{t('benchmark.header.export')}</DropdownMenuItem>}
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-destructive" onSelect={onDelete}>{t('benchmark.header.delete')}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The experiment's head in the window header's centre (#461, benchmark.hv.html's header slot): the name (renamed inline) and its chip, the mono
 * line, dormir while running, duplicar, the selected tab's primary action, the ⋯ menu, and the two confirmations. */
export function ExperimentHeader({ benchmark, experiment, primary }: ExperimentHeaderProps) {
  const [isRenaming, setRenaming] = useState(false);
  const [dialog, setDialog] = useState<'duplicate' | 'delete'>();
  const finish = (next?: string): void => {
    setRenaming(false);
    const name = next?.trim();
    if (name && name !== experiment.name) void benchmark.rename(experiment.id, name);
  };
  const close = (open: boolean): void => { if (!open) setDialog(undefined); };
  const sleep = benchmark.slots.sleep;
  return (
    <div className="flex h-full min-w-0 flex-1 items-center gap-2 px-3">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-2 font-medium text-[13px]">
          {isRenaming ? <NameField name={experiment.name} onDone={finish} /> : <span className="truncate">{experiment.name}</span>}
          <Chip experiment={experiment} />
        </span>
        <span className="truncate font-mono text-[11px] text-muted-foreground">{monoLine(experiment)}</span>
      </div>
      {experiment.status === 'running' && (
        <Button type="button" size="sm" variant="outline" title={t('benchmark.header.sleepTitle')} disabled={sleep === undefined} onClick={() => sleep?.(experiment)} className="disabled:opacity-35">
          <MoonIcon aria-hidden="true" />{t('benchmark.header.sleep')}
        </Button>
      )}
      <Button type="button" size="sm" variant="outline" onClick={() => setDialog('duplicate')}>{t('benchmark.header.duplicate')}</Button>
      {primary}
      <MoreMenu benchmark={benchmark} experiment={experiment} onRename={() => setRenaming(true)} onDelete={() => setDialog('delete')} />
      <DuplicateConfirm experiment={experiment} open={dialog === 'duplicate'} onOpenChange={close} onConfirm={() => benchmark.duplicate(experiment.id)} />
      <DeleteConfirm experiment={experiment} open={dialog === 'delete'} onOpenChange={close} onConfirm={() => benchmark.remove(experiment.id)} />
    </div>
  );
}
