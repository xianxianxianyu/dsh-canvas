---
name: canvas-mock
description: "Design a static HTML/CSS UI mock in a .mock.html file, preview it beside the chat, and inspect the same screenshot with canvas_check. Use for one-screen desktop or mobile interface designs and element-level design feedback."
---

# UI mock (canvas)

Write one screen per `name.mock.html` file. The compound suffix selects the 界面稿 preview; ordinary `.html` files stay with DSH's normal viewer. This is a design document, not a running app: use semantic HTML and inline CSS, never JavaScript, event handlers, frameworks, external stylesheets, fonts or remote images. Inline CSS and `data:` images work; network resources and scripts are blocked.

## Compose the screen

- Use a complete HTML document with `<!doctype html>`, UTF-8, a descriptive title, and CSS in `<style>` or `style` attributes.
- Set the intended viewport in the head: `<meta name="canvas-viewport" content="390x844">` for mobile or `1280x800` for desktop. Without a marker the default is desktop, 1280×800. The preview can switch to the desktop/mobile presets without editing the file; `canvas_check` uses the file's viewport.
- Use real, specific copy: a plausible product name, meaningful field labels, useful errors, clear actions, and realistic data. Avoid lorem ipsum and rows of generic placeholders.
- Keep one screen in each file, with deliberate hierarchy, spacing, typography, contrast and focus. Design for the declared dimensions; use `box-sizing: border-box` and responsive widths rather than hiding accidental horizontal overflow.
- Give anything people may comment on a stable `id` or `data-canvas-id`, especially buttons, links, inputs, selects, textareas and elements with `role="button"`. Prefer short meaningful ids such as `login-submit`; keep them when revising. The element's visible text is the comment label. Do not reuse an anchor on two elements.
- A static control should look like its intended state. It does not need a click handler, form action or live authentication to communicate the design.

## Check, inspect, present

1. Write or edit the `.mock.html` file. Run `canvas_check` on it; static diagnostics include source line and column. Remove scripts/external resources, duplicate ids and missing interactive anchors.
2. With Chrome available, the check renders at the file's viewport and warns about horizontal overflow and cheap-to-detect clipped text. Look at the attached PNG yourself: check actual layout, copy, truncation and the one-screen composition. Fix the cause and check again. `image: false` is useful for static-only iterations; do not use it instead of looking at the final image.
3. Use `present` to deliver the file, so the person can open 界面稿 in the right sidebar, switch desktop/mobile viewports, zoom and pin feedback on elements.
4. When the person says 「看批注」, follow the shared loop below: `canvas_check` lists pending threads and frames their elements in the image; revise while keeping anchor ids, then reply with `canvas_comment` and mark `addressed`. Only the person resolves the thread.

If the check says 「未出图」, explain the stated reason. Static-only validation is not evidence that a layout fits its viewport.
