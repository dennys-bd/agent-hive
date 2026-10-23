import { XIcon } from 'lucide-react';
import type { BenchTask } from '../../../../types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { t } from '@/i18n';

interface TaskRowProps { task: BenchTask; onChange(patch: Partial<BenchTask>): void; onRemove(): void }

function TaskRow({ task, onChange, onRemove }: TaskRowProps) {
  return (
    <div className="grid grid-cols-[80px_minmax(0,1fr)_140px_auto] items-start gap-2">
      <Input aria-label={t('benchmark.arms.settings.taskKey')} value={task.key} onChange={(e) => onChange({ key: e.target.value })} className="font-mono text-xs" />
      <Input aria-label={t('benchmark.arms.settings.taskTitle')} value={task.title} onChange={(e) => onChange({ title: e.target.value })} />
      {/* raw split: a trailing space survives the next render; cleanSetup drops the blanks on save */}
      <Input aria-label={t('benchmark.arms.settings.taskBlockedBy')} value={task.blockedBy.join(' ')} onChange={(e) => onChange({ blockedBy: e.target.value.split(' ') })} className="font-mono text-xs" />
      <Button type="button" size="icon-xs" variant="ghost" aria-label={t('benchmark.arms.settings.removeTask', { key: task.key })} onClick={onRemove}><XIcon aria-hidden="true" /></Button>
      <Textarea aria-label={t('benchmark.arms.settings.taskBody')} rows={2} value={task.body} onChange={(e) => onChange({ body: e.target.value })} className="col-span-4 text-xs" />
    </div>
  );
}

/** The arm's (or the base's) tasks as rows: key, title, blocked by (keys separated by spaces), body (#462). */
export function TasksField({ value, onChange }: { value: readonly BenchTask[]; onChange(tasks: BenchTask[]): void }) {
  const change = (i: number, patch: Partial<BenchTask>): void => onChange(value.map((task, j) => (j === i ? { ...task, ...patch } : task)));
  return (
    <div className="flex flex-col gap-3">
      {value.map((task, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a row has no identity of its own: its key is the text being typed
        <TaskRow key={i} task={task} onChange={(patch) => change(i, patch)} onRemove={() => onChange(value.filter((_, j) => j !== i))} />
      ))}
      <Button type="button" size="sm" variant="outline" className="self-start" onClick={() => onChange([...value, { key: `T${value.length + 1}`, title: '', body: '', blockedBy: [] }])}>
        {t('benchmark.arms.settings.addTask')}
      </Button>
    </div>
  );
}
