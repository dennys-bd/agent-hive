# System design diagrams

The `.drawio` subset `hive:system-designer` writes and `hive:system-design-reviewer` checks. A diagram is one uncompressed `.drawio`
file, `mxfile` XML, which the Hive's diagram pane opens. You write structure, never positions: a new file is a *pending diagram*, which
the pane lays out on its first open and writes back laid out.

## The folder

One living folder per repository, `systemDesignsDir`, never dated per task.

- `architecture.drawio` is the main diagram: the repository's runtime parts and their main modules.
- Every other diagram explains one part of it and is named after that part and its kind, `<part>-<kind>.drawio`, `<kind>` one of
  `flowchart`, `sequence`, `class`, `use-case`: `task-open-sequence.drawio`, `reducer-class.drawio`.
- Every file name matches `^[a-z0-9-]+\.drawio$`. Paths stay under the folder and are quoted in every command.

## Diagram kinds

| Kind | File | Explains | Pending form |
|---|---|---|---|
| architecture | `architecture.drawio` | the runtime parts as first-level containers, their main modules inside, what calls what | XML, `verticalFlow` |
| flowchart | `<part>-flowchart.drawio` | one flow with decisions, inside one part | XML, `verticalFlow`; `horizontalFlow` for a pipeline read left to right |
| sequence | `<part>-sequence.drawio` | the messages between parts over time, for one flow | Mermaid `sequenceDiagram` |
| class | `<part>-class.drawio` | the types of one module and how they relate | Mermaid `classDiagram` |
| use case | `<part>-use-case.drawio` | who uses a part and for what | XML, `verticalFlow` |

A diagram other than `architecture.drawio` zooms into its part. It never redraws the architecture around it; a part outside it appears,
when needed, as one component at its edge.

## The pending marker

A pending diagram carries one of two markers. You write it; the pane's first save clears it, since draw.io's own XML never carries one.

- `hive-layout="<preset>"` on `<mxfile>`. Every vertex sits at 0,0 with its size only. The pane loads the XML with the preset, then
  routes the edges with `libavoid`. draw.io's six presets are `verticalFlow`, `horizontalFlow`, `verticalTree`, `horizontalTree`,
  `radialTree` and `organic`. Use `verticalFlow`, or `horizontalFlow` for a pipeline read left to right: only those two were checked
  with nested containers. An unknown preset loads with no layout, every vertex piled at 0,0.
- A `<hive-mermaid>` element inside `<mxfile>`, in place of `<diagram>`, holding the Mermaid text in a CDATA section. The pane imports
  it as native cells. Only `sequenceDiagram` and `classDiagram`.

A file with neither marker is laid out: someone opened it in the pane, or drew it by hand. Never add a marker to it.

## Shapes

Copy the style whole. The size is the starting one; make a vertex wider for a long label, never narrower.

| Shape | Style | Size | For |
|---|---|---|---|
| component | `rounded=1;whiteSpace=wrap;html=1;` | 120×40 | a module, a service, a step of a flowchart |
| container | `swimlane;container=1;` | 300×200, 200×120 inside another | a runtime part, a group of modules, a use case's system boundary |
| database | `shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;size=15;` | 60×80 | a store: a database, a state file |
| queue | `shape=cylinder3;direction=south;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;size=15;` | 100×50 | a queue, a stream, a channel |
| actor | `shape=umlActor;verticalLabelPosition=bottom;verticalAlign=top;html=1;outlineConnect=0;` | 30×60 | a person or an outside system that uses the part |
| terminal | `rounded=1;arcSize=50;whiteSpace=wrap;html=1;` | 120×40 | a flowchart's start or end |
| decision | `rhombus;whiteSpace=wrap;html=1;` | 80×80 | a flowchart's branch, its question as the label |
| use case | `ellipse;whiteSpace=wrap;html=1;` | 140×60 | one use case, inside the system boundary |
| lifeline | `shape=umlLifeline;perimeter=lifelinePerimeter;whiteSpace=wrap;html=1;container=1;dropTarget=0;collapsible=0;recursiveResize=0;outlineConnect=0;portConstraint=eastwest;size=40;` | 100×300 | a participant added to a laid-out sequence diagram |
| class | `swimlane;fontStyle=1;align=center;verticalAlign=top;childLayout=stackLayout;horizontal=1;startSize=26;horizontalStack=0;resizeParent=1;resizeParentMax=0;resizeLast=0;collapsible=0;marginBottom=0;html=1;` | 160×80 | a type added to a laid-out class diagram |
| member | `text;strokeColor=none;fillColor=none;align=left;verticalAlign=top;spacingLeft=4;spacingRight=4;overflow=hidden;rotatable=0;html=1;` | 160×26 | a field or method row inside a class |

A new sequence or class diagram is Mermaid; lifeline, class and member are for editing one the pane already laid out. A label is the
cell's `value`, one line, with `&`, `<`, `>` and `"` written `&amp;`, `&lt;`, `&gt;` and `&quot;`.

## Containers

- A container is a `swimlane;container=1;` vertex; its label sits in its title bar. A child names it as `parent`, and its coordinates
  are relative to the container.
- Two levels at most. A first-level container's parent is `1`; a second-level one's is a first-level container; a second-level
  container holds no container. A class or a lifeline counts as a container of its own rows only.
- In a pending file a container's size is a starting size; the layout grows it to fit its children.

## Edges

`<mxCell id="…" edge="1" parent="…" source="…" target="…">` with a `style` from the table below, holding `<mxGeometry relative="1" as="geometry"/>` and nothing
else: no `<Array as="points">`, no waypoint, no `exitX` or `entryX`. Draw an edge from the caller to the callee, the sender to the receiver, or
the emitter to the listener. An edge between cells of different containers has `parent="1"`; one inside a single container may name
that container. A label, when it helps, is short: the route, the method, the event.

| Edge | Style | For |
|---|---|---|
| call | `endArrow=block;html=1;` | a call, an import, a request |
| event | `endArrow=open;dashed=1;html=1;` | an event, a message on a queue, anything asynchronous |
| message | `html=1;verticalAlign=bottom;endArrow=block;curved=0;rounded=0;` | a call between lifelines of a laid-out sequence diagram |
| reply | `html=1;verticalAlign=bottom;endArrow=open;dashed=1;endSize=8;curved=0;rounded=0;` | its answer |
| inherits | `endArrow=block;endFill=0;html=1;` | a class's parent or an interface it implements |
| uses | `endArrow=open;html=1;` | a class's association with another |

## Ids

The two root cells are `0` and `1` (`parent="0"`). Every other id is a kebab-case name from the code: a vertex after its module,
process or type (`daemon`, `reducer`), an edge `e-<source>-<target>` (`e-routes-reducer`), with `-2` added for a second edge between the
same pair. Ids are unique in the file. Never change an existing id, draw.io's own included.

## A pending XML diagram

```xml
<mxfile hive-layout="verticalFlow">
  <diagram id="architecture" name="Architecture">
    <mxGraphModel>
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
        <mxCell id="web" value="Web app" style="swimlane;container=1;" vertex="1" parent="1"><mxGeometry width="300" height="200" as="geometry"/></mxCell>
        <mxCell id="dashboard" value="Dashboard" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="web"><mxGeometry width="120" height="40" as="geometry"/></mxCell>
        <mxCell id="server" value="Server" style="swimlane;container=1;" vertex="1" parent="1"><mxGeometry width="300" height="200" as="geometry"/></mxCell>
        <mxCell id="http" value="HTTP layer" style="swimlane;container=1;" vertex="1" parent="server"><mxGeometry width="200" height="120" as="geometry"/></mxCell>
        <mxCell id="routes" value="routes" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="http"><mxGeometry width="120" height="40" as="geometry"/></mxCell>
        <mxCell id="reducer" value="reducer" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="server"><mxGeometry width="120" height="40" as="geometry"/></mxCell>
        <mxCell id="state" value="state.json" style="shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;size=15;" vertex="1" parent="server"><mxGeometry width="60" height="80" as="geometry"/></mxCell>
        <mxCell id="e-dashboard-routes" value="HTTP" style="endArrow=block;html=1;" edge="1" parent="1" source="dashboard" target="routes"><mxGeometry relative="1" as="geometry"/></mxCell>
        <mxCell id="e-routes-reducer" style="endArrow=block;html=1;" edge="1" parent="1" source="routes" target="reducer"><mxGeometry relative="1" as="geometry"/></mxCell>
        <mxCell id="e-reducer-state" style="endArrow=block;html=1;" edge="1" parent="server" source="reducer" target="state"><mxGeometry relative="1" as="geometry"/></mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
```

## A pending Mermaid diagram

```xml
<mxfile>
  <hive-mermaid><![CDATA[sequenceDiagram
  participant dashboard as Dashboard
  participant routes as routes
  participant reducer as reducer
  dashboard->>routes: POST /tasks/:id/open
  routes->>reducer: reduce(state, open)
  reducer-->>routes: next state
  routes-->>dashboard: 200
]]></hive-mermaid>
</mxfile>
```

A class diagram is the same form with `classDiagram` text: `class Board { <<interface>> }`, `GithubBoard ..|> Board`. The CDATA section
keeps Mermaid's `<` and `>` out of the XML. A participant's or a class's name is the code's; its alias, the label, is in the docs language
unless it is a name from the code.

## Editing a laid-out diagram

- Before the first edit of a laid-out file in a round, copy it to a `mktemp -d` folder outside the repositories: that copy is what
  "The check" compares against.
- Every existing cell keeps its `mxGeometry`, its style and its id. Existing edges keep their points.
- A new vertex names its container as `parent`, with coordinates relative to it, beside the neighbour it connects to: the same `y`, `x` at
  the neighbour's right edge plus 40, or below it (`y` at its bottom plus 40) when the row is full. It sits on free space inside the
  container, at least 10 from its sides and below its title bar (`y` ≥ 30).
- A container the new vertex no longer fits in grows: `width` to the child's right edge plus 10, `height` to its bottom plus 10, and its
  own container the same way when it then sticks out. Growth changes only `width` and `height`, never `x` or `y`, and it is the only
  geometry change to an existing cell. A growth that overlaps a sibling is left as it is and said at the end of the round; never move
  the sibling.
- A new edge gets no waypoints. A removed part takes its vertex and every edge naming it; nothing moves to close the gap. A renamed part
  changes its `value` and keeps its id.
- Never add `hive-layout` or `<hive-mermaid>` to a laid-out file: the pane would lay it out again, and every position a person set
  would be lost.

## Editing a pending diagram

A file that still carries its marker has no positions to keep. Edit its XML (a new vertex at 0,0 with its size only) or its Mermaid text,
and keep the marker. No copy is needed.

## The check

Read each file back, then check every item:

1. **Parses.** One `<mxfile>` root, every tag closed, every attribute quoted, `&` and `<` escaped in a label, Mermaid inside CDATA.
   When `command -v xmllint` finds it, `xmllint --noout "<file>"` prints nothing.
2. **Ids.** `grep -o ' id="[^"]*"' "<file>"` lists each id once; `0` and `1` are the root cells.
3. **References.** Every `parent`, `source` and `target` names an id of the file. Every edge has both `source` and `target`. A vertex's
   parent is `1` or a container.
4. **Marker.** Only on a file this round created, or on a pending file it edited. Never on a laid-out file.
5. **Nesting.** Two container levels at most, as "Containers" says.
6. **Styles.** Every cell the round added carries a style of "Shapes" or "Edges", copied whole.
7. **Pending XML.** Every vertex's `mxGeometry` has `width` and `height` and no `x` or `y`; no edge has points.
8. **Laid-out file.** `git diff --no-index -- "<copy>" "<file>"` shows only added or removed cells and, on an existing cell, only a
   container's `width` or `height`.
9. **Names.** Every label names something found in the code. Whether the diagram is true to the code is the reviewer's half.
