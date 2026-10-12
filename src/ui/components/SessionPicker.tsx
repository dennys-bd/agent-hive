import { CheckIcon, ChevronDownIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { NEW_SESSION } from '../../types';
import { useReviewPane } from '@/components/review-context';
import { SessionLabel } from '@/components/SessionLabel';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { t } from '@/i18n';

/** The session a comment goes to (#591): opens upward, `sessões de {task}`, each session with ✓ on the picked one, then nova sessão ›.
 *  children: the trigger's text in place of the session's label (#113: the design footer's recipient line). */
export function SessionPicker({ value, onChange, children }: { value: string; onChange(session: string): void; children?: ReactNode }) {
  const pane = useReviewPane();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" size="xs" variant="ghost" aria-label={t('review.session')}>{children ?? <SessionLabel id={value} />}<ChevronDownIcon /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start">
        <DropdownMenuLabel>{t('review.sessionsOf', { task: pane.task })}</DropdownMenuLabel>
        {pane.sessions.map((s) => (
          <DropdownMenuItem key={s.id} onSelect={() => onChange(s.id)}>
            <SessionLabel id={s.id} />{s.id === value && <CheckIcon aria-hidden="true" className="ml-auto" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem onSelect={() => onChange(NEW_SESSION)}>{`${t('review.newSession')} ›`}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
