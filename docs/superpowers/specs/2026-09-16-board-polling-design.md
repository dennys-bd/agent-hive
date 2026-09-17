# Agent Hive — poll do board sob orçamento da API do GitHub

Extensão dos boards plugáveis (`docs/superpowers/specs/2026-09-16-pluggable-boards-design.md`) e do sinal (`docs/superpowers/specs/2026-09-16-signal-design.md`); a v1 (`docs/superpowers/specs/2026-09-15-agent-hive-design.md`) é autoritativa pra tudo que não está aqui. Card: [issue #25](https://github.com/dennys-bd/agent-hive/issues/25) — "Reduce GitHub API usage: board polling exhausts the GraphQL rate limit".

## Problema

O `poll()` do servidor roda a cada 30 s e faz duas chamadas GraphQL por rodada (`gh project item-list` + a query de `blockedBy` / `subIssues`), mesmo com todos os slots ocupados, sinal amarelo/vermelho ou orçamento de tokens estourado — situações em que nenhuma task poderia ser iniciada. São 240+ requisições por hora só do Hive; somadas aos `gh` dos workers (mesmo usuário, mesma cota de 5 000 pontos/h do GraphQL), a cota acaba e o dashboard mostra "API rate limit exceeded" sem hora de volta.

## Decisões fechadas

| Decisão | Escolha | Motivo |
|---|---|---|
| Quando o timer pode pular o board | Um poll do timer só chama o board quando algo poderia começar (`canSchedule`: mesmo gate do `fill` — sinal efetivo green, slot livre sem `draining`, cap dinâmico com folga, orçamento de tokens com saldo) **ou** quando a última leitura tem mais de 5 min (`IDLE_POLL_INTERVAL_MS`) | A fila só importa quando um slot pode consumi-la; o teto de 5 min mantém a fila da UI e o `releasePaused` do vermelho dinâmico com atraso limitado, e o `exit` continua preenchendo a partir de uma fila no máximo 5 min velha (era 30 s) |
| De onde vem a cota | `gh api rate_limit --jq .resources.graphql` → `{ limit, remaining, reset }`; esse endpoint **não consome cota** (documentado) | Única fonte com `reset`; a mensagem de erro do `gh` não traz hora de volta |
| Quando a cota é lida | Depois de **todo** poll real (sucesso ou falha), nunca num poll pulado | Uma leitura por chamada ao board; a falha por limite é justamente quando a hora do reset importa |
| Recuo (backoff) | Poll do timer é pulado enquanto `boardQuota.remaining < QUOTA_RESERVE` (500 pontos) e `now < boardQuota.resetsAt` | Deixa 10 % da cota pros `gh` dos workers (`gh pr create` etc.); passado o reset, a regra libera sozinha — sem timer extra, sem estado de backoff separado |
| Polls forçados | `POST /board/refresh`, `configure`, `reconfigure` e o boot chamam `poll()` sempre; só o timer passa por `shouldPoll` | Quem pediu à mão quer a resposta (ou o erro) agora |
| Regra pura | `src/polling.ts` (novo): `shouldPoll(state, now)`; `orchestrator.ts` exporta `canSchedule(state, now)` (extraído do gate do `fill`) | Testável sem servidor; um lugar só decide, e o PR-watching do auto-close (issue irmã) passa pelo mesmo gate depois |
| Tipo | `BoardQuota { limit: number; remaining: number; resetsAt: string; at: string }`, `State.boardQuota?: BoardQuota` | `at` = quando foi lida (é a última leitura, não valor vivo), como `RateLimits.at`; ISO como os outros instantes |
| Interface `Board` | `quota?(): Promise<BoardQuota \| undefined>` opcional; só o adapter GitHub implementa; markdown não tem | Board de arquivo não tem cota; o servidor chama `board.quota?.()` |
| Evento | `{ type: 'boardQuota'; quota: BoardQuota }` → `{ ...state, boardQuota: quota }`; sem efeitos, sem `fill` | Só exibição e a regra de recuo; a cota nunca abre nem fecha job por si |
| Falha ao ler a cota | `console.error`, nada é despachado; `state.error` fica com o erro do `listQueue` (se houve) | A leitura da cota é diagnóstico; não pode mascarar o erro do board nem derrubar o poll |
| Persistência | `boardQuota` vai pro `state.json`; `normalize` mantém se a forma bate (`isBoardQuota`), senão apaga | Reabrir o Hive em pleno recuo continua recuando até o reset, em vez de bater no limite de novo |
| UI | `#quota` no header, depois de `#limits`: `GitHub 4.320/5.000 · reseta HH:MM`; classe `low` (cor de perigo) quando `remaining < QUOTA_RESERVE`. Vazio sem dado ou sem cota no board | Diagnóstico pedido na issue; mesmo lugar dos outros medidores |
| Intervalo do timer | Continua 30 s; a decisão de chamar o board é por tick | Sem segundo timer; `shouldPoll` decide tudo |
| Fora | Cache do `item-list`, paginação, reduzir `ITEM_LIMIT`, ler `X-RateLimit-*` das respostas, PR-watching | Depois, se fizer falta; o PR-watching é outra issue e entra pelo mesmo `shouldPoll` |

## Tipos (`src/types.ts`)

```ts
/** GraphQL quota of the account the Hive polls with, as last read after a poll; `at` is when it was read. */
export interface BoardQuota {
  limit: number;
  remaining: number;
  resetsAt: string; // ISO
  at: string; // ISO
}

interface State { /* … */ boardQuota?: BoardQuota }

type HiveEvent = /* … */ | { type: 'boardQuota'; quota: BoardQuota };

interface Board { /* … */ quota?(): Promise<BoardQuota | undefined> }
```

## `src/polling.ts` (novo, puro)

```ts
export const POLL_INTERVAL_MS = 30_000;
export const IDLE_POLL_INTERVAL_MS = 5 * 60_000;
export const QUOTA_RESERVE = 500; // ponytail: fixed 10 % of the 5 000/h GraphQL quota, config it if a board ever needs another

/** Whether a timer tick should hit the board: never inside a quota backoff; otherwise when a job could start or the last read is stale. */
export function shouldPoll(state: State, now: number): boolean
```

- `inBackoff(state, now)`: `boardQuota` presente, `remaining < QUOTA_RESERVE` e `Date.parse(resetsAt) > now`.
- `stale(state, now)`: `lastPolledAt` ausente ou `now - Date.parse(lastPolledAt) >= IDLE_POLL_INTERVAL_MS`.
- `shouldPoll = !inBackoff && (canSchedule(state, now) || stale)`.
- `isBoardQuota(value)`: forma persistida (`limit`, `remaining` finitos ≥ 0; `resetsAt`, `at` strings), pro `state-store`.
- `POLL_INTERVAL_MS` sai de `server.ts` pra cá (mesmo valor).

## `src/orchestrator.ts`

- `export function canSchedule(state, now): boolean` = `hasBudget(state.usage, state.budget, now) && canStart(limits(state, now).signal, state.slots, limits(...).maxWorkers)`. O `fill` usa a mesma composição no início; o laço continua re-checando `canStart` por spawn.
- `case 'boardQuota': return none({ ...state, boardQuota: event.quota })`.

## `src/boards/github.ts`

- `quota()`: `exec(['api', 'rate_limit', '--jq', '.resources.graphql'])` → `{ limit, remaining, reset }` (números; `reset` em epoch segundos) → `BoardQuota` com `resetsAt` ISO e `at = now`. Forma inesperada → `undefined` (o servidor não despacha).

## `src/server.ts`

- `poll()` fica como está (sempre chama o board) e ganha, ao final, `await refreshQuota()`: `board.quota?.()` → `dispatch({ type: 'boardQuota', quota })` quando vier algo; erro → `console.error('board.quota: …')`.
- O timer chama `tick()`: `if (live && shouldPoll(live.state, Date.now())) await poll()`.

## `src/state-store.ts`

- `normalize` mantém `boardQuota` só quando `isBoardQuota`.

## UI

- `index.html`: `<span id="quota" class="dash"></span>` depois de `#limits`; estilo `#quota { color: var(--muted) } #quota.low { color: var(--danger) }`.
- `app.ts`: `renderQuota(quota?: BoardQuota)` — `GitHub ${remaining.toLocaleString('pt-BR')}/${limit.toLocaleString('pt-BR')} · reseta ${clock(resetsAt)}` (`fmt` abrevia em k/M; aqui o número inteiro é o que se compara com a cota); `QUOTA_RESERVE` espelhado com o comentário "Mirrors src/polling.ts".

## Testes

- `test/polling.test.ts` (novo): `shouldPoll` — slot livre + green → true; tudo ocupado e leitura recente → false; tudo ocupado e leitura de 5 min → true; sinal red e leitura recente → false; sem `lastPolledAt` → true; em recuo (remaining 499, reset no futuro) → false mesmo com slot livre; recuo vencido (reset no passado) → true; `isBoardQuota` aceita a forma e rejeita `remaining` negativo / `resetsAt` faltando.
- `test/orchestrator.test.ts`: `canSchedule` espelha o `fill` (green + slot livre → true; yellow → false; sem orçamento → false); `boardQuota` grava sem efeitos e sem mexer em slots / fila.
- `test/board.test.ts`: `quota()` monta o argv `api rate_limit --jq .resources.graphql` e converte `reset` pra ISO; forma inesperada → `undefined`; markdown não tem `quota`.
- `test/state-store.test.ts`: `boardQuota` válido mantido; inválido apagado.
- `test/server.test.ts`: depois de `POST /board/refresh`, `state.boardQuota` reflete o `quota()` do fake; um board sem `quota` não grava nada.
- Manual (`pnpm start`): header mostra `GitHub N/5.000 · reseta HH:MM`; com todos os slots ocupados, `board: HH:MM` só avança a cada 5 min; o botão "atualizar board" avança na hora.
