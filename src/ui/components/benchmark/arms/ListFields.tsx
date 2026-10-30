import type { ArmSetup } from '../../../../types';
import { Textarea } from '@/components/ui/textarea';
import { t } from '@/i18n';

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
