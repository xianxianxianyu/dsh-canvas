## Check, look, deliver

The user sees the file rendered in DSH's right sidebar. `canvas_check` shows you the same page.

1. Write the file with `write` or `edit`.
2. Run `canvas_check` with `{ "path": "<file>", "image": false }`. This only validates. When the result is an error, each problem has a `line:column` and the source line with a caret under the column. Fix the file and check again until it passes.
3. Run `canvas_check` once more without `image` for the final review. On a model that can see images, the result carries the picture the user will see. Look at it as the reader would: every label readable, no crowded or crossing arrows that hide the point, marks on the states that matter. If something is off, fix it and go back to step 2.
   - When the result says 未出图, it names the reason (the model cannot see images, no Chrome or Edge, …). The file is still valid. Do not describe a picture you have not seen; tell the user the chart passed validation and is ready to view.
4. Call `present` with the file. The user opens it beside the chat; the sidebar redraws whenever the file changes, and Plain text stays in its viewer menu.

## Comments (看批注)

In the sidebar the user can pin comments on nodes. When they say 看批注, or ask you to look at their comments:

1. Run `canvas_check` on the file. After the usual result it lists every comment still waiting (未处理 open, 已处理 addressed): its id, the node it points at (`id「label when commented」`), the text, and earlier replies. On a model that can see images, those nodes have a red dashed frame in the picture.
   - A `⚠` line means the node changed after the comment was written: its label is different, or its id is gone (regenerating a chart often renumbers ids). Use the old label in the warning to find what the user meant before you edit.
2. Change the file for the comments, then run steps 2 and 3 above until the check passes and the picture looks right.
3. For each comment you handled, call `canvas_comment` with `{ "path": "<file>", "id": "<comment id>", "reply": "<what you changed>", "status": "addressed" }`. When you decide not to change anything, reply with the reason and leave out `status`.
4. Only the user resolves, reopens or deletes a comment. Never say a comment is resolved: tell the user what you changed and that the comments wait for their check in the sidebar.
