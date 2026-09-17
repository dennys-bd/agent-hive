# Agent Hive — visible cards per column: the first N and a "show more"

Extends the Hive columns (`docs/superpowers/specs/2026-09-17-hive-columns-design.md`) and the React UI (`2026-09-17-react-ui-design.md`) on top of v1 (`2026-09-15-agent-hive-design.md`), which is authoritative for anything not covered here. Issue: <https://github.com/dennys-bd/agent-hive/issues/46>.

The issue was filed against the queue panel; since #79 the queue is the board (`HiveBoard.tsx`, one column per `columns[]`), and each column renders every card it has, with title and blockers. The entry column has 13+ cards today and grows with the board. Each column gets a configurable cap on visible cards, with an inline toggle that reveals the rest; running cards always show; the column header shows the total so that "5 visible" does not read as "5 exist". Only the delta is described here.

## Closed decisions

| Decision | Choice | Reason |
|---|---|---|
| Where it applies | Every Hive column, through a `visible?: number` field on `Column` | The queue panel became a column; one generic rule covers the entry column (the issue's case) and any other that grows, with no special case in the UI |
| Value | `visible` absent or `0` = no limit; a new column in setup starts at `5` | An existing config without the field keeps behaving the same (nothing changes silently); the default only applies to whoever creates a column in the editor, which is where the field is visible |
| Running cards | Always visible and counted against the cap: `visible: 5` with 3 running shows 3 running + 2 stopped; 7 running shows all 7 and no stopped card | What is running is what the user needs to see (`terminal` button, error, PR); hiding it behind a toggle would be worse than the long list |
| Reveal | Inline toggle under the visible cards (`+8 more` / `show less`); the column grows with the page; state per column, in memory, reset on reload | No scrollbar inside the card and no blocker hidden below the fold; remembering in `localStorage` was rejected as YAGNI |
| Header | `Backlog · 13 cards · weight 3` (count always shown, even with nothing hidden; weight stays) | Total at a glance without depending on the toggle; the weight stays because it is the column's priority and already lives in the header |
| Order | Board order, as today; the visible set is running ∪ the first stopped cards that fit | Nothing the user already recognises is reordered; only filtered |

## Config

```json
"columns": [
  { "name": "spec", "weight": 5, "visible": 5, "from": ["Backlog"], "onFinish": "Ready", "prompt": "/hive-spec {url}" },
  { "name": "dev", "weight": 1, "from": ["Ready"], "onStart": "In progress", "onFinish": "In review", "prompt": "/hive-build {url}", "session": "continue" }
]
```

`parseColumn`: `visible` optional, integer ≥ 0 (`requireInt`), otherwise `hive.config.json: "columns[0].visible" must be a non-negative integer`; when absent it is left out of the object (same pattern as `optionalString`). `legacyColumns` proposes `visible: 5`, since it is a new column in the user's eyes. Nothing else changes in `config.ts`.

## Types (`src/types.ts`)

```ts
export interface Column {
  // ...today's fields
  visible?: number; // cards shown before the "show more" toggle; absent or 0 = all; running cards always show and count
}
```

`ColumnDraft` (`src/ui/lib/setup-form.ts`) gains `visible: string`; `emptyColumn()` starts at `'5'`; `columnDraft` reads `c.visible ?? ''`; `columnFrom` leaves the field out when the text is empty or `'0'` (config without `visible` = no limit), otherwise `Number`. `columnsProblem` accepts empty or an integer ≥ 0; the `setup.columns.error` message now mentions `visible` too (`column {n}: enter a name, an integer weight ≥ 0 and, if set, an integer visible ≥ 0`).

## Behaviour per file

- `src/ui/components/HiveBoard.tsx`: the column no longer maps `cards` directly; it goes through a `ColumnCards({ cards, column, state })` component with a `useState(false)` for expanded. `running = cards.filter((c) => c.slotId)`; `cap = column.visible`; without `cap` (absent or `0`) or when expanded, render everything. Otherwise `room = Math.max(cap - running.length, 0)`, and the visible set is the running cards plus the first `room` stopped cards, keeping array order; `hidden = cards.length - shown.length`. With `hidden > 0`, a `Button` `variant="ghost" size="xs"` below the cards reading `t('column.more', { n: hidden })`; when expanded, `t('column.less')`. When `hidden` drops to `0` (a card left, config changed) the button disappears and the state becomes irrelevant. Header: `${column.name} · ${t('column.cards', { n: cards.length })} · ${t('column.weight', { w: column.weight })}`. An empty column still shows `column.empty`.
- `src/ui/components/setup/ColumnEditor.tsx`: an `Input type="number" min={0} step={1}` labelled `setup.columns.visible` next to the weight, `defaultValue={column.visible}`, `onChange` → `onUpdate({ visible })`.
- `src/ui/i18n.ts` (en / pt): `column.cards` `'{n} cards'` / `'{n} cards'`; `column.weight` `'weight {w}'` / `'peso {w}'`; `column.more` `'+{n} more'` / `'+{n} mais'`; `column.less` `'show less'` / `'mostrar menos'`; `setup.columns.visible` `'visible'` / `'visíveis'`; `setup.columns.error` updated in both languages; `setup.columns.hint` gains one sentence: `visible` caps the cards shown before "show more", empty = all, running cards always show.
- `docs/` that describe the config (`README`, setup hint) mention the field.

## Tests

- `test/config.test.ts`: absent `visible` does not appear in the object; `0` and `3` pass; `-1` and `1.5` fail with `"columns[0].visible" must be a non-negative integer`; `legacyColumns` carries `visible: 5`.
- `test/setup-form.test.ts`: `emptyColumn().visible === '5'`; `columnDraft` of a column without `visible` gives `''`; `columnFrom` omits it for `''` and `'0'`, and sends `visible: 5` for `'5'`; `'-1'` and `'1.5'` fall into `setup.columns.error`.
- `test/ui/HiveBoard.test.tsx`: a column with `visible: 2` and 5 stopped cards shows 2 and the `+3 more` button; clicking shows 5 and `show less`; clicking again goes back to 2. A column with `visible: 2`, 3 running and 2 stopped shows the 3 running, no stopped card, and `+2 more`. Without `visible` (or `0`) everything shows and there is no button. Header reads `spec · 5 cards · weight 5`.
- `test/i18n.test.ts`: the new keys exist in both languages (the existing parity test covers it).
