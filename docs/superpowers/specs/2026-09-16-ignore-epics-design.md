# Agent Hive — épicos fora da fila

Extensão dos blockers (`docs/superpowers/specs/2026-09-16-blockers-design.md`) sobre os boards plugáveis e a v1 (`docs/superpowers/specs/2026-09-15-agent-hive-design.md`). Issue: <https://github.com/dennys-bd/agent-hive/issues/31>.

Hoje um épico é indistinguível de um issue bloqueado: fica na fila como "bloqueada por #x, #y" e, quando as sub-issues fecham, um worker pega o épico em si. Por padrão o Hive passa a **não** enfileirar épicos: distribui só as sub-issues. Uma opção de config mantém o comportamento atual (o épico entra na fila quando as filhas fecham), pra épicos que carregam trabalho próprio. Só o delta está descrito aqui.

## Decisões fechadas

| Decisão | Escolha | Motivo |
|---|---|---|
| O que é um épico | Um issue do GitHub com **pelo menos uma sub-issue**, em qualquer estado (`subIssues.nodes` não vazio) | É a única relação que define "épico" sem convenção: nem label (`epic` é um combinado por repo) nem issue type (só existe em orgs). É o que o próprio GitHub mostra como épico na UI |
| Custo de API | Zero chamadas a mais: `subIssues { nodes { number state } }` já vem na query de blockers, por issue da fila | Pesa em #25 (rate limit do GraphQL); label ou issue type custariam campos ou chamadas extras |
| Config | `epics: 'ignore' \| 'queue'`, default `ignore` | `ignore` = épico nunca aparece na fila; `queue` = comportamento de hoje (fica bloqueado pelas sub-issues abertas e é pego quando todas fecham). Enum em vez de booleano porque `"ignoreEpics": false` lê mal no JSON |
| Onde filtrar | No adapter GitHub, em `listQueue()`, depois de resolver as relações; o épico nem chega ao orchestrator | O orchestrator não precisa de regra nova nem de `Task.epic`; a fila e a UI seguem intactas. O épico ignorado simplesmente não é uma task pro Hive |
| Board markdown | Sem noção de épico; a opção não se aplica (o adapter markdown ignora `epics`) | Uma linha da tabela não tem sub-issues; "linha da qual outras dependem" não é épico, é bloqueador. YAGNI |
| Quem move o épico pra Done | Ninguém no Hive. Em `ignore`, o épico fica na coluna onde está até alguém mover à mão (ou o GitHub fechar via PR / auto-close). Em `queue`, um worker pega o épico como qualquer task e o fluxo normal o leva a `In review` | O Hive só mexe no `Status` das tasks que distribui; fechar issues fica fora do contrato (auto-close-on-merge é outra issue) |
| Épico já num slot quando a config muda pra `ignore` | Continua rodando; só a fila do próximo poll muda | `poll` só troca a fila; nada é morto por config |
| Setup | `<select id="epics">` dentro de `#github-fields`, duas opções; `SetupBody.epics?` opcional, e quem chama a API sem mandar mantém o valor atual (como `workers`) | Mesmo padrão dos outros campos; o form GitHub é o único lugar onde faz sentido |
| `issue: null` na resposta / url fora do padrão | Não é épico (sem relações, sem sub-issues) | Mesma leitura de hoje pros blockers |
| Mais de 50 sub-issues | `nodes` vem não vazio de qualquer jeito; a detecção não depende da paginação | O `RELATION_LIMIT` de hoje já sub-reporta blockers, e isso não muda aqui |

## Config

```json
"epics": "ignore"
```

`parseConfig`: `epics` opcional, ∈ `EPICS_MODES = ['ignore', 'queue']`, default `'ignore'`; qualquer outro valor → `hive.config.json: "epics" must be one of: ignore, queue`. `DEFAULT_CONFIG.epics = 'ignore'`.

## Types

```ts
export type EpicsMode = 'ignore' | 'queue';

interface Config { /* … */ epics: EpicsMode; }
interface SetupBody { /* … */ epics?: EpicsMode; } // opcional; ausente mantém o atual (ou `ignore` no primeiro setup)
```

`Task`, `State`, `Slot`, `HiveEvent`, `Effect`, `Board` não mudam.

## Adapter GitHub (`src/boards/github.ts`)

- `createGithubBoard(board, statusNames, epics, exec)` — `epics: EpicsMode`; `src/board.ts` passa `config.epics`.
- `isEpic(issue)`: `(issue?.subIssues?.nodes.length ?? 0) > 0`.
- `withBlockers(tasks, epics, exec)`: depois de ler `data`, com `epics === 'ignore'` descarta as tasks cujo `data.i<k>.issue` é épico; as demais recebem `blockedBy` como hoje. Com `queue`, nada muda.
- A query e os outros métodos não mudam.

## Adapter markdown (`src/boards/markdown.ts`)

Sem mudança.

## Server (`src/server.ts`)

`saveSetup`: `epics: body.epics ?? current?.epics`. `sameBoard` passa a comparar `[board, status, epics]`: o modo é fixado no adapter na criação, então mudar `epics` no form precisa de uma instância nova (como mudar `status`); sem isso a troca só valeria após um restart.

## UI (`src/ui/index.html`, `src/ui/app.ts`)

Dentro de `#github-fields`, depois da coluna em review:

```html
<label>épicos (issues com sub-issues)
  <select id="epics">
    <option value="ignore">ignorar: só as sub-issues entram na fila</option>
    <option value="queue">enfileirar quando todas as sub-issues fecharem</option>
  </select>
</label>
```

`openSetup` preenche `$('epics').value = config?.epics ?? 'ignore'`; `saveSetup` manda `epics` no body sempre (o fieldset desabilitado no markdown não impede a leitura; o valor é inofensivo pra esse board).

## Tests

- `test/config.test.ts`: default `ignore`; aceita `queue`; rejeita outro valor com a mensagem.
- `test/board.test.ts` (GitHub, `fakeExec`): com `epics: 'ignore'` (default), um issue com sub-issue (aberta ou fechada) some da fila e os outros seguem com seus `blockedBy`; com `epics: 'queue'`, o épico fica na fila bloqueado pelas sub-issues abertas (comportamento de hoje); `issue: null` não é épico.
- `test/setup.test.ts`: `POST /setup` sem `epics` mantém o valor salvo; com `epics: 'queue'` grava.
- UI: manual (`pnpm start`, board GitHub, select no form), no test plan do PR.

## Definição de pronto

1. Num project GitHub com um épico em `Ready` cujas sub-issues também estão em `Ready`, o painel mostra só as sub-issues na fila; o épico não recebe worker nem quando todas fecham.
2. Com `"epics": "queue"` no `hive.config.json` (ou no form), o épico aparece na fila como `bloqueada por …` e é pego no poll seguinte ao fechamento da última sub-issue.
3. `pnpm test` verde com os testes acima.

## Fora do escopo

Detectar épico por label ou por issue type; fechar ou mover o épico quando as filhas fecham; épicos em boards markdown; mostrar os épicos ignorados no painel.
