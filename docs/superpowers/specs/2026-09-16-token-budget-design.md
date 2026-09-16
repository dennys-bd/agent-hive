# Agent Hive — orçamento de tokens

Extensão da v1 (`docs/superpowers/specs/2026-09-15-agent-hive-design.md`, autoritativa pra tudo que não está aqui) e do sinal (`docs/superpowers/specs/2026-09-16-signal-design.md`). Objetivo: o orquestrador passa a saber quanto cada worker gastou e a respeitar um orçamento. Cada turno de worker (`Stop`) entrega o `transcript_path`; o Hive soma os tokens do transcript, guarda a diferença desde o turno anterior como uma amostra em `State.usage`, e o `fill` só abre job novo se tem slot **e** tem orçamento (`maxTokensPerHour` / `maxTokensPerDay` na config). A UI mostra um medidor. É a base do sinal dinâmico (roadmap 6).

## Decisões fechadas

| Decisão | Escolha | Motivo |
|---|---|---|
| Fonte do uso | O `transcript_path` que o Claude Code manda no corpo de todo hook; o servidor lê o arquivo no `Stop` e no `SessionEnd`. Sem `ccusage` | `ccusage` seria dependência nova e mais um processo externo; o transcript já está no payload e é a mesma fonte que o `ccusage` usa |
| O que conta como token | Pra cada linha `type: "assistant"` do transcript, `message.usage.input_tokens + output_tokens + cache_creation_input_tokens + cache_read_input_tokens`, deduplicando por `message.id` | O transcript repete o mesmo `usage` numa linha por bloco de conteúdo da mesma resposta; sem dedupe conta em dobro. A soma dos quatro campos é o "Total Tokens" do `ccusage`, então o número que o usuário vê aqui bate com o que já conhece |
| Unidade de medida | Um turno: `Slot.tokens` guarda o total do transcript no último `Stop`; a amostra nova em `usage` é `total − Slot.tokens` (ou `total` se ficou menor, transcript trocado) | Só o `Stop` e o `SessionEnd` trazem o transcript num ponto estável; o delta por turno é o que o item 6 precisa somar por janela |
| Formato de `usage` | `State.usage: { at: string; tokens: number }[]`, uma amostra por turno, podadas ao inserir tudo com mais de 24 h | É o menor dado que responde "quanto na última hora / no último dia"; sem breakdown por tipo de token (fora) |
| Onde o orçamento vive | `Config.budget: { maxTokensPerHour?: number; maxTokensPerDay?: number }` (arquivo e formulário), copiado pra `State.budget` por um evento `setBudget` no `configure` / `reconfigure`, como `maxConcurrent` já faz com `setMax` | O reducer só enxerga `State`; copiar segue o padrão existente e deixa o `fill` puro. Ausente ou `0` = sem limite |
| Regra pura | `hasBudget(usage, budget, now): boolean` em `src/usage.ts` = soma da última hora `<` `maxTokensPerHour` **e** soma do último dia `<` `maxTokensPerDay` (limite ausente/0 não restringe). `fill` exige `canStart(signal, slots) && hasBudget(usage, budget, Date.now())` | `canStart` continua sendo a regra do sinal; o orçamento é uma segunda porta com nome próprio, que o item 6 vai reusar sem mexer no sinal |
| Quando o orçamento reabre | Nenhum evento próprio: o `poll` (30 s) já chama `fill`, e as amostras saem da janela com o tempo | Zero código novo pra "liberar"; latência de até 30 s é irrelevante |
| Worker morto no meio do turno | Os tokens desde o último `Stop` não entram | O único ponto de leitura estável é o fim do turno; `SessionEnd` também lê pra pegar o último turno quando a sessão fecha normalmente |
| Segurança do `transcript_path` | Só lê se: o `x-hive-worker` bate com um slot ocupado, o caminho é absoluto e termina em `.jsonl`. Conteúdo nunca sai do processo (só o número); erro de leitura → hook segue sem `tokens` | Qualquer processo local pode bater no `/hooks/event`; as três checagens limitam o que dá pra fazer o Hive abrir, e o pior caso é ler um `.jsonl` e descartar |
| Tamanho do transcript | Lê linha a linha com `node:readline` sobre `createReadStream`, o arquivo inteiro a cada `Stop` | Memória limitada; um transcript de dezenas de MB por turno ainda é barato. Ceiling anotado no código: ler só a partir do offset anterior se um dia pesar |
| UI: medidor | No header, `<span id="usage">` com `tokens: 12k/h · 240k/dia`; pra cada limite configurado, um `<meter>` nativo (`min=0 max=limite value=uso`). Estourou → texto `sem orçamento` em `--danger`. Card ocupado mostra ` · 34k tokens` no meta | `<meter>` é nativo, sem CSS novo; o número no card é o que permite "medir por alguns dias" por worker |
| UI: formulário | Dois campos numéricos depois de `máx. workers`: `tokens por hora` e `tokens por dia`, vazio = sem limite. `SetupBody.budget` sempre vai; vazio no campo → chave ausente | Orçamento é config, e o formulário é a única edição de config pela UI |
| Formato dos números | `k` com uma casa até `999.9k`, `M` com uma casa acima; inteiro abaixo de 1000 (`842`, `12.3k`, `1.2M`) | Cabe no header e no meta do card |
| Estado antigo | `loadState` normaliza: `usage` ausente ou inválido → `[]` (amostras sem `at` string ou `tokens` número finito são descartadas); `budget` ausente → `{}` | `state.json` gravado antes deste item carrega sem erro |
| Fora | Sinal dinâmico e `maxWorkers` derivados (roadmap 6); custo em dólar; breakdown por tipo de token; tokens de subagentes (ficam em transcripts separados); tokens de sessões que não são workers do Hive; persistir uso por task | Escopo do item 5 |

## Tipos

```ts
interface Budget {
  maxTokensPerHour?: number; // absent or 0 = no limit
  maxTokensPerDay?: number;
}

interface UsageSample {
  at: string; // ISO, when the Stop arrived
  tokens: number; // delta since the worker's previous Stop
}

interface Slot {
  // …campos anteriores…
  tokens?: number; // session total at the last Stop / SessionEnd; the next delta is measured against it
}

interface State {
  // …campos anteriores…
  usage: UsageSample[]; // last 24 h, oldest first
  budget: Budget; // copied from the config by setBudget
}

interface Config {
  // …campos anteriores…
  budget: Budget;
}

interface HookPayload {
  // …campos anteriores…
  transcript_path?: string;
}

interface SetupBody {
  // …campos anteriores…
  budget?: Budget;
}

type HiveEvent =
  | /* eventos anteriores, com */ { type: 'hook'; workerId: string; payload: HookPayload; branch?: string; tokens?: number }
  | { type: 'setBudget'; budget: Budget };
```

`initialState(max)` começa com `usage: []` e `budget: {}`.

## `src/usage.ts` (novo)

```ts
export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
export function parseUsageLine(line: string): { id: string; tokens: number } | undefined; // pure: one transcript line → its usage, or nothing
export function sumTranscriptTokens(path: string): Promise<number>; // readline over the file, dedupe by message.id
export function usageTotals(usage: UsageSample[], now: number): { hour: number; day: number };
export function hasBudget(usage: UsageSample[], budget: Budget, now: number): boolean;
export function pruneUsage(usage: UsageSample[], now: number): UsageSample[]; // drops samples older than DAY_MS
export function isTranscriptPath(value: unknown): value is string; // absolute string ending in `.jsonl`
```

- `parseUsageLine`: `JSON.parse` com try/catch (linha inválida → `undefined`); exige `type === 'assistant'`, `message.id` string e `message.usage` objeto; campos ausentes contam `0`.
- `sumTranscriptTokens`: `Set` de ids vistos; soma só na primeira ocorrência de cada id. Arquivo inexistente ou ilegível → rejeita (o servidor trata).
- `hasBudget`: `limit` ausente ou `<= 0` não restringe; senão `total < limit`.

## Orquestrador (`orchestrator.ts`)

- `fill`: `if (!canStart(state.signal, state.slots) || !hasBudget(state.usage, state.budget, Date.now())) return reduced;`.
- `setBudget`: `{ ...state, budget }` → `fill` (subir o limite pode abrir job na hora).
- `applyHook` com `event.tokens !== undefined` (só o servidor põe, em `Stop` / `SessionEnd`): antes do `switch`, `recordUsage(state, slot, tokens)` produz `Slot.tokens = tokens`, `usage = pruneUsage([...usage, { at: now, tokens: delta }], now)`; delta `= tokens >= (slot.tokens ?? 0) ? tokens − (slot.tokens ?? 0) : tokens`. Delta `0` não gera amostra. O `switch` segue sobre o estado já atualizado.
- Demais eventos: sem mudança própria; herdam o `fill` condicionado.

## Servidor (`server.ts`)

- `POST /hooks/event`: se `hook_event_name` é `Stop` ou `SessionEnd`, `isTranscriptPath(payload.transcript_path)` e o `workerId` bate com um slot com `status !== 'vazio'`, então `tokens = await sumTranscriptTokens(path).catch(() => undefined)` e vai no evento `hook`. Qualquer outra situação: evento sem `tokens`, como hoje.
- `configure`: depois do `setMax` condicional, `if (!isDeepStrictEqual(saved.budget, config.budget)) dispatch({ type: 'setBudget', budget: config.budget })`. `reconfigure`: idem contra `live.state.budget`.
- `saveSetup`: `budget: body.budget ?? current?.budget` entra no `parseConfig`.

## Config (`config.ts`)

`budget` opcional; objeto com `maxTokensPerHour` / `maxTokensPerDay` inteiros não negativos (via `requireInt`, mensagens `"budget.maxTokensPerHour" must be a non-negative integer`); `DEFAULT_CONFIG.budget = {}`; `"budget" must be an object` se não for objeto. Chaves ausentes ficam ausentes (não viram `0`), pra `hive.config.json` continuar limpo.

## Estado persistido (`state-store.ts`)

`loadState` normaliza `usage` e `budget` como na tabela. `saveState` grava os dois como parte do `State`.

## UI (`ui/index.html` + `ui/app.ts`)

- Header, depois do `#signal`: `<span id="usage" class="dash">` preenchido por `renderUsage(state)`: texto `tokens: <hora>/h · <dia>/dia`; um `<meter>` por limite configurado; classe `over` (cor `--danger`) e sufixo ` · sem orçamento` quando `hasBudget` é falso (a UI reimplementa `usageTotals`/`hasBudget` em poucas linhas: `app.ts` não importa módulos do servidor).
- `renderCard`: meta ganha ` · ${fmt(slot.tokens)} tokens` quando `slot.tokens` existe.
- Formulário: `<input id="budget-hour" type="number" min="0" step="1">` e `#budget-day`, labels `tokens por hora` / `tokens por dia`, hint `vazio = sem limite`. `openSetup` preenche com `config.budget`; `saveSetup` monta `budget` só com os campos preenchidos e `> 0`.

## Testes

- `test/usage.test.ts` (novo): `parseUsageLine` ignora linha inválida, linha `user`, linha sem `usage`; soma os quatro campos com ausentes = 0. `sumTranscriptTokens` num `.jsonl` temporário com duas linhas do mesmo `message.id` conta uma vez e soma ids distintos; arquivo inexistente rejeita. `usageTotals` separa hora e dia; `hasBudget` sem limites → `true`; limite por hora estourado → `false`; limite por dia estourado com hora ok → `false`; `0` = sem limite; `pruneUsage` descarta > 24 h e mantém o resto. `isTranscriptPath` aceita `/x/y.jsonl`, rejeita relativo, `.json`, não-string.
- `test/orchestrator.test.ts`: `initialState` tem `usage: []` e `budget: {}`; `hook` `Stop` com `tokens` grava `Slot.tokens` e uma amostra com o delta; segundo `Stop` grava só o delta; total menor que o anterior grava o total; `tokens` igual não gera amostra; `Stop` sem `tokens` não muda `usage`; `poll` com fila e slot vazio sob orçamento estourado não emite `spawn`; `setBudget` que sobe o limite dispara `fill`; reducer não muta a entrada (estender o teste existente pra `usage`).
- `test/config.test.ts`: `budget` ausente → `{}`; `budget.maxTokensPerHour` não inteiro → erro nomeando o campo; `budget` não objeto → erro.
- `test/state-store.test.ts`: `state.json` sem `usage`/`budget` carrega `[]`/`{}`; amostra inválida é descartada, válida preservada.
- `test/setup.test.ts`: `POST /setup` com `budget` grava no `hive.config.json` e o `State` do SSE traz `budget`; `POST /hooks/event` `Stop` com `transcript_path` de um `.jsonl` temporário pra um worker ocupado atualiza `usage` (com `maxConcurrent: 0` não há slot ocupado: o teste usa `dispatch` direto ou cobre só o caminho "não lê"; a leitura em si está coberta em `usage.test.ts`).

## Critério de pronto

1. Com um worker vivo, ao fim de cada turno o card mostra ` · Nk tokens` crescendo e o header mostra `tokens: …/h · …/dia` subindo.
2. `budget.maxTokensPerHour` menor que o uso da última hora: com slot vazio e fila cheia, nenhum job abre; header mostra o `<meter>` cheio e ` · sem orçamento`. Passada a hora (ou subindo o limite no formulário), o `poll` seguinte abre job.
3. Fechar e reabrir o Hive preserva `usage` e o card continua com os tokens.
4. `pnpm test` verde com os testes acima.

## Fora

Sinal dinâmico e `maxWorkers` por uso (roadmap 6); custo em dólar; breakdown por tipo de token; transcripts de subagentes; uso por task; leitura incremental por offset.
