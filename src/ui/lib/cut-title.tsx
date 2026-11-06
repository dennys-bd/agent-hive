import { type ReactElement, type RefObject, useState } from 'react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

const isCut = (el: HTMLElement | null): boolean =>
  el !== null && (el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight);

type CutRef = RefObject<HTMLElement | null>;
interface CutTitleProps { text: string; cutRef: CutRef | readonly CutRef[]; children: ReactElement }

/** A cut text's full version on hover (#91), in the Hive's tooltip so it shows at once (#284): the child is the hover's target, cutRef
 * the text that may be cut, by width (truncate) or by height (line-clamp). Measured each time it would open, so a resize needs no
 * observer. Several refs when a text truncates inside a row that may clip too (#719); an empty text never opens. While open, an empty title on the target hides an ancestor's native one (a card's drag hint) under the tooltip. */
export function CutTitle({ text, cutRef, children }: CutTitleProps) {
  const [isOpen, setOpen] = useState(false);
  return (
    <TooltipProvider>
      <Tooltip open={isOpen} onOpenChange={(open) => setOpen(open && text !== '' && [cutRef].flat().some((ref) => isCut(ref.current)))}>
        <TooltipTrigger asChild title={isOpen ? '' : undefined}>{children}</TooltipTrigger>
        <TooltipContent>{text}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
