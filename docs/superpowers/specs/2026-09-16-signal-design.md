# Agent Hive — sinal verde / amarelo / vermelho

Extensão da v1 (`docs/superpowers/specs/2026-09-15-agent-hive-design.md`, autoritativa pra tudo que não está aqui). Objetivo: um estado global `signal` que o orquestrador consulta antes de abrir job novo. **Verde** é o comportamento atual. **Amarelo** deixa os workers vivos terminarem, mas não abre job novo. **Vermelho** é modo manual: além de não abrir job, cada worker vivo fica marcado como pausado quando o turno atual termina, e só sai da marca quando o sinal deixa o vermelho ou alguém retoma o worker à mão no terminal. Nada é morto no meio de um turno. Ajustável por três botões na UI e por `POST /signal`. É a base do sinal dinâmico por uso de tokens (roadmap 6).

## Decisões fechadas

| Decisão | Escolha | Motivo |
|---|---|---|
| Onde o sinal vive | `State.signal`, gravado em `.hive/state.json` junto com o resto do estado; **não** vai pro `hive.config.json` nem pro formulário de setup | É um controle de runtime (muda a qualquer hora, sem reconfigurar); sobrevive a restart porque um vermelho posto à mão por orçamento não pode sumir quando o Hive reabre. `state.json` antigo sem `signal` lê como `green` |
| O que é "iteração" | Um turno do worker: de `UserPromptSubmit` até `Stop` | É a única unidade que os hooks entregam; é onde o item 5 vai medir tokens (`transcript_path` no `Stop`) |
| Regra pura | `canStart(signal, slots): boolean` = `signal === 'green'` **e** existe slot `vazio` não drenando; `fill` consulta ela antes de qualquer spawn | Nome e assinatura do roadmap; o item 6 acrescenta o orçamento na mesma porta |
| Amarelo | `fill` não abre job. Workers vivos seguem até o fim da sessão; `exit` sem PR devolve a task pra fila como hoje, o slot fica `vazio` e assim permanece | "Termina a iteração, não começa job novo" sem tocar em nenhum worker |
| Vermelho: pausa | No `Stop` de um slot ocupado enquanto o sinal está vermelho, o slot ganha `paused: true` e `lastEvent = 'pausado: sinal red'`; `status` não muda (continua `trabalhando` / `aguardando_review`, como o `Stop` já faz) | O Claude Code interativo já para sozinho no fim do turno; o Hive não tem como segurar nem retomar um worker sem digitar no terminal dele. A marca registra que aquele worker parou sob vermelho e o card mostra isso |
| Vermelho: retomar | `paused` some (a) quando o sinal sai do vermelho (`setSignal` limpa a marca de todos os slots) ou (b) quando o worker recebe `UserPromptSubmit` ou `PreToolUse` (alguém digitou no terminal) | Os dois caminhos do roadmap: "sair do vermelho" e "retomar à mão" |
| O Hive nunca digita no terminal | Sair do vermelho não envia texto pro iTerm; só limpa a marca e roda `fill` | Digitar "continue" num worker que parou pra perguntar algo é automação que o verde não tem; o sinal só pode reduzir automação, nunca criar |
| Worker já ocioso quando vira vermelho | Não recebe `paused` retroativamente; só o próximo `Stop` marca | O Hive não sabe com certeza se um worker está ocioso; o botão vermelho aceso no topo já diz ao humano que é modo manual |
| Nunca mata no meio | Sinal nenhum emite `kill`; `esperando_voce` sob vermelho continua sendo respondido no terminal normalmente | Regra do roadmap; responder uma permissão é terminar o turno, não começar outro |
| Transições | `setSignal` grava o sinal, limpa `paused` se o novo sinal não é vermelho, e chama `fill` (que só abre job se o sinal ficou verde) | Verde volta a puxar da fila na hora; amarelo→vermelho e vermelho→amarelo não abrem nada |
| `setMax`, `poll`, `exit`, `SessionEnd` | Continuam chamando `fill`; sob amarelo/vermelho `fill` devolve o estado sem efeitos de spawn. `setMax` ainda cria/drena slots | Slots refletem o teto configurado; só o disparo é que fica suspenso |
| API | `POST /signal { "signal": "green" \| "yellow" \| "red" }` → `{ ok: true }`; valor inválido → 400; sem config → 409. Sem `GET`: o `State` do SSE já carrega `signal` | Mesmo padrão de `POST /config` |
| UI | Três botões no topo (`green` / `yellow` / `red`), o ativo pintado com a cor; ao lado, `sem jobs novos` (amarelo) ou `modo manual` (vermelho). Card com `paused` mostra ` · pausado` no meta e fica esmaecido (classe `paused`) | Cópia em português; sem painel novo, sem modal |
| Fora | Sinal dinâmico por uso (roadmap 6); persistir o sinal na config; retomar worker automaticamente; contar `paused` no `N/M workers ativos` (ativos = ocupados, como hoje) | Escopo do item 4 |

## Tipos

```ts
type Signal = 'green' | 'yellow' | 'red';

interface Slot {
  // …campos da v1…
  paused?: boolean; // parou num Stop sob sinal vermelho; some ao sair do vermelho ou quando o worker volta a agir
}

interface State {
  signal: Signal;
  // …campos da v1…
}

type HiveEvent =
  | /* eventos da v1 */
  | { type: 'setSignal'; signal: Signal };
```

`initialState(max)` começa em `green`. `loadState` aceita `state.json` sem `signal` (arquivos gravados antes deste item) e preenche `green`; qualquer outro valor que não seja um dos três também vira `green`.

## Orquestrador (`orchestrator.ts`)

```ts
export const SIGNALS: readonly Signal[] = ['green', 'yellow', 'red'];
export function canStart(signal: Signal, slots: Slot[]): boolean;
```

- `canStart` é pura: verde **e** algum slot `status === 'vazio'` sem `draining`.
- `fill`: se `!canStart(state.signal, state.slots)` devolve `{ state, effects }` inalterados. Senão, comportamento de hoje.
- `setSignal`: `{ ...state, signal, slots: signal === 'red' ? state.slots : slots sem paused }` → `fill`.
- `Stop` (em `applyHook`): comportamento de hoje mais, se `state.signal === 'red'`, `paused: true` e `lastEvent: 'pausado: sinal red'` (no lugar de `'turno encerrado'`).
- `UserPromptSubmit` e `PreToolUse`: além do que já fazem, `paused: undefined`.
- `exit`, `SessionEnd`, `boot`, `kill`, `spawned`, `error`, `poll`, `setMax`: sem mudança própria; só herdam o `fill` condicionado.

## Servidor (`server.ts`)

| rota | função |
|---|---|
| `POST /signal` | corpo `{ signal }`; `SIGNALS.includes(signal)` senão 400 `signal must be one of: green, yellow, red`; `requireLive` (409); `dispatch({ type: 'setSignal', signal })`; `{ ok: true }` |

Sem mudança em hooks, spawn, board ou config.

## Estado persistido (`state-store.ts`)

`loadState` normaliza `signal`: ausente ou fora de `SIGNALS` → `green`. `saveState` grava o campo como parte do `State`.

## UI (`ui/index.html` + `ui/app.ts`)

- Topo, depois de `máx. workers`: `<span id="signal">` com três `<button data-signal="green|yellow|red">green|yellow|red</button>` e um `<span id="signal-hint">`. Clique → `POST /signal`. `render()` põe a classe `active` no botão do sinal atual e escreve o hint (`''` / `sem jobs novos` / `modo manual`).
- CSS: `button.active[data-signal=green]` borda/texto `--trabalhando`; `yellow` → `--esperando`; `red` → `--danger`. `.card.paused { opacity: 0.6 }`.
- `renderCard`: meta ganha ` · pausado` quando `slot.paused`; classe `paused` no card.
- Nenhuma mudança no formulário de setup.

## Testes

- `test/orchestrator.test.ts`:
  - `canStart` verde com slot livre → `true`; verde sem slot livre (todos ocupados ou drenando) → `false`; amarelo/vermelho com slot livre → `false`.
  - `poll` sob amarelo enfileira tudo e não emite `spawn`; `setMax` pra cima sob vermelho cria slots vazios sem spawn; `exit` sob amarelo devolve a task pra fila (`setStatus queue`) sem repuxar.
  - `setSignal` verde com fila e slot vazio dispara `fill` (spawn); `setSignal` amarelo→vermelho não emite nada.
  - `Stop` sob vermelho marca `paused` e `lastEvent = 'pausado: sinal red'`, status preservado (`trabalhando` e `aguardando_review`); `Stop` sob verde não marca.
  - `UserPromptSubmit` e `PreToolUse` limpam `paused`; `setSignal` pra verde ou amarelo limpa `paused` de todos os slots; `setSignal` vermelho de novo mantém.
  - `initialState` começa em `green`; reducer continua não mutando a entrada.
- `test/state-store.test.ts`: `state.json` sem `signal` carrega como `green`; com `signal: "red"` preserva; com valor inválido volta a `green`.
- `test/setup.test.ts` (servidor real, `maxConcurrent: 0`): `POST /signal` antes do setup → 409; inválido → 400 nomeando os valores; válido → 200 e o `GET /events` seguinte traz `signal` no `State`.

## Critério de pronto

1. Com `máx. workers = 2` e 3 tasks em `Ready`: botão amarelo → nenhum worker novo abre quando um dos dois vivos sai; a task volta pra `Ready` e a fila mostra 2. Botão verde → o slot vazio puxa a próxima na hora.
2. Botão vermelho com um worker vivo: quando o turno dele termina, o card mostra ` · pausado` e esmaecido; digitar no terminal do worker tira a marca; voltar pra verde tira a marca de todos e volta a puxar da fila.
3. Fechar e reabrir o Hive em vermelho reabre em vermelho.
4. `pnpm test` verde com os testes acima.

## Fora

Sinal dinâmico por uso de tokens (roadmap 6), orçamento (roadmap 5), retomar workers automaticamente, sinal na config ou no setup, botão de "iniciar task" manual sob vermelho.
