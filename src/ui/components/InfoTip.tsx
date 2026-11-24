import { InfoIcon } from 'lucide-react';
import type { KeyboardEvent, MouseEvent } from 'react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { t } from '@/i18n';

const TOGGLE_KEYS = new Set(['Enter', ' ']);

// Inside a <summary> (a details section, #958) the activation would toggle the section, and inside a form it would do nothing useful: a click
// or a toggle key on the icon only shows the note
function keepParent(event: MouseEvent | KeyboardEvent): void {
  event.preventDefault();
  event.stopPropagation();
}

/** The info icon beside a section's title (#958, #621): its note is a tooltip, so the section carries no hint line under it. */
export function InfoTip({ note }: { note: string }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          type="button" aria-label={t('detail.section.info')}
          className="inline-flex size-4 shrink-0 cursor-help items-center justify-center rounded text-muted-foreground"
          onClick={keepParent} onKeyDown={(event) => { if (TOGGLE_KEYS.has(event.key)) keepParent(event); }}
        >
          <InfoIcon aria-hidden="true" className="size-3" />
        </TooltipTrigger>
        <TooltipContent>{note}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
