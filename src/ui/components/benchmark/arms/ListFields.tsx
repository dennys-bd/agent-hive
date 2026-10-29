import type { ArmSetup, BenchRules } from '../../../../types';
import { ChipList } from '@/components/benchmark/arms/ChipList';
import { Textarea } from '@/components/ui/textarea';
import { t } from '@/i18n';

/** Allowed and denied rules as two chip lines (#536). */
export function RulesField({ value, onChange, isReadOnly }: { value: BenchRules; onChange(value: BenchRules): void; isReadOnly: boolean }) {
  const line = (key: 'allow' | 'deny', add: 'benchmark.arms.settings.addAllow' | 'benchmark.arms.settings.addDeny') => (
    <>
      <span className="pt-0.5 text-muted-foreground text-xs">{t(`benchmark.arms.settings.${key}`)}</span>
      <ChipList
        id={`arm-rules-${key}`} addLabel={t(add)} placeholder={t('benchmark.arms.settings.rulePlaceholder')}
        value={value[key]} isReadOnly={isReadOnly} onChange={(next) => onChange({ ...value, [key]: next })}
      />
    </>
  );
  return <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-2">{line('allow', 'benchmark.arms.settings.addAllow')}{line('deny', 'benchmark.arms.settings.addDeny')}</div>;
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
