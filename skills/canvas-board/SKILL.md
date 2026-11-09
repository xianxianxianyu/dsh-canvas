---
name: canvas-board
description: "Lay out several artifacts on one board: a JSON Canvas .canvas file whose boxes embed your .mmd diagrams, Markdown notes and images beside sticky notes and arrows, checked with canvas_check as one composite picture. Use for module or design overviews, comparing variants side by side, or whenever several files explain one thing together."
---

# Board (canvas)

A board is a JSON Canvas 1.0 file, `name.canvas` (https://jsoncanvas.org/spec/1.0/). It holds boxes (`nodes`) at absolute positions and arrows between them (`edges`). A box is a Markdown note, an embedded file, a link, or a group frame. Make the other artifacts first (a diagram with `canvas-diagram`, a `.md` note, an image), then place them on the board.

## Write it in the canonical form

One node or one edge per line, tab indents, exactly like this. The user's board edits rewrite only the line of the node they touch, so keep this form and your diffs and theirs stay one line each.

```json
{
	"nodes":[
		{"id":"flow","type":"file","file":"order.mmd","x":0,"y":0,"width":520,"height":380},
		{"id":"why","type":"text","text":"## 为什么\n支付失败后要能直接重试","x":560,"y":0,"width":300,"height":140,"color":"4"},
		{"id":"spec","type":"file","file":"notes/spec.md","x":560,"y":180,"width":300,"height":200}
	],
	"edges":[
		{"id":"why-flow","fromNode":"why","fromSide":"left","toNode":"flow","toSide":"right","label":"解释"}
	]
}
```

- **Every node** has `id`, `type` and integer `x`, `y`, `width`, `height` (pixels; `x` grows right, `y` grows down; width and height above 0).
- **`type: "text"`** has `text`: Markdown, with `\n` for line breaks. Use it for sticky notes, headings and short explanations.
- **`type: "file"`** has `file`: a path **relative to the board's own directory** (not your working directory), or an absolute path. What it shows:
  - `.mmd` / `.mermaid`: the diagram, scaled to fit the box. The header bar takes 24 px; give a diagram room (check the warning below).
  - `.md`: the rendered note.
  - `.png` `.jpg` `.webp` `.gif` `.svg`: the image (up to 8 MB).
  - Another `.canvas`, or any other file: only its name. Boards open one level deep.
- **`type: "link"`** has `url`; it shows the address, nothing is fetched. **`type: "group"`** is a labelled frame (`label`) drawn behind the nodes inside it.
- **Edges** have `id`, `fromNode` and `toNode` (node ids), and optionally `fromSide` / `toSide` (`top`, `right`, `bottom`, `left`; left out, the side facing the other node is used), `fromEnd` / `toEnd` (`none` or `arrow`; by default only the `to` end has an arrow) and `label`.
- **`color`** on a node or an edge: `"1"` red, `"2"` orange, `"3"` yellow, `"4"` green, `"5"` cyan, `"6"` purple, or `#rrggbb`.
- Ids are unique across nodes and edges. Use short, stable, readable ids (`flow`, `why`, `why-flow`) and never reuse an id for something else: the user's edits and comments find elements by id.
- Leave space between boxes: overlapping boxes are a warning. Size note boxes for their text: a box that cuts text off is a warning too.

## Editing a board the user is also editing

The user can move and resize boxes, add notes and arrows, and delete things on the same board; their changes are written into this file.

- Change a board with `edit` (one node's line at a time), not by rewriting the whole file with `write`: a rewrite from memory throws away whatever the user changed since you read it.
- When `edit` fails with `FS_STALE_VERSION` (`file changed since it was read — re-read the file, then retry`), the user changed the board. `read` it again, keep their changes (their positions, notes and arrows), and redo your edit on the new text.
- Never move a box back to where you put it unless the user asked; their layout wins.

## Checking

`canvas_check` on a board validates the JSON (with `line:column`), the fields, unique ids and that every edge points at a node. It also checks every embedded file: a missing file, or an embedded diagram that does not parse, fails the check with the place to fix (`order.mmd:4:6 …` for a diagram's own error). Warnings (overlaps, cut-off text, a diagram shrunk below half size, a file the board cannot show) do not fail it; fix them anyway unless you have a reason. The picture is the whole board with every embed drawn in place.
