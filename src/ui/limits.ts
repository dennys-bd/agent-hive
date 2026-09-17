import type { Signal, UsageRule } from '../types.js';

// Mirrors SIGNALS in orchestrator.ts, which cannot be imported here (it pulls node:crypto into the browser).
const SIGNALS: readonly Signal[] = ['green', 'yellow', 'red'];
const NO_SIGNAL = ''; // the "—" option: this row does not change the signal

const tbody = (): HTMLTableSectionElement => document.querySelector('#rules tbody') as HTMLTableSectionElement;
const field = <T extends HTMLElement>(row: Element, selector: string): T => row.querySelector(selector) as T;

// Every interpolated value is a number, an empty string or a signal name, so no escaping is needed.
function rowHtml(rule?: UsageRule): string {
  const options = SIGNALS.map((s) => `<option value="${s}"${s === rule?.signal ? ' selected' : ''}>${s}</option>`);
  return `
    <td><input class="percent" type="number" min="0" max="100" step="1" required value="${rule?.percent ?? ''}"></td>
    <td><input class="max-workers" type="number" min="0" step="1" value="${rule?.maxWorkers ?? ''}"></td>
    <td><select class="signal"><option value="${NO_SIGNAL}">—</option>${options.join('')}</select></td>
    <td><button type="button" class="remove">remover</button></td>`;
}

/** Appends a row (empty when no rule) and wires its "remover" button. */
export function addRuleRow(rule?: UsageRule): void {
  const row = document.createElement('tr');
  row.innerHTML = rowHtml(rule);
  field<HTMLButtonElement>(row, 'button.remove').addEventListener('click', () => row.remove());
  tbody().appendChild(row);
}

/** Clears the table and adds one row per rule, in array order (no sorting: applyUsageRules ignores order). */
export function renderRules(rules: UsageRule[]): void {
  tbody().innerHTML = '';
  for (const rule of rules) addRuleRow(rule);
}

// Absent keys stay absent (never an explicit undefined), so hive.config.json stays clean, like budgetFromForm.
function ruleFromRow(row: Element, index: number): UsageRule {
  const maxWorkers = field<HTMLInputElement>(row, 'input.max-workers').value;
  const signal = field<HTMLSelectElement>(row, 'select.signal').value;
  if (maxWorkers === '' && signal === NO_SIGNAL) throw new Error(`faixa ${index + 1}: informe máx. workers ou sinal`);
  return {
    percent: Number(field<HTMLInputElement>(row, 'input.percent').value),
    ...(maxWorkers === '' ? {} : { maxWorkers: Number(maxWorkers) }),
    ...(signal === NO_SIGNAL ? {} : { signal: signal as Signal }),
  };
}

/** One UsageRule per row, in table order. The browser enforces required / 0–100 / min 0; the server validates the rest. */
export function usageRulesFromForm(): UsageRule[] {
  return Array.from(tbody().rows).map(ruleFromRow);
}
