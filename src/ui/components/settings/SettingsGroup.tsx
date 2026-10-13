import { useId, type ReactNode } from 'react';
import { type MessageKey, t } from '@/i18n';
import { settingAnchor } from '@/lib/settings-search';

interface SettingsGroupProps { title: MessageKey; hint?: MessageKey; control?: ReactNode; action?: ReactNode; flush?: boolean; anchor?: string; children: ReactNode }

// A card of a Settings section (#510): its title is an h2, one level under the section's h1 and above the field labels.
// action (#512): an optional control in the header, right-aligned (an add button, a clean-all).
// hint, flush (#513): a group's one-line explanation; row lists that draw their own borders.
// control (#524): a control that belongs to the title (task workspace's fixo/dinâmico), between it and the hint. anchor: an id to scroll to; by default the title's, which the Settings search lands on (#689).
// The hint sits beside the title, on its baseline, when the card is wide enough for one line (@2xl, 672px), and drops whole under it when
// not: never wrapped beside the title. A container query, since the card's width, not the window's, decides (the side menu takes its share).
// The container is the header, never the section: a query container has layout containment, which silently turns a subgrid back into a
// plain grid, and cards side by side then split the leftover height between their header and body (#614).
// A two-row subgrid (header, body): cards side by side in a section grid share its rows, so their headers take the tallest one's height and
// their dividers line up. gap-y-0 keeps the grid's gap from opening between a card's own header and body. Outside a grid it is inert.
// grid-cols-[minmax(0,1fr)] (#887): with no template the implicit column is auto-sized, so a fixed-width child (the stages chart) widened it past the card.
export function SettingsGroup({ title, hint, control, action, flush, anchor, children }: SettingsGroupProps) {
  const id = useId();
  return (
    <section id={anchor ?? settingAnchor(title)} aria-labelledby={id} className="row-span-2 grid grid-cols-[minmax(0,1fr)] grid-rows-subgrid gap-y-0 rounded-xl border bg-card shadow-sm">
      <div className="@container flex items-center gap-3 border-b px-5 py-3">
        <div className="flex min-w-0 flex-col gap-0.5 @2xl:flex-row @2xl:items-baseline @2xl:gap-2">
          <h2 id={id} className="whitespace-nowrap font-semibold text-sm leading-none">{t(title)}</h2>
          {control}
          {hint && <span className="text-muted-foreground text-xs">{t(hint)}</span>}
        </div>
        {action && <div className="ml-auto flex items-center gap-2">{action}</div>}
      </div>
      <div className={flush ? 'flex flex-col' : 'flex flex-col gap-4 p-5'}>{children}</div>
    </section>
  );
}
