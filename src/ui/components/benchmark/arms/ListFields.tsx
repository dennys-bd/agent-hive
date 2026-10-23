import type { ArmSetup, BenchRules } from '../../../../types';
import { Textarea } from '@/components/ui/textarea';
import { t } from '@/i18n';

interface ListFieldProps { id: string; label: string; value: readonly string[]; onChange(value: string[]): void }

/** One entry per line; blank lines are dropped on save (cleanSetup), so typing a new line never loses it. */
export function ListField({ id, label, value, onChange }: ListFieldProps) {
  return (
    <label htmlFor={id} className="flex flex-col gap-1 text-muted-foreground text-xs">
      {label}
      <Textarea id={id} rows={3} value={value.join('\n')} placeholder={t('benchmark.arms.settings.listHint')} className="font-mono text-foreground text-xs" onChange={(e) => onChange(e.target.value === '' ? [] : e.target.value.split('\n'))} />
    </label>
  );
}

export function RulesField({ value, onChange }: { value: BenchRules; onChange(value: BenchRules): void }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <ListField id="arm-rules-allow" label={t('benchmark.arms.settings.allow')} value={value.allow} onChange={(allow) => onChange({ ...value, allow })} />
      <ListField id="arm-rules-deny" label={t('benchmark.arms.settings.deny')} value={value.deny} onChange={(deny) => onChange({ ...value, deny })} />
    </div>
  );
}

// The workspace's Settings syntax (COPY / RUN lines), the same text the worktree setup runs
export function WorktreeField({ value, onChange }: { value: ArmSetup['worktree']; onChange(value: ArmSetup['worktree']): void }) {
  const field = (key: 'setup' | 'teardown') => (
    <label htmlFor={`arm-worktree-${key}`} className="flex flex-col gap-1 text-muted-foreground text-xs">
      {t(`benchmark.arms.settings.${key}`)}
      <Textarea id={`arm-worktree-${key}`} rows={3} value={value[key]} placeholder={t('benchmark.arms.settings.worktreeHint')} className="font-mono text-foreground text-xs" onChange={(e) => onChange({ ...value, [key]: e.target.value })} />
    </label>
  );
  return <div className="grid grid-cols-2 gap-3">{field('setup')}{field('teardown')}</div>;
}
