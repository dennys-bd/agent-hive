import { useState } from 'react';
import type { BlockProps } from '@/components/settings/StageBlocks';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { t } from '@/i18n';
import { hasFixedVerdicts } from '../../../stage-agent';
import { verdictLabel } from '@/lib/flow-labels';
import { isAgentDraft } from '@/lib/settings-stages';
import { draftVerdicts } from '@/lib/settings-transitions';

/** vereditos (#134, 6b): a prompt stage's own as chips with × and + veredito; a commands or wait-for-CI stage's fixed ones without ×; nenhum: a
 * etapa só termina when there are none. A name is trimmed and kept once. */
export function StageVerdicts({ id, stage, onUpdate }: BlockProps) {
  const [text, setText] = useState('');
  const fixed = hasFixedVerdicts(stage);
  const verdicts = draftVerdicts(stage);
  const add = (): void => {
    const name = text.trim();
    if (name !== '' && !stage.verdicts.includes(name)) onUpdate({ verdicts: [...stage.verdicts, name] });
    setText('');
  };
  return (
    <div className="flex flex-col gap-1">
      <span className="font-medium text-sm">{t('settings.stages.verdicts')}</span>
      <div className="flex flex-wrap items-center gap-1.5">
        {verdicts.length === 0 && <span className="text-muted-foreground text-xs">{t('settings.stages.verdicts.none')}</span>}
        {verdicts.map((v) => (
          <Badge key={v} variant="secondary" className="gap-1">
            {verdictLabel(v, stage.action)}
            {!fixed && (
              <button type="button" className="text-muted-foreground hover:text-foreground" aria-label={t('settings.stages.verdicts.remove', { name: v })} onClick={() => onUpdate({ verdicts: stage.verdicts.filter((x) => x !== v) })}>×</button>
            )}
          </Badge>
        ))}
        {!fixed && isAgentDraft(stage) && (
          <Input
            id={`${id}-verdict`} aria-label={t('settings.stages.verdicts.add')} placeholder={t('settings.stages.verdicts.add')} value={text} className="h-7 w-36"
            onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} onBlur={add}
          />
        )}
      </div>
    </div>
  );
}
