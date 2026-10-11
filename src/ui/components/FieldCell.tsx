import { ChevronDownIcon } from 'lucide-react';
import type { ComponentProps } from 'react';

// The design system's form field: the input border and the card fill on hover, the focus ring every control has; inside its column, no
// negative margin
const CELL =
  'flex h-6 w-full min-w-0 items-center gap-1 rounded-[5px] border border-transparent px-1.5 text-left text-xs outline-none hover:border-input hover:bg-card focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50';

/** One editable value (#60, ui.field-cell): the value, truncated before a ⌄. A trigger's props reach the button (React 19 passes the ref as
 * one), so a Radix trigger wraps it with asChild. A read-only value is never a FieldCell. */
export function FieldCell({ children, ...rest }: Omit<ComponentProps<'button'>, 'className' | 'type'>) {
  return (
    <button type="button" {...rest} data-slot="field-cell" className={CELL}>
      <span className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">{children}</span>
      <ChevronDownIcon aria-hidden="true" className="ml-auto size-3 shrink-0 text-muted-foreground opacity-60" />
    </button>
  );
}
