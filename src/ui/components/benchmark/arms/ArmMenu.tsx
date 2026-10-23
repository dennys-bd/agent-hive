import { EllipsisIcon } from 'lucide-react';
import { useRef, useState } from 'react';
import { isLocked as isLockedExperiment, nextLetter } from '../../../../benchmark/arms.js';
import type { Arm, Experiment } from '../../../../types';
import { addArm, copyArm, editArm } from '@/components/benchmark/arms/arm-api';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent,
  DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { type MessageKey, t } from '@/i18n';

const COPY_LABEL: Record<'overrides' | 'tasks', MessageKey> = { overrides: 'benchmark.arms.menu.copyOverrides', tasks: 'benchmark.arms.menu.copyTasks' };
interface CopySubProps { experiment: Experiment; arm: Arm; what: 'overrides' | 'tasks'; disabled: boolean }

// A checkbox per other arm; copiar posts the checked ones at once, in arm order. A check keeps the menu open
function CopySub({ experiment, arm, what, disabled }: CopySubProps) {
  const [picked, setPicked] = useState<readonly string[]>([]);
  const others = experiment.arms.filter((a) => a.id !== arm.id);
  const toggle = (id: string, isOn: boolean): void => setPicked((p) => (isOn ? [...p, id] : p.filter((x) => x !== id)));
  const to = others.filter((a) => picked.includes(a.id)).map((a) => a.id);
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={disabled}>
        {t(COPY_LABEL[what])}<span className="ml-auto text-muted-foreground text-xs">{`${others.map((a) => a.letter).join(' · ')} ›`}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-h-72 overflow-y-auto">
        {others.map((a) => (
          <DropdownMenuCheckboxItem key={a.id} checked={picked.includes(a.id)} onCheckedChange={(on) => toggle(a.id, on === true)} onSelect={(e) => e.preventDefault()}>
            {`${a.letter} · ${a.name}`}
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={to.length === 0} onSelect={() => { setPicked([]); void copyArm(experiment.id, arm.id, what, to); }}>{t('benchmark.arms.menu.copy')}</DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

export interface ArmMenuProps { experiment: Experiment; arm: Arm; overrideCount: number; onRename(): void; onRemove(): void; onCompare(): void }

/** An arm's ⋯ (#462). While the experiment runs or sleeps every item that writes is disabled; ver em comparar stays. */
export function ArmMenu({ experiment, arm, overrideCount, onRename, onRemove, onCompare }: ArmMenuProps) {
  const isLocked = isLockedExperiment(experiment);
  const isAlone = experiment.arms.length === 1;
  const isRenamePending = useRef(false);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" size="icon-xs" variant="ghost" aria-label={t('benchmark.arms.menu.label', { letter: arm.letter })} title={t('benchmark.arms.menu.label', { letter: arm.letter })}><EllipsisIcon aria-hidden="true" /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end" className="w-[260px]"
        // the field opens once the menu is gone, as the header's rename: the focus hand-back would blur it, which commits (#461)
        onCloseAutoFocus={(event) => { if (!isRenamePending.current) return; isRenamePending.current = false; event.preventDefault(); onRename(); }}
      >
        <DropdownMenuItem disabled={isLocked || nextLetter(experiment.arms) === undefined} onSelect={() => void addArm(experiment.id, arm.id)}>{t('benchmark.arms.menu.duplicate')}</DropdownMenuItem>
        <CopySub experiment={experiment} arm={arm} what="overrides" disabled={isLocked || isAlone} />
        <CopySub experiment={experiment} arm={arm} what="tasks" disabled={isLocked || isAlone} />
        <DropdownMenuItem onSelect={onCompare}>{t('benchmark.arms.menu.compare')}</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={isLocked || overrideCount === 0} onSelect={() => void editArm(experiment.id, arm.id, { overrides: {} })}>{t('benchmark.arms.menu.reset')}</DropdownMenuItem>
        <DropdownMenuItem disabled={isLocked} onSelect={() => { isRenamePending.current = true; }}>{t('benchmark.arms.menu.rename')}</DropdownMenuItem>
        <DropdownMenuItem disabled={isLocked || isAlone} className="text-destructive" onSelect={onRemove}>{t('benchmark.arms.menu.remove')}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
