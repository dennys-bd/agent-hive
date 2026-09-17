import type { Card, Column, Slot, State } from '../types.js';
import { esc } from './highlight.js';
import { statusText, t } from './i18n.js';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const rows = (): HTMLElement => $('columns-rows');
const field = <T extends HTMLElement>(row: Element, selector: string): T => row.querySelector(selector) as T;

function cardActions(card: Card, slot: Slot | undefined, column: Column | undefined): string {
  if (card.missing) {
    return `<div class="missing-bar">${t('card.missing')} <button type="button" data-close="${esc(card.task.itemId)}">${t('card.close')}</button><button type="button" data-keep="${esc(card.task.itemId)}">${t('card.keep')}</button></div>`;
  }
  if (slot) return `<div><button type="button" data-focus="${slot.id}">terminal</button></div>`;
  if (card.task.blockedBy?.length) return `<div class="meta">${t('card.blockedBy', { ids: esc(card.task.blockedBy.join(', ')) })}</div>`;
  return column?.prompt === undefined ? '' : `<div><button type="button" data-start="${esc(card.task.itemId)}">${t('card.start')}</button></div>`;
}

function renderBoardCard(card: Card, state: State): string {
  const slot = state.slots.find((s) => s.id === card.slotId);
  const column = state.columns.find((c) => c.name === card.column);
  const classes = ['bcard', slot?.status ?? '', card.missing ? 'missing' : '', card.orphan ? 'orphan' : ''].join(' ');
  return `
    <div class="${classes}" data-card="${esc(card.task.itemId)}">
      <div class="title">#${esc(card.task.id)} ${esc(card.task.title)}</div>
      <div class="meta">${slot ? `${statusText(slot.status)} · ` : ''}${esc(card.branch ?? card.slug)}${card.orphan ? ` · ${t('card.orphan')}` : ''}</div>
      ${card.prUrl ? `<div class="meta"><a href="${esc(card.prUrl)}" target="_blank" rel="noreferrer">PR</a></div>` : ''}
      ${cardActions(card, slot, column)}
    </div>`;
}

/** One column per config entry, its cards in board order; every card string is escaped here. */
export function renderBoard(state: State): string {
  return state.columns.map((column) => {
    const cards = state.cards.filter((c) => c.column === column.name);
    return `<div class="column"><h3>${esc(column.name)} · ${column.weight}</h3>${cards.map((c) => renderBoardCard(c, state)).join('') || `<div class="meta">${t('column.empty')}</div>`}</div>`;
  }).join('');
}

// ---------- setup: the column editor ----------

let loadedOptions: string[] = []; // board columns from GET /setup/columns; a saved value not among them is kept so the form never loses it

const NONE_OPTION = (): string => `<option value="">${t('setup.columns.none')}</option>`;

// The loaded columns first, then whatever is selected but not loaded (a saved config before "load" ran); only these can be picked.
const pickable = (chosen: Set<string>): string[] => [...loadedOptions, ...[...chosen].filter((c) => !loadedOptions.includes(c))];

const boardOptions = (selected: string | undefined): string => {
  const chosen = new Set(selected === undefined ? [] : [selected]);
  return pickable(chosen).map((o) => `<option value="${esc(o)}"${chosen.has(o) ? ' selected' : ''}>${esc(o)}</option>`).join('');
};

// A dropdown (native <details>) with one checkbox per board column: a plain click toggles, which a <select multiple> only does
// with a modifier key, and the list can grow without taking the form over. The summary names what is picked.
const boardChecks = (selected: string[]): string => {
  const chosen = new Set(selected);
  const items = pickable(chosen).map((o) => `<label class="check"><input type="checkbox" value="${esc(o)}"${chosen.has(o) ? ' checked' : ''}> ${esc(o)}</label>`);
  return `<details><summary>${esc(summaryOf(selected))}</summary><div class="menu">${items.join('')}</div></details>`;
};

const summaryOf = (selected: string[]): string => (selected.length === 0 ? t('setup.columns.none') : selected.join(', '));

function rowHtml(column?: Column): string {
  const option = (value: 'new' | 'continue'): string => `<option value="${value}"${column?.session === value ? ' selected' : ''}>${t(`setup.columns.session.${value}`)}</option>`;
  return `
    <div class="row">
      <label>${t('setup.columns.name')} <input class="col-name" type="text" required value="${esc(column?.name ?? '')}"></label>
      <label>${t('setup.columns.weight')} <input class="col-weight" type="number" min="0" step="1" required value="${column?.weight ?? 1}"></label>
      <label>${t('setup.columns.session')} <select class="col-session">${option('new')}${option('continue')}</select></label>
      <label>${t('setup.columns.model')} <input class="col-model" type="text" value="${esc(column?.model ?? '')}"></label>
    </div>
    <div class="row">
      <div class="field"><span>${t('setup.columns.from')}</span><div class="col-from">${boardChecks(column?.from ?? [])}</div></div>
      <label>${t('setup.columns.onStart')} <select class="col-on-start">${NONE_OPTION()}${boardOptions(column?.onStart)}</select></label>
      <label>${t('setup.columns.onFinish')} <select class="col-on-finish">${NONE_OPTION()}${boardOptions(column?.onFinish)}</select></label>
    </div>
    <label>${t('setup.columns.prompt')} <textarea class="col-prompt" rows="2" spellcheck="false">${esc(column?.prompt ?? '')}</textarea></label>
    <div class="row">
      <button type="button" class="col-up">↑</button><button type="button" class="col-down">↓</button>
      <button type="button" class="col-remove">${t('setup.columns.remove')}</button>
    </div>`;
}

/** Appends a row (empty when no column) and wires its move / remove buttons. */
export function addColumnRow(column?: Column): void {
  const row = document.createElement('div');
  row.className = 'column-row';
  row.innerHTML = rowHtml(column);
  field<HTMLButtonElement>(row, 'button.col-remove').addEventListener('click', () => row.remove());
  field<HTMLButtonElement>(row, 'button.col-up').addEventListener('click', () => row.previousElementSibling?.before(row));
  field<HTMLButtonElement>(row, 'button.col-down').addEventListener('click', () => row.nextElementSibling?.after(row));
  const from = field<HTMLElement>(row, '.col-from');
  from.addEventListener('change', () => { field<HTMLElement>(from, 'summary').textContent = summaryOf(checked(from)); });
  rows().appendChild(row);
}

// One listener for every dropdown: a click anywhere outside an open one closes it, as a select would
document.addEventListener('click', (e) => {
  for (const open of Array.from(document.querySelectorAll<HTMLDetailsElement>('.col-from details[open]'))) {
    if (!open.contains(e.target as Node)) open.open = false;
  }
});

/** Clears the editor and adds one row per column, in pipeline order. */
export function renderColumnRows(columns: Column[]): void {
  rows().innerHTML = '';
  for (const column of columns) addColumnRow(column);
}

const checked = (box: Element): string[] =>
  Array.from(box.querySelectorAll<HTMLInputElement>('input:checked'), (i: HTMLInputElement) => i.value);

/** Keeps the board's columns for new rows and rebuilds the pickers of the rows already there, each keeping what it had picked. */
export function fillColumnOptions(options: string[]): void {
  loadedOptions = options;
  for (const box of Array.from(rows().querySelectorAll('.col-from'))) box.innerHTML = boardChecks(checked(box));
  for (const select of Array.from(rows().querySelectorAll<HTMLSelectElement>('select.col-on-start, select.col-on-finish'))) {
    select.innerHTML = NONE_OPTION() + boardOptions(select.value === '' ? undefined : select.value);
  }
}

const text = (row: Element, selector: string): string => field<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(row, selector).value.trim();
const optional = <K extends string>(key: K, value: string): { [P in K]?: string } => (value === '' ? {} : { [key]: value }) as { [P in K]?: string };

// Absent keys stay absent (never an explicit undefined), so hive.config.json stays clean; the server validates the rest.
function columnFromRow(row: Element): Column {
  const session = field<HTMLSelectElement>(row, 'select.col-session').value;
  return {
    name: text(row, 'input.col-name'), weight: Number(text(row, 'input.col-weight')),
    from: checked(field<HTMLElement>(row, '.col-from')),
    ...(session === 'continue' ? { session: 'continue' as const } : {}),
    ...optional('model', text(row, 'input.col-model')), ...optional('onStart', text(row, 'select.col-on-start')),
    ...optional('onFinish', text(row, 'select.col-on-finish')), ...optional('prompt', text(row, 'textarea.col-prompt')),
  };
}

/** One Column per row, in editor order. */
export function columnsFromForm(): Column[] {
  return Array.from(rows().querySelectorAll('.column-row')).map(columnFromRow);
}
