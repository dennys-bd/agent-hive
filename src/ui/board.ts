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
const boardOptions = (selected: string | string[] | undefined): string => {
  const chosen = new Set(selected === undefined ? [] : [selected].flat());
  const names = [...loadedOptions, ...[...chosen].filter((c) => !loadedOptions.includes(c))];
  return names.map((o) => `<option value="${esc(o)}"${chosen.has(o) ? ' selected' : ''}>${esc(o)}</option>`).join('');
};

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
      <label>${t('setup.columns.from')} <select class="col-from" multiple size="4">${boardOptions(column?.from ?? [])}</select></label>
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
  rows().appendChild(row);
}

/** Clears the editor and adds one row per column, in pipeline order. */
export function renderColumnRows(columns: Column[]): void {
  rows().innerHTML = '';
  for (const column of columns) addColumnRow(column);
}

const BOARD_SELECTS = 'select.col-from, select.col-on-start, select.col-on-finish';

/** Keeps the board's columns for new rows and rebuilds the selects of the rows already there, each keeping what it had selected. */
export function fillColumnOptions(options: string[]): void {
  loadedOptions = options;
  for (const select of Array.from(rows().querySelectorAll<HTMLSelectElement>(BOARD_SELECTS))) {
    const chosen = Array.from(select.selectedOptions, (o: HTMLOptionElement) => o.value).filter((v) => v !== '');
    select.innerHTML = (select.multiple ? '' : NONE_OPTION()) + boardOptions(chosen);
  }
}

const text = (row: Element, selector: string): string => field<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(row, selector).value.trim();
const optional = <K extends string>(key: K, value: string): { [P in K]?: string } => (value === '' ? {} : { [key]: value }) as { [P in K]?: string };

// Absent keys stay absent (never an explicit undefined), so hive.config.json stays clean; the server validates the rest.
function columnFromRow(row: Element): Column {
  const session = field<HTMLSelectElement>(row, 'select.col-session').value;
  return {
    name: text(row, 'input.col-name'), weight: Number(text(row, 'input.col-weight')),
    from: Array.from(field<HTMLSelectElement>(row, 'select.col-from').selectedOptions, (o: HTMLOptionElement) => o.value),
    ...(session === 'continue' ? { session: 'continue' as const } : {}),
    ...optional('model', text(row, 'input.col-model')), ...optional('onStart', text(row, 'select.col-on-start')),
    ...optional('onFinish', text(row, 'select.col-on-finish')), ...optional('prompt', text(row, 'textarea.col-prompt')),
  };
}

/** One Column per row, in editor order. */
export function columnsFromForm(): Column[] {
  return Array.from(rows().querySelectorAll('.column-row')).map(columnFromRow);
}
