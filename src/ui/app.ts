import type { Slot, State } from '../types.js';

const STATUS_LABEL: Record<Slot['status'], string> = {
  vazio: 'vazio', trabalhando: 'trabalhando', esperando_voce: 'esperando você', aguardando_review: 'aguardando review',
};
const RERENDER_MS = 30_000;

let state: State | undefined;
let selectedSlotId: string | undefined;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

function elapsed(iso?: string): string {
  if (!iso) return '';
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function showError(message?: string): void {
  const el = $('error');
  el.textContent = message ?? '';
  el.classList.toggle('show', Boolean(message));
}

async function post(path: string, body?: unknown): Promise<void> {
  const res = await fetch(path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const { error } = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
    showError(error ?? res.statusText);
  }
}

function renderCard(slot: Slot): string {
  const occupied = slot.status !== 'vazio';
  const classes = ['card', slot.status, occupied ? 'occupied' : '', slot.draining ? 'draining' : ''].join(' ');
  if (!occupied) return `<div class="${classes}" data-id="${slot.id}"><div class="meta">${STATUS_LABEL.vazio}</div></div>`;
  return `
    <div class="${classes}" data-id="${slot.id}">
      <div class="title">#${slot.task?.number} ${esc(slot.task?.title ?? '')}</div>
      <div class="meta">${STATUS_LABEL[slot.status]} · ${elapsed(slot.startedAt)}${slot.draining ? ' · drenando' : ''}</div>
      <div class="meta">${esc(slot.branch ?? slot.slug ?? '')}</div>
      <div class="meta">${esc(slot.lastEvent ?? '')}</div>
      <div class="actions"><button class="danger" data-kill="${slot.id}">kill</button></div>
    </div>`;
}

function renderDetail(): void {
  const slot = state?.slots.find((s) => s.id === selectedSlotId);
  const panel = $('detail');
  if (!slot || slot.status === 'vazio') {
    panel.classList.remove('show');
    selectedSlotId = undefined;
    return;
  }
  const lines = [
    `<div class="title">#${slot.task?.number} ${esc(slot.task?.title ?? '')}</div>`,
    slot.prUrl ? `<p>PR: <a href="${esc(slot.prUrl)}" target="_blank" rel="noreferrer">${esc(slot.prUrl)}</a></p>` : '',
    slot.question ? `<p>pendente:</p><pre>${esc(slot.question)}</pre>` : '',
    `<div class="meta">worktree: ${esc(slot.worktree ?? '—')}</div>`,
    `<div class="meta">branch: ${esc(slot.branch ?? '—')}</div>`,
    slot.task?.url ? `<div class="meta"><a href="${esc(slot.task.url)}" target="_blank" rel="noreferrer">issue</a></div>` : '',
  ];
  $('detail-body').innerHTML = lines.join('');
  panel.classList.add('show');
}

function render(): void {
  if (!state) return;
  const active = state.slots.filter((s) => s.status !== 'vazio').length;
  $('summary').textContent = `${active}/${state.maxConcurrent} workers ativos`;
  const max = $<HTMLInputElement>('max');
  if (document.activeElement !== max) max.value = String(state.maxConcurrent);
  $('polled').textContent = state.lastPolledAt ? `board: ${new Date(state.lastPolledAt).toLocaleTimeString()}` : '';
  showError(state.error);
  $('grid').innerHTML = state.slots.map(renderCard).join('');
  $('queue').innerHTML = state.queue.map((t) => `<li>#${t.number} ${esc(t.title)}</li>`).join('')
    || '<li style="list-style:none;color:var(--muted)">vazia</li>';
  renderDetail();
}

function connect(): void {
  const source = new EventSource('/events');
  source.onmessage = (event) => {
    state = JSON.parse(event.data) as State;
    render();
  };
  source.onerror = () => showError('conexão com o Agent Hive perdida; reconectando…');
}

$('grid').addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const killId = target.dataset.kill;
  if (killId) {
    event.stopPropagation();
    if (confirm('Matar esse worker? A task volta pra fila.')) void post(`/slots/${killId}/kill`);
    return;
  }
  const card = target.closest<HTMLElement>('.card.occupied');
  if (!card) return;
  selectedSlotId = card.dataset.id;
  renderDetail();
});

$('max').addEventListener('change', (event) => {
  const value = Number((event.target as HTMLInputElement).value);
  if (Number.isInteger(value) && value >= 0) void post('/config', { maxConcurrent: value });
});
$('refresh').addEventListener('click', () => void post('/board/refresh'));
$('focus').addEventListener('click', () => {
  if (selectedSlotId) void post(`/slots/${selectedSlotId}/focus`);
});
$('close').addEventListener('click', () => {
  selectedSlotId = undefined;
  renderDetail();
});

setInterval(render, RERENDER_MS);
connect();
