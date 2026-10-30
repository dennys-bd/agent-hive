import { ChevronRightIcon, XIcon } from 'lucide-react';
import { useState } from 'react';
import type { BenchTask } from '../../../../types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { t } from '@/i18n';

export const TASK_ROWS_SHOWN = 4;
const COLUMNS = 'grid grid-cols-[20px_44px_minmax(0,1fr)_96px_22px] items-center gap-1.5 px-1.5 py-1';
// A cell reads as text until it is hovered or focused, as the screen draws it
const CELL = 'h-auto border-transparent bg-transparent px-1.5 py-0.5 hover:border-border focus:border-border read-only:hover:border-transparent';
const LINK = 'h-auto p-0 text-[13px]';

interface TaskRowProps { task: BenchTask; isReadOnly: boolean; isOpen: boolean; onToggle(): void; onChange(patch: Partial<BenchTask>): void; onRemove(): void }

function TaskRow({ task, isReadOnly, isOpen, onToggle, onChange, onRemove }: TaskRowProps) {
  const body = t('benchmark.arms.settings.tasks.body', { key: task.key });
  return (
    <>
      <div className={`${COLUMNS} border-t`}>
        <Button type="button" size="icon-xs" variant="ghost" aria-label={body} aria-expanded={isOpen} onClick={onToggle}>
          <ChevronRightIcon aria-hidden="true" className={isOpen ? 'rotate-90' : ''} />
        </Button>
        <Input aria-label={t('benchmark.arms.settings.taskKey')} value={task.key} readOnly={isReadOnly} onChange={(e) => onChange({ key: e.target.value })} className={`${CELL} font-mono text-xs`} />
        <Input aria-label={t('benchmark.arms.settings.taskTitle')} value={task.title} readOnly={isReadOnly} onChange={(e) => onChange({ title: e.target.value })} className={CELL} />
        {/* raw split: a trailing space survives the next render; cleanSetup drops the blanks on save */}
        <Input
          aria-label={t('benchmark.arms.settings.taskBlockedBy')} placeholder="—" value={task.blockedBy.join(' ')} readOnly={isReadOnly}
          onChange={(e) => onChange({ blockedBy: e.target.value.split(' ') })} className={`${CELL} font-mono text-xs`}
        />
        {isReadOnly ? <span /> : <Button type="button" size="icon-xs" variant="ghost" aria-label={t('benchmark.arms.settings.removeTask', { key: task.key })} onClick={onRemove}><XIcon aria-hidden="true" /></Button>}
      </div>
      {isOpen && (
        <div className="px-1.5 pt-0.5 pb-1.5">
          <Textarea aria-label={body} rows={2} value={task.body} readOnly={isReadOnly} onChange={(e) => onChange({ body: e.target.value })} className="text-xs" />
        </div>
      )}
    </>
  );
}

interface TasksTableProps { value: readonly BenchTask[]; onChange(tasks: BenchTask[]): void; isReadOnly: boolean }

function TasksTable({ value, onChange, isReadOnly }: TasksTableProps) {
  const [opened, setOpened] = useState<ReadonlySet<number>>(new Set());
  const [isAll, setAll] = useState(false);
  const change = (i: number, patch: Partial<BenchTask>): void => onChange(value.map((task, j) => (j === i ? { ...task, ...patch } : task)));
  const toggle = (i: number): void => setOpened((o) => (o.has(i) ? new Set([...o].filter((k) => k !== i)) : new Set([...o, i])));
  const hidden = value.length - TASK_ROWS_SHOWN;
  return (
    <div className="flex flex-col rounded-md border">
      <div className={`${COLUMNS} text-muted-foreground text-xs`}>
        <span /><span>{t('benchmark.arms.settings.taskKey')}</span><span>{t('benchmark.arms.settings.taskTitle')}</span><span>{t('benchmark.arms.settings.taskBlockedBy')}</span><span />
      </div>
      {value.slice(0, isAll ? value.length : TASK_ROWS_SHOWN).map((task, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a row has no identity of its own: its key is the text being typed
        <TaskRow key={i} task={task} isReadOnly={isReadOnly} isOpen={opened.has(i)} onToggle={() => toggle(i)} onChange={(patch) => change(i, patch)} onRemove={() => onChange(value.filter((_, j) => j !== i))} />
      ))}
      <div className="flex items-center gap-3 border-t px-2 py-1.5 text-muted-foreground text-xs">
        {!isReadOnly && (
          <Button type="button" size="sm" variant="link" className={LINK} onClick={() => onChange([...value, { key: `T${value.length + 1}`, title: '', body: '', blockedBy: [] }])}>
            {t('benchmark.arms.settings.addTask')}
          </Button>
        )}
        {hidden > 0 && (
          <button type="button" aria-expanded={isAll} className="hover:underline" onClick={() => setAll(!isAll)}>
            {isAll ? t('benchmark.arms.settings.chips.less') : t('benchmark.arms.settings.tasks.more', { n: hidden })}
          </button>
        )}
        <span className="ml-auto">{t('benchmark.arms.settings.tasks.blockedHint')}</span>
      </div>
    </div>
  );
}

interface TasksFieldProps {
  value: readonly BenchTask[]; onChange(tasks: BenchTask[]): void; isReadOnly: boolean;
  summary?: string; // an arm that keeps the base's tasks: `8 tarefas · 3 bloqueios · t·91d4`; the table opens from ver e editar
}

/** The arm's (or the base's) tasks as the screen's table (#462, #536): key, title, blocked by (keys separated by spaces), a chevron for the body.
 * An arm on the base's tasks reads one summary line first; editing there is what overrides them. */
export function TasksField({ value, onChange, isReadOnly, summary }: TasksFieldProps) {
  const [isEditing, setEditing] = useState(false);
  const table = <TasksTable value={value} onChange={onChange} isReadOnly={isReadOnly} />;
  if (summary === undefined) return table;
  return (
    <>
      <span className="flex items-center gap-2.5 pt-1 text-muted-foreground">
        <span>{summary}</span>
        <Button type="button" size="sm" variant="link" className={LINK} aria-expanded={isEditing} onClick={() => setEditing(!isEditing)}>
          {t(isEditing ? 'benchmark.arms.settings.tasks.hide' : 'benchmark.arms.settings.tasks.see')}
        </Button>
        {isEditing && <span className="text-xs">{t('benchmark.arms.settings.tasks.editHint')}</span>}
      </span>
      {isEditing && table}
    </>
  );
}
