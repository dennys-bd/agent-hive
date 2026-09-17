# Agent Hive — iniciar uma task da fila à mão, independente do sinal

Extensão do sinal (`docs/superpowers/specs/2026-09-16-signal-design.md`) e do sinal dinâmico (`docs/superpowers/specs/2026-09-16-usage-rules-design.md`); a v1 (`docs/superpowers/specs/2026-09-15-agent-hive-design.md`) é autoritativa pra tudo que não está aqui. Card: [issue #47](https://github.com/dennys-bd/agent-hive/issues/47) — "Start a queued task by hand from the queue panel, regardless of the signal". Objetivo: cada task livre no painel da fila ganha um botão `iniciar` que abre um worker pra ela na hora, mesmo em amarelo ou vermelho; sem slot livre, um popup oferece subir `máx. workers` em um e iniciar.

## O problema

Hoje a única entrada num slot é a porta automática do `fill`: sinal verde, slot livre, teto e orçamento com folga. Com o Hive abrindo em amarelo (#32), escolher *qual* task roda exige abrir o sinal pra fila inteira. O botão é a escolha pontual: "essa, agora".

## Decisões fechadas

| Decisão | Escolha | Motivo |
|---|---|---|
| O que o início manual ignora | Sinal (manual e dinâmico), teto dinâmico das `usageRules` e orçamento (`hasBudget`). Restam duas portas: task sem bloqueio e slot livre | Tudo isso é automação; o botão é o humano passando por cima dela. Resposta do usuário na spec: "everything" |
| Slot livre | `status === 'vazio'` e sem `draining` — o mesmo critério do `fill` | Um slot drenando vai sumir no próximo `exit`; abrir job nele repetiria o bug que o `draining` evita |
| Task bloqueada | Não mostra o botão; a rota recusa com `409` se chamada mesmo assim | Regra única de bloqueio é `isBlocked` (blockers-design); o adapter já filtrou pra bloqueios ainda abertos |
| Sem slot livre | `confirm()` nativo (chave i18n `confirm.raiseMax`): `Nenhum slot livre. Subir máx. workers de N pra N+1 e iniciar #id?`. Sim → a mesma rota com `raiseMax: true` | É o que `kill` já usa; sem modal novo. Uma única requisição evita a corrida entre subir o teto e iniciar |
| Novo teto | `ocupados + 1`, aplicado pelo reducer via `setMax` **só quando não há slot livre** | No caso normal é `maxConcurrent + 1`, como a issue pede. Com slots drenando (teto abaixo dos ocupados), `+1` sobre o teto não abriria slot nenhum; `ocupados + 1` sempre abre exatamente um. `raiseMax` com slot livre é ignorado: o slot surgiu entre o render e o clique |
| Teto persiste | Nada a fazer: `maxConcurrent` já vive em `State` e vai pro `state.json` a cada dispatch (#35) | O `setMax` do popup é o mesmo do cabeçalho |
| Evento | `{ type: 'start'; itemId: string; raiseMax?: boolean }` | `itemId` é a chave do adapter, a mesma que `setStatus` e o `inSlot` do `poll` usam; `id` (número da issue) é só o que o usuário vê |
| Reducer | `start(state, itemId, raiseMax)`: task fora da fila ou bloqueada → estado inalterado; sem slot livre e sem `raiseMax` → inalterado; senão ocupa o primeiro slot livre exatamente como o `fill` (mesmo `Slot`, mesmos efeitos `setStatus working` + `spawn`) e **não** chama `fill` depois | Puro e idempotente como os outros; nada afrouxou, então não há o que o `fill` abrir. A colocação da task no slot sai do `fill` pra um helper compartilhado (`occupy`), pra não duplicar |
| `lastEvent` | `{ kind: 'manualStart' }` no lugar de `{ kind: 'starting' }`; texto via i18n (`iniciado à mão` / `started by hand`) | O card e o `hive.log` (via `describeChanges`) mostram que não foi a porta automática. Ajustado ao merge com #70 (UI configurável em pt/en) |
| Vermelho | Sem regra nova: um worker iniciado à mão sob vermelho recebe `paused` no primeiro `Stop` como qualquer outro | Vermelho é modo manual pra todo worker vivo; o botão escolhe o que entra, não muda o que o sinal significa |
| Board | `setStatus(itemId, 'working')` como no início automático | #42 (quem move o card) fica pra depois; hoje a transição é a mesma |
| Rota | `POST /queue/:itemId/start` com corpo `{ "raiseMax"?: true }` → `{ ok: true }`. `409` sem config; `404` `task não está na fila`; `409` `task bloqueada por …`; `409` `nenhum slot livre` sem `raiseMax` | Mesmo padrão de `POST /slots/:id/kill`; os erros respondem o que o reducer ignoraria em silêncio, pra UI não ficar sem resposta |
| UI | No `renderQueued`, cada `<li>` sem bloqueio ganha `<button data-start="<itemId>">iniciar</button>`; clique delegado em `#queue`; `raiseMax` só depois do `confirm`. `itemId` vai escapado no atributo e com `encodeURIComponent` na URL | Cópia em português; sem painel novo. #46 (mostrar só 5) não muda nada aqui: o botão vai em cada item renderizado |
| Log | `describeEvent`: `start #<itemId> raiseMax=<bool>` (debug); a transição do slot já sai no info por `describeChanges` | Mesmo padrão dos outros eventos |
| CSRF | Todo `POST` fora de `/hooks/` exige o header `x-hive-ui` (o `postJson` da UI sempre manda); sem ele, `403 origem não permitida`. Rotas de hook seguem sem exigir (sem `x-hive-worker` já são no-op) | Achado da revisão de segurança: a checagem de `Host` não barra um `<form>` de outro site apontado pra porta local, e essa rota abre um worker sem precisar de corpo. Um form não põe header custom; um `fetch` cross-origin com header cai no preflight que o servidor não responde. Cobre também `kill` e `board/refresh`, que tinham a mesma forma |
| Fora | Iniciar direto num slot específico; escolher a task pelo card vazio; desfazer o `+1` quando o worker sai; iniciar task bloqueada "mesmo assim" | Não pedido; o teto volta pelo cabeçalho como sempre |

## Tipos (`src/types.ts`)

```ts
type HiveEvent =
  | /* eventos atuais */
  | { type: 'start'; itemId: string; raiseMax?: boolean };
```

Nada mais muda: `Task`, `Slot`, `State`, `Config` e `Effect` ficam como estão.

## Orquestrador (`src/orchestrator.ts`)

```ts
/** A free slot for the gate and for a manual start: empty and not draining. */
export function isFree(slot: Slot): boolean;

// Takes `task` out of the queue into `slots[index]` and emits the board move plus the spawn; fill and start share it.
function occupy(state: State, index: number, task: Task, lastEvent: string): Reduced;

// The human override: no signal, cap or budget check. Unknown or blocked task, or no free slot without raiseMax: unchanged.
function start(state: State, itemId: string, raiseMax: boolean): Reduced;
```

- `reduce` ganha `case 'start': return start(state, event.itemId, event.raiseMax === true);` — sem `fill`.
- `start`:
  1. `task = state.queue.find((t) => t.itemId === itemId)`; ausente ou `isBlocked(task)` → `none(state)`.
  2. `index = state.slots.findIndex(isFree)`; `index < 0 && !raiseMax` → `none(state)`.
  3. `index < 0 && raiseMax` → `base = setMax(state, ocupados + 1).state` e recalcula `index` (agora existe: `setMax` cria pelo menos um slot vazio quando `max > ocupados`).
  4. `occupy(base, index, task, 'iniciado à mão')`.
- `fill` passa a usar `occupy(…, 'iniciando')` no laço; comportamento idêntico ao de hoje (mesmo `Slot`, mesma ordem de efeitos).
- `canStart` / `canSchedule` / `limits` não mudam: o início manual não passa por eles.

## Servidor (`src/server.ts`)

```ts
app.post('/queue/:itemId/start', async (req, res) => { /* tabela acima */ });
```

Lê `live.state` antes do dispatch pra responder `404` / `409`; o reducer continua guardando os mesmos casos (uma corrida entre a checagem e o dispatch vira no-op, nunca um spawn indevido). `raiseMax` é `true` só quando o corpo traz exatamente `true`.

## UI (`src/ui/app.ts`)

- `renderQueued(task)`: sem bloqueio → `<li>#id título <button data-start="…">iniciar</button></li>`; com bloqueio → como hoje.
- Listener em `#queue`: `data-start` → procura a task em `state.queue`; se `state.slots.some(isFree)` (a mesma regra, replicada no browser como as outras constantes espelhadas) faz `post('/queue/<itemId>/start')`; senão `confirm(...)` e `post(..., { raiseMax: true })`. Erro da rota → barra de erro, como todo `post`.

## Log (`src/log.ts`)

`describeEvent` ganha `case 'start'`.

## Testes

- `test/orchestrator.test.ts`:
  - `start` sob amarelo e sob vermelho abre a task no primeiro slot livre com `setStatus working` + `spawn`, `lastEvent = 'iniciado à mão'`, e a tira da fila;
  - `start` com teto dinâmico atingido e com orçamento esgotado ainda abre;
  - task bloqueada, `itemId` desconhecido e sem slot livre sem `raiseMax` → estado igual, sem efeitos;
  - sem slot livre com `raiseMax` → `maxConcurrent` vira `ocupados + 1`, um slot novo, task nele;
  - com slot drenando e `raiseMax` → `maxConcurrent = ocupados + 1`, nenhum slot drenando, task no slot novo;
  - `raiseMax` com slot livre não muda `maxConcurrent`;
  - `start` não chama `fill`: sob verde com teto dinâmico atingido, só a task pedida abre;
  - `fill` continua idêntico (os testes atuais passam sem mudança);
  - imutabilidade (o teste `reducer never mutates its input` ganha o evento).
- `test/server.test.ts`: `POST /queue/:itemId/start` sob amarelo chega no pool com o slug da task; `404` fora da fila; `409` bloqueada; `409` sem slot livre; com `raiseMax: true` o `maxConcurrent` sobe, persiste no `state.json` e o worker abre.
- `test/log.test.ts`: `describeEvent` do `start`.

## Critério de pronto

1. Hive em amarelo com 2 slots vazios e fila com 3 tasks: `iniciar` numa delas abre só ela; as outras seguem na fila; o card mostra `iniciado à mão`.
2. Os 2 slots ocupados: `iniciar` pergunta `Subir máx. workers de 2 pra 3 e iniciar #n?`; sim → cabeçalho mostra `3/3`, worker abre, e `máx. workers` continua 3 depois de reiniciar o Hive.
3. Task com blockers abertos não tem o botão.
4. `pnpm test` verde com os testes acima.
