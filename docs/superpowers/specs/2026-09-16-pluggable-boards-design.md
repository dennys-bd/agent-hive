# Agent Hive — boards plugáveis (GitHub + Markdown)

Extensão da v1 e do setup pela interface. Objetivo: o board de onde as tasks vêm passa a ser um adapter escolhido por config. Dois adapters nesta entrega: `github` (o que existe hoje) e `markdown` (uma tabela num arquivo `.md` do repo, gerida pelo Hive, com o resto do arquivo livre pra descrições que o command do agente procura). Asana e outros entram depois como um terceiro arquivo.

## Decisões fechadas

| Decisão | Escolha | Motivo |
|---|---|---|
| Estrutura | `src/boards/github.ts`, `src/boards/markdown.ts`; `src/board.ts` vira só a factory por `config.board.type` | Um adapter por arquivo; teste de um não passa pelo código do outro |
| Config | `project` vira `board: { type, … }`; `project` legado ainda aceito como `github` | Compatibilidade com os `hive.config.json` já criados |
| Identidade da task | `Task.id: string` substitui `Task.number: number` | Markdown aceita ids como `T-12`; GitHub grava o número do issue como string |
| Formato markdown | Uma tabela `\| id \| título \| status \|`; resto do arquivo livre | Legível no GitHub, editável à mão, e o código só toca a tabela |
| Escrita no `.md` | Reescrita por linha, só a célula `status` da linha da task | Todo o resto do arquivo fica byte a byte igual |
| Setup | Select `tipo de board`; markdown não chama `gh` | Configuração pela interface pros dois tipos |

## Config

```json
{ "board": { "type": "github", "owner": "@me", "number": 6 }, "status": { "queue": "Ready", "working": "In progress", "review": "In review" } }
{ "board": { "type": "markdown", "path": "board.md" }, "status": { "queue": "Ready", "working": "In progress", "review": "In review" } }
```

- `board.type` ∈ `github` | `markdown`; tipo desconhecido → erro do `parseConfig` nomeando o campo.
- `github`: `owner` (string não vazia), `number` (inteiro ≥ 0). `markdown`: `path` (string não vazia, relativo ao repo; absoluto também aceito).
- `status.*` vale pros dois tipos: nomes das opções de Status no GitHub; valores da coluna `status` no markdown.
- Legado: `{ "project": { "owner", "number" } }` sem `board` é lido como `board: { type: "github", owner, number }`. Ao salvar pela UI o arquivo é reescrito no formato novo.
- `maxConcurrent`, `port`, `claudeArgs`, `promptTemplate` inalterados.

## Tipos

```ts
type BoardConfig =
  | { type: 'github'; owner: string; number: number }
  | { type: 'markdown'; path: string };

interface Task { itemId: string; id: string; title: string; body: string; url: string }
```

- `Task.id`: GitHub → `String(issue.number)`; markdown → a célula `id`. `itemId` continua sendo a chave interna do adapter (GitHub: id do item do project; markdown: o próprio `id`).
- Slug do worker: `hive-<id em kebab>-<título>` (`slugFor` kebab-iza o id também, então `T-12` → `hive-t-12-…`).
- Placeholders do prompt: `{id}` novo; `{number}` mantido como sinônimo de `{id}`; `{title}`, `{body}`, `{url}` inalterados. Markdown: `{body}` = vazio (a descrição é problema do command); `{url}` = caminho absoluto do arquivo.
- UI mostra `#<id>` onde hoje mostra `#<number>`.

## Interface `Board`

```ts
interface Board {
  resolveFields(): Promise<void>;        // valida a config contra a fonte (opções/tabela existem)
  listQueue(): Promise<Task[]>;          // tasks em status.queue, na ordem da fonte
  setStatus(itemId: string, key: StatusKey): Promise<void>;
  setupOptions(): Promise<string[]>;     // valores de status disponíveis, pro formulário
}
```

`src/board.ts`: `createBoard(config, deps?)` → `github` ou `markdown`. `listProjects(owner)` continua exportado só pelo adapter GitHub (é específico dele) e a rota `GET /setup/projects` chama ele diretamente. `GET /setup/columns` passa a receber o `board` completo na query (`type` + campos) e devolve `createBoard(...).setupOptions()`.

## Adapter markdown (`src/boards/markdown.ts`)

- **Localização da tabela**: a primeira tabela do arquivo cujo cabeçalho contém, case-insensitive e ignorando acentos, as colunas `id`, `título`/`title` e `status` (em qualquer ordem, com outras colunas extras permitidas). Linha de separador (`|---|`) obrigatória. A tabela termina na primeira linha que não começa com `|`.
- **Parse**: uma task por linha; células trimadas; `id` vazio → linha ignorada; ids duplicados → erro (`resolveFields` e `listQueue` rejeitam, mensagem lista os ids).
- `listQueue()`: linhas com `status === config.status.queue`, ordem do arquivo. `Task.url` = caminho absoluto do arquivo; `body` = `''`.
- `setStatus(itemId, key)`: relê o arquivo na hora (não usa cache), acha a linha pelo `id`, substitui só o conteúdo da célula `status` (mantendo os espaços de padding das outras células como estavam), regrava o arquivo inteiro (tmp + rename). Id não encontrado → erro `task <id> não encontrada em <path>` (vira banner, como qualquer falha de `setStatus`).
- `resolveFields()`: arquivo existe e contém a tabela; senão erro dizendo o caminho e o cabeçalho esperado.
- `setupOptions()`: valores distintos da coluna `status` no arquivo ∪ `Ready`, `In progress`, `In review`, `Done`, nessa ordem de aparição.
- **Criação**: `POST /setup` com `markdown` e arquivo inexistente cria o arquivo com o cabeçalho e uma linha de exemplo (`| T-1 | Exemplo | Done |` — literal `Done`, fora da fila, para que um setup novo não abra um worker no exemplo), antes de `resolveFields`. É a única escrita fora da tabela e só acontece se o arquivo não existe.
- Edição manual concorrente: o poll de 30s relê; `setStatus` sempre relê antes de escrever. Sem lock (single user, local).

## Adapter GitHub (`src/boards/github.ts`)

O `board.ts` atual movido, com `Task.id = String(number)` e `setupOptions()` = `listStatusOptions(owner, number)`. Sem outras mudanças de comportamento.

## Setup (UI e rotas)

- Formulário: select `tipo de board` (`github` | `markdown`) no topo, default `github` (ou o tipo atual ao reconfigurar).
  - `github`: owner + carregar + project + três selects de coluna (como hoje).
  - `markdown`: campo `caminho` (default `board.md`) + três campos de texto pras colunas (defaults `Ready` / `In progress` / `In review`), com um botão `carregar` que chama `GET /setup/columns` e oferece os valores do arquivo como sugestões (`datalist`) nos campos de texto. Sem `gh`.
  - `máx. workers` e `prompt do worker` iguais pros dois.
- `POST /setup` corpo: `{ board: BoardConfig, status, maxConcurrent, promptTemplate? }`. Ordem: `parseConfig` → (markdown: cria o arquivo se não existe) → `resolveFields` → grava config → `configure`/`reconfigure`. Códigos de erro como hoje.
- `GET /setup` devolve a config com `board` no formato novo.
- Trocar de tipo ao reconfigurar com workers vivos: os slots mantêm `itemId`s do board antigo; um `setStatus` deles falha e vira banner (mesma limitação já documentada pra trocar de project).

## Testes

- `test/boards/markdown.test.ts` (arquivos em `mkdtemp`): tabela no meio de outro conteúdo com colunas extras e cabeçalho em português; fila na ordem e só com o status certo; `setStatus` muda só a célula e o resto do arquivo é byte a byte igual (incluindo a descrição abaixo da tabela); id ausente; ids duplicados; arquivo sem tabela; `setupOptions` com união e ordem; criação do arquivo.
- `test/board.test.ts`: factory escolhe pelo tipo; GitHub inalterado exceto `id` string.
- `test/config.test.ts`: `board` github/markdown válidos; tipo desconhecido; `project` legado → github.
- `test/orchestrator.test.ts`: `slugFor` com id `T-12`.
- `test/spawn.test.ts`: `{id}` e `{number}` renderizam o mesmo.
- `test/setup.test.ts`: salvar markdown cria o arquivo e boota a fila a partir dele; `GET /setup/columns` com `type=markdown`.

## Critério de pronto

1. Num repo com `board.md` contendo a tabela e descrições abaixo, `hive` → configurar → tipo markdown → salvar: a fila mostra as linhas em `Ready`; com `máx. workers = 1` um worker abre com `/seu-command #<id>` e a linha muda pra `In progress` no arquivo sem tocar em mais nada.
2. Um `hive.config.json` antigo com `project` continua funcionando sem edição.
3. `pnpm test` verde com os testes acima.

## Fora

Asana e demais backends; blockers/dependências (roadmap 3); múltiplos boards por repo; lock de arquivo; migrar tasks entre tipos.
