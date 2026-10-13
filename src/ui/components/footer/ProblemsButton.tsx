import { CircleCheckIcon, CircleXIcon, InfoIcon, TriangleAlertIcon } from 'lucide-react';
import { keyTitle } from '@/components/KeyHint';
import { Button } from '@/components/ui/button';
import type { ConsoleChannels } from '@/hooks/use-console';
import { useDiagnostics } from '@/hooks/use-diagnostics';
import { t, tPlural } from '@/i18n';
import { type Counts, problems } from '@/lib/diagnostics-store';
import { addCounts, ZERO } from '@/lib/problems';

const COUNTS: { key: keyof Counts; family: 'editor.diag.errors' | 'editor.diag.warnings' | 'editor.diag.infos'; tone: string }[] = [
  { key: 'errors', family: 'editor.diag.errors', tone: 'text-destructive' },
  { key: 'warnings', family: 'editor.diag.warnings', tone: 'text-waiting' },
  { key: 'infos', family: 'editor.diag.infos', tone: 'text-review' },
];

/** Problem counts (#780, #782): each non-zero one in its status colour, the separators muted. The drawer's problems header (#225). */
export function ProblemCounts({ counts }: { counts: Counts }) {
  return (
    <>
      {COUNTS.filter(({ key }) => counts[key] > 0).map(({ key, family, tone }, i) => (
        <span key={key} className="flex items-center gap-1.5">{i > 0 && <span aria-hidden>·</span>}<span className={tone}>{tPlural(family, counts[key], { n: counts[key] })}</span></span>
      ))}
    </>
  );
}

const ICONS: { key: keyof Counts; Icon: typeof CircleXIcon; tone: string }[] = [
  { key: 'errors', Icon: CircleXIcon, tone: 'text-destructive' },
  { key: 'warnings', Icon: TriangleAlertIcon, tone: 'text-waiting' },
  { key: 'infos', Icon: InfoIcon, tone: 'text-review' },
];

/** Errors, warnings and infos over every file of the activity, or of every activity without one (#225). */
export const totalCounts = (activityId?: string): Counts => problems(activityId).reduce((sum, g) => addCounts(sum, g.counts), ZERO);

interface ProblemsButtonProps { activityId?: string; console: ConsoleChannels }

/** The footer's problems (#225, handoff §3.5): a 13px icon and number per non-zero severity, or a muted check; opens and closes the drawer's
 * problems tab, accent while it shows. */
export function ProblemsButton({ activityId, console: channels }: ProblemsButtonProps) {
  useDiagnostics();
  const counts = totalCounts(activityId);
  const shown = ICONS.filter(({ key }) => counts[key] > 0);
  const isPressed = channels.isOpen && channels.tab === 'problems';
  return (
    <Button
      type="button" variant="ghost" aria-label={t('problems.title')} aria-pressed={isPressed} onClick={() => channels.show('problems')}
      title={keyTitle(t(shown.length === 0 ? 'problems.none' : 'problems.title'), 'problems')}
      className={`h-auto shrink-0 gap-2 whitespace-nowrap rounded-sm px-2 py-px font-normal text-xs ${isPressed ? 'bg-accent' : ''}`}
    >
      {shown.length === 0
        ? <CircleCheckIcon aria-hidden className="size-[13px] text-muted-foreground" />
        : shown.map(({ key, Icon, tone }) => <span key={key} className={`flex items-center gap-1 ${tone}`}><Icon aria-hidden className="size-[13px]" />{counts[key]}</span>)}
    </Button>
  );
}
