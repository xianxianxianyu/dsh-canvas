## Check, look, deliver

The user sees the file rendered in DSH's right sidebar. `canvas_check` shows you the same page.

1. Write the file with `write` or `edit`.
2. Run `canvas_check` with `{ "path": "<file>", "image": false }`. This only validates. When the result is an error, each problem has a `line:column` and the source line with a caret under the column. Fix the file and check again until it passes.
3. Run `canvas_check` once more without `image` for the final review. On a model that can see images, the result carries the picture the user will see. Look at it as the reader would: every label readable, no crowded or crossing arrows that hide the point, marks on the states that matter. If something is off, fix it and go back to step 2.
   - When the result says 未出图, it names the reason (the model cannot see images, no Chrome or Edge, …). The file is still valid. Do not describe a picture you have not seen; tell the user the chart passed validation and is ready to view.
4. Call `present` with the file. The user opens it beside the chat; the sidebar redraws whenever the file changes, and Plain text stays in its viewer menu.
