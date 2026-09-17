# Agent Hive — sessão Claude do worker (id e comando de retomada)

Extensão da v1 (`2026-09-15-agent-hive-design.md`) e dos logs persistentes (`2026-09-17-persistent-logs-design.md`). Cada worker roda uma sessão do Claude Code e todo hook já chega com o `session_id` dela, mas o Hive descarta: só guarda a sessão tmux/iTerm (pra focar a janela). Este item persiste o `session_id` no slot, mostra no painel o comando pra reabrir a sessão à mão (`claude --resume <id>`) e deixa uma linha no `hive.log` que liga worker, task e sessão, pra um PR/commit ser rastreado depois que o slot já foi liberado. É o dado que #24 (sessão principal × subagente) precisa e a base pra #26 evoluir de "pausar" pra "retomar". Issue: <https://github.com/dennys-bd/agent-hive/issues/29>.

## Decisões fechadas

| Decisão | Escolha | Motivo |
|---|---|---|
| Fonte do id | `session_id` do payload do hook `SessionStart` (`HookPayload.session_id?: string`) | Já chega em todo hook, sem custo; `SessionStart` é o mesmo ponto onde o reducer guarda `worktree`, `branch` e `transcriptPath` |
| Onde fica | `Slot.sessionId?: string`; gravado pelo reducer no `SessionStart` | O slot é a unidade que a UI, o `state.json` e o log já conhecem; nada novo de persistência |
| Validação | Só um id no formato `^[A-Za-z0-9_-]{8,64}$` é aceito; qualquer outro valor é ignorado (o resto do hook continua valendo) | Mesmo padrão do `transcript_path`: qualquer processo local bate em `/hooks/event`, e o valor vai pro `innerHTML` (escapado) e pro log |
| Primeiro vence | Um `SessionStart` num slot que já tem `sessionId` não sobrescreve | Em team mode um teammate dispara `SessionStart` com o mesmo `x-hive-worker` (#24); a sessão principal sempre começa antes, então o primeiro id é o dela. `/clear` num worker geraria um id novo que ficaria de fora; é raro num worker autônomo e é assunto de #24 (separar sessões por `source`) |
| Onde aparece na UI | Painel de detalhe: `sessão: claude --resume <id>` em `<code>`, logo abaixo de `branch`; o card não muda | O painel já lista worktree e branch, que é onde o comando tem que ser rodado; o card já tem duas linhas de meta e um uuid não cabe |
| Rastro durável | `describeChanges` emite `slot N: session=<id> #<task> worker=<short>` quando o `sessionId` passa de ausente a presente; entra no `hive.log` em `info` | O slot é limpo no `exit`/`boot`; o log é o que sobra. A linha `PR aberto` (transição pra `aguardando_review`) e esta compartilham `worker=`, então PR → sessão é um grep |
| Issue / PR no GitHub | Nada é escrito na issue nem no PR | Comentar custa chamada de API (#25); o worker é quem abre o PR e não conhece o próprio id; o log cobre o rastro |
| Link web | Não existe | Uma sessão de CLI não tem URL estável; o `claude --resume <id>` é a forma de reabrir |
| Retomar pelo Hive | Fora; `boot` continua dando todo slot ocupado como morto | É o escopo de #26; este item só garante que o id está no slot e no `state.json` |

## Config

Sem config nova.

## Tipos

Em `src/types.ts`:

```ts
export interface Slot {
  /* como hoje */
  sessionId?: string; // Claude Code session id from SessionStart; what `claude --resume` takes. First one wins (#24)
}

export interface HookPayload {
  /* como hoje */
  session_id?: string; // Claude Code sends it on every hook; the reducer keeps it from SessionStart
}
```

## `src/orchestrator.ts`

- `export const SESSION_ID = /^[A-Za-z0-9_-]{8,64}$/;` e `export function isSessionId(value: unknown): value is string`.
- Caso `SessionStart` de `applyHook`: além de `worktree`, `branch` e `transcriptPath`, `sessionId: slot.sessionId ?? (isSessionId(p.session_id) ? p.session_id : undefined)`.

## `src/log.ts`

- `describeChanges(prev, next)`: pra cada slot de `next` cujo `sessionId` está definido e o slot de mesmo id em `prev` não tinha, uma linha `slot ${i + 1}: session=${sessionId}${slotDetail(slot)}`. As linhas de status continuam vindo primeiro, na ordem do grid; depois as de sessão; depois o sinal.

## `src/server.ts`

Nada muda: o payload já passa inteiro pro reducer e `dispatch` já loga o que `describeChanges` devolve.

## UI

- `src/ui/app.ts`, painel de detalhe: depois da linha `branch`, `slot.sessionId ? `<div class="meta">sessão: <code>claude --resume ${esc(slot.sessionId)}</code></div>` : ''`.
- `index.html`: sem mudança (`code` já tem estilo do realce).

## Testes

- `test/orchestrator.test.ts`: `SessionStart` com `session_id` válido grava `sessionId`; um segundo `SessionStart` com outro id não sobrescreve; `session_id` fora do formato (vazio, com espaço, > 64) ou ausente deixa `sessionId` indefinido e ainda grava `worktree`/`branch`.
- `test/log.test.ts`: `describeChanges` emite a linha de sessão quando o id aparece, uma vez só (o mesmo id nos dois estados não gera linha), depois das linhas de status.
- `test/server.test.ts`: `POST /hooks/event` `SessionStart` com `session_id` deixa o slot com `sessionId` e o `hive.log` com a linha `session=`.

## Critério de pronto

1. `pnpm start`, worker rodando: o painel do slot mostra `sessão: claude --resume <uuid>`; rodar o comando dentro do worktree reabre a sessão.
2. `.hive/hive.log` tem `slot N: session=<uuid> #<task> worker=<id>` logo após o spawn.
3. `pnpm test` verde.

## Fora

Comentário na issue ou no PR; link web; distinguir sessão principal de teammate/subagente (#24); retomar sessão pelo Hive no boot ou por botão (#26); botão de copiar.
