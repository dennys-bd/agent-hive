# Monitor View: click scenarios

Written against the handoff, never an implementation. Only the tester reads this file: the baseline the workers start from leaves it out.

The dashboard runs on a sanitized snapshot of a real Hive: eight or more activities of agent-hive, at least one awaiting approval, one stopped (parada), one with an open PR and one with two sessions. No agent runs, so nothing here needs an agent working or waiting, a command executing or a machine under pressure, and no activity is active: "todas ativas" stays empty and shows no panel. A scenario that needs panels pins activities first from the left panel (⌘B opens it, each activity has a pin beside it), closes it with ⌘B again and works under "fixadas". Nothing is pinned at the start, and a scenario sees what earlier ones pinned. The interface is in Portuguese.

## S1 · Open the monitor
Delivery: 1
Steps:
1. Click "monitor" in the window header.
2. Go to another section of the header, then press ⌘3.
Expected: both times the monitor shows its bar titled "monitor" with a summary of the activities; with nothing pinned, the grid shows "Nenhuma atividade fixada" with the buttons "+ fixar atividade" and "ver todas ativas".

## S2 · Read a panel
Delivery: 1
Steps:
1. Press ⌘B and, in the left panel, click the pin beside activities until six are pinned, the one with two sessions among them. Press ⌘B again to close it and pick "fixadas".
2. Look at the panel of the activity with two sessions.
Expected:
- the grid has three columns and two rows;
- the panel's top shows the workspace square, the title, the stage, the status, the pin and "⋯";
- below that, two session chips with the agent and a short id, one of them on a darker background, and the time or the tokens on the right.

## S3 · Focus and open
Delivery: 1
Steps:
1. If fewer than two activities are pinned, press ⌘B, click the pin beside activities in the left panel until two are, and press ⌘B again. Pick "fixadas".
2. Click the title of the second panel.
3. Press ⌘1.
4. Press Enter.
Expected: the focus ring moves to the second panel, then to the first; Enter opens the first panel's activity in atividades.

## S4 · Filter with the keys
Delivery: 2
Steps:
1. Press ⌥2, then ⌥3, then ⌥1.
Expected:
- ⌥2 selects "todas ativas" and shows every active activity, or its empty state when none is;
- ⌥3 selects "precisam de você" and shows only the activities awaiting you or awaiting approval, or its empty state when none is;
- ⌥1 selects "fixadas";
- the summary in the bar follows each filter.

## S5 · Pin, reload, unpin
Delivery: 2
Steps:
1. Pick "fixadas" and unpin every panel there with its pin, until the grid shows its empty state.
2. Press ⌘B, click the pin beside one activity in the left panel, and press ⌘B again.
3. Reload the page.
4. Click the pin in that panel's top.
Expected: after step 2 the panel is alone under "fixadas" with a filled pin whose tooltip is "desafixar", still there after the reload; step 4 brings back the empty state.

## S6 · More pinned than fit
Delivery: 2
Steps:
1. Press ⌘B and, in the left panel, click the pin beside activities until exactly seven are pinned. Press ⌘B again to close it and pick "fixadas".
Expected: six panels fill the grid and the third row shows cut off; the grid scrolls vertically to the seventh, and the summary says "7 fixadas · 1 abaixo".

## S7 · Approval and stopped panels, and the ⋯ menu
Delivery: 3
Steps:
1. Press ⌘B and, in the left panel, pin the activity awaiting approval and a stopped (parada) one if they are not pinned yet. Press ⌘B again to close it and pick "fixadas".
2. Look at the panel awaiting approval. Do not click "aprovar".
3. Look at the stopped panel. Do not click "retomar".
4. Click "⋯" on any panel.
Expected:
- the approval panel has a border in its status colour and a bottom bar with "aprovar", "enviar feedback…" and "ver diff";
- the stopped panel has the status "parada", a bottom bar with "parada por você · a sessão continua no histórico" and "retomar", and its meta says how long ago it stopped;
- the menu lists "abrir em atividades", "expandir", "sessão exibida", "executar", "tamanho", "desafixar" and "parar".

## S8 · Expand a panel
Delivery: 3
Steps:
1. Pick "fixadas". If nothing is pinned, press ⌘B, click the pin beside one activity in the left panel, and press ⌘B again.
2. On a panel, open "⋯" › "expandir".
3. Go back to the grid the way the screen offers (Esc, or the same menu item again).
Expected: the panel fills the grid, then the grid comes back as before.

## S9 · Organize, discard, keep
Delivery: 4
Steps:
1. Pick "fixadas". If fewer than two activities are pinned, press ⌘B, click the pin beside activities in the left panel until two are, and press ⌘B again.
2. Click "organizar", pick "colunas" 2 and press Esc.
3. Press ⌘⇧O, set the first panel to "2×2" and click "concluir".
Expected:
- the bar in organize shows "arraste para mover · escolha o tamanho em cada painel", "colunas" 2 · 3 · 4, "restaurar" and "concluir", and the footer says "esc sai sem salvar";
- the panels have a dashed border and each shows its size choices 1×1 · 2×1 · 1×2 · 2×2;
- Esc leaves the grid unchanged;
- after "concluir" the first panel spans two columns and two rows.

## S10 · Pin from organize
Delivery: 4
Steps:
1. Pick "fixadas". If nothing is pinned, press ⌘B, click the pin beside one activity in the left panel, and press ⌘B again. Unpin panels until fewer than six remain, then click "organizar".
2. Click "+ fixar atividade" in an empty cell, type the first word of an unpinned activity, pick it, and click "concluir".
Expected: the search shows the field "buscar atividade", activities with the workspace square, the title and the status, and the switch "fixar sozinho o que precisa de você"; the picked activity gets a panel.

## S11 · Side panels and details
Delivery: 5
Steps:
1. Pick "fixadas". If nothing is pinned, press ⌘B, click the pin beside one activity in the left panel, and press ⌘B again.
2. Click the title of a panel.
3. Press ⌘B.
4. Press ⌘⇧B and pick "detalhes".
Expected:
- the left panel lists the activities by workspace, under agent-hive, with pins and the note "o alfinete fixa no monitor. clique no título para focar o painel.";
- the right panel has the tabs "arquivos", "detalhes" and "saúde";
- the details say "do painel em foco" and show the focused activity's title;
- the grid has two columns.

## S12 · Run hive commands menu
Delivery: 6
Steps:
1. Pick "fixadas". If nothing is pinned, press ⌘B, click the pin beside one activity in the left panel, and press ⌘B again.
2. Click the title of a panel to focus it and open its "⋯" › "executar". Close it.
3. Press ⌘R, then type any text. Do not press Enter.
Expected:
- the submenu offers "na worktree de" the panel's activity, the named commands of the workspace if it has any, and "outro comando… ⌘R";
- ⌘R opens a popover on the panel titled "executar na worktree de" the activity (or "no checkout de" the workspace when the activity has no worktree), with a focused field;
- the first line of the popover is "executar" followed by the typed text, and its footer says "a saída vai para o console" and "esc fecha".

## S13 · Files tab
Delivery: 7
Steps:
1. Pick "fixadas". If fewer than two activities are pinned, press ⌘B, click the pin beside activities in the left panel until two are, and press ⌘B again.
2. Click the title of a panel, press ⌘⇧B and pick "arquivos".
3. Click the title of another panel.
Expected: the tab shows "do painel em foco" with the activity and its branch, and the file tree of that activity's worktree; step 3 changes the root to the other activity.

## S14 · Health tab
Delivery: 8
Steps:
1. Press ⌘⇧M.
2. Click an activity.
Expected:
- the right panel opens on "saúde", and the "saúde" button in the bar has a border;
- the tab has the sections máquina (cpu, memória, swap, disco), daemon (event loop, rss, uptime, sync with one line per source) and atividades;
- each activity row shows its cpu as "—" (none runs), its ram and its process count;
- step 2 expands that activity's row.
