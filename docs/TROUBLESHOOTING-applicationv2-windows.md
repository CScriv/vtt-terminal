# Troubleshooting: ApplicationV2 windows that dock, won't move, or render cramped

This documents two recurring problems when building ApplicationV2 windows in
this module (the main terminal and the compose window have both hit them), why
they happen, and the exact fixes. Read this before debugging a new window that
"won't float" or "looks squished" — you've almost certainly seen it before.

---

## Problem 1: the window docks into the sidebar / interface and can't be dragged free

### Symptom

The window opens pinned to the interface — e.g. immediately to the left of the
chat box / sidebar — and **rearranges the surrounding UI to make room for
itself**, as if it were part of the interface layout rather than a floating
popout. It has a normal title bar and can be dragged a little, but it's trapped
inside an invisible barrier and cannot be moved over the canvas or to screen
center.

### Root cause

**A `position: relative` (or any non-`static` `position`) is landing on the
application's ROOT element — the floating window frame.**

Foundry's window system positions popout windows with `position: absolute`
against `document.body`. When your own CSS puts `position: relative` on the same
root element, it overrides that `absolute`, and the window drops out of the
free-floating layer and into the normal document/flex flow of the interface.
The sidebar's flex layout then constrains it.

In this module the culprit is the **theme class** (`me-terminal`). Its base rule
includes:

```css
.me-terminal {
  /* ... */
  overflow: hidden;
  position: relative;   /* <-- this is the trap when applied to the app root */
}
```

`position: relative` is needed there for a legitimate reason — it anchors the
scanline overlay (`.me-terminal::after { position: absolute; inset: 0; }`) and,
with `overflow: hidden`, clips the scanlines to the rounded corners. The
property isn't wrong; it's just being applied to the **wrong element**.

The mistake is applying the theme class to the app root, either via:

```js
// WRONG — in _onRender:
_onRender(context, options) {
  super._onRender?.(context, options);
  this.element.classList.add(game.settings.get(MODULE_ID, "themeClass")); // app root!
}
```

…or by listing it in `DEFAULT_OPTIONS.classes`:

```js
// WRONG:
classes: ["terminal-app", "me-terminal"],   // me-terminal on the root again
```

Either way, `position: relative` ends up on the frame and the window docks.

### The fix: put the theme class on an INNER wrapper, never the root

The app root carries only structural classes. The theme class goes on a child
element inside `.window-content`, so `position: relative` / `overflow: hidden`
skin the *content area* (and correctly anchor the scanline there) without
touching the window frame.

**Options:** keep the root classes structural only.

```js
classes: ["terminal-app", "terminal-compose"],   // no theme class here
```

**Do NOT add the theme class to `this.element` in `_onRender`.** Pass it into
the render context instead:

```js
async _prepareContext(_options) {
  return {
    themeClass: game.settings.get(MODULE_ID, "themeClass"),
    /* ... */
  };
}
```

**Template:** apply it to the outermost *content* element.

```hbs
{{!-- shell.hbs (main terminal) --}}
<div class="terminal-screen {{themeClass}}"> ... </div>
```

```hbs
{{!-- compose.hbs (compose window) --}}
<form class="compose-form {{themeClass}}"> ... </form>
```

Because the positioned/overflow context is now on a child of `.window-content`
rather than on the floating frame, the window system keeps full control of the
frame's position, and the window floats and drags normally.

### What is NOT the cause (things we chased and ruled out)

- **`tag: "form"` vs `tag: "div"`.** Switching the root tag does not fix the
  docking on its own — the theme-on-root CSS still traps a `tag: "div"` window.
  (`tag: "div"` is still the preferred root for a floating popout, but for
  layout/handler reasons, not for un-docking.)
- **Missing `window.positioned: true`.** Worth confirming it's set, but its
  absence was not the cause here; the windows had it and still docked.
- **Missing `position.left` / `position.top`.** Nice to set for a sensible
  open location, but not the docking cause.

### Fast diagnosis

If a window docks, open dev tools, select the app's root element
(`#your-app-id`), and check the computed `position`. If it's anything other than
`absolute`, find the CSS rule setting it (it'll be one of your own classes on
the root, very likely the theme class) and move that class to an inner wrapper.

### Checklist for any new ApplicationV2 popout

- [ ] Root `classes` contain only structural names — no class whose CSS sets
      `position` to anything but `static`.
- [ ] `window: { frame: true, positioned: true, resizable: true }`.
- [ ] Theme / skin class is applied to an inner wrapper in the template, via a
      `themeClass` context value — never to `this.element`.
- [ ] After rendering, the root's computed `position` is `absolute`.

---

## Problem 2: a textarea (or input) renders absurdly narrow inside a flex column

### Symptom

The window floats correctly, but the message `<textarea>` is locked to a tiny
fixed width (roughly 20 characters) and won't expand to fill the window, even
though the text `<input>` fields above it fill normally.

### Root cause

The message field's wrapper (`.compose-body-group`) is a **nested flex column**
inside the outer column. Flex items default to `min-width: auto`, which means
they refuse to shrink below their content's intrinsic size on the cross axis. A
`<textarea>` with no `cols` attribute has a UA-default intrinsic width of ~20
characters, so the wrapper collapses to that ~20ch and the textarea fills its
(tiny) wrapper.

This is why only the textarea looked broken: the SUBJECT field is a plain
`<input>`, whose intrinsic width doesn't impose the same ~20ch floor, so its
wrapper stretched to full width normally. The distinguishing factor is the
textarea's `cols`-based intrinsic width combined with the wrapper's default
`min-width: auto` — **not** anything specific to how `width: 100%` was written.
Putting `width: 100%` on the textarea alone does nothing while its parent
wrapper is still collapsed: 100% of ~20ch is still ~20ch.

### The fix: release the wrapper's `min-width`, then fill

The key line is `min-width: 0` on the **wrapper**, which lets it shrink/stretch
to the column instead of being held to the textarea's intrinsic width. With that
freed, `width: 100%` on the controls fills the content area.

```css
/* The nested flex-column wrapper must be allowed to size to the column,
   not to the textarea's intrinsic (cols-based) width. min-width:0 is the
   load-bearing declaration here. */
.terminal-compose .compose-body-group {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  width: 100%;
  min-width: 0;           /* <-- without this the wrapper collapses to ~20ch */
  min-height: 0;
}
.terminal-compose .compose-body-group textarea {
  flex: 1 1 auto;         /* grow to fill the group's height */
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  resize: vertical;       /* user can drag taller; width stays locked to 100% */
  min-height: 6rem;
}
```

The plain inputs/selects also get `width: 100%; min-width: 0; box-sizing:
border-box;` so they fill consistently, but those weren't the collapsing case.

### General rule for flex-column form layouts

- Set `width: 100%; box-sizing: border-box; min-width: 0;` on `input`,
  `select`, and especially `textarea`.
- Use `flex: 1 1 auto` + `min-height: 0` along the *chain* of ancestors from
  `.window-content` down to the element that should grow, or the grow request
  stops at the first ancestor that doesn't pass height through.
- `min-height: 0` / `min-width: 0` matter because flex items default to
  `min-*: auto`, which refuses to shrink below content size and silently
  breaks both growing and shrinking.

---

## Problem 3: correct, loaded CSS produces no visible change (the cache trap)

### Symptom

You edit a module stylesheet, reload the world, and **nothing changes** — not
"changed but still wrong," but zero difference, repeatedly, across several edits
that you've verified are correct and actually saved to disk.

### Root cause

Foundry (and the browser / Electron shell) caches module CSS aggressively. A
normal page reload (F5) often re-runs your JS while serving the **old cached
stylesheet**, so your CSS edits never reach the renderer. This masquerades as
"my CSS rule isn't working," sending you off to rewrite rules that were correct
all along.

### How to tell this is what's happening

- Your rule is registered in `module.json` `styles`, the file exists at that
  path, and the target class is actually on the element — yet there's *no*
  effect from any change.
- The giveaway: edits produce **no difference at all**, rather than a different
  wrong result. A rule that's loaded-but-losing-a-specificity-fight usually
  changes *something*; a cached stylesheet changes nothing.

### Confirming / fixing

1. **Prove it with an inline style.** Temporarily put the declaration directly
   on the element in the template (`style="width:100%;min-width:0;"`). Inline
   styles ship inside the HTML, bypass the CSS cache, and outrank normal
   stylesheet rules. If the inline version works, the structure and the rule are
   correct and the stylesheet just wasn't loading — i.e. it's the cache.
2. **Hard-reload to clear it.** In the Foundry Electron app: open dev tools
   (View → Toggle Developer Tools), then right-click the reload button and
   choose **"Empty Cache and Hard Reload."** In a browser tab: Ctrl+Shift+R
   (Cmd+Shift+R on macOS). A plain F5 is not enough.
3. **Move the styles back to the stylesheet** once the cache is cleared, and
   delete the inline `style=` attributes. Inline styles are a diagnostic, not a
   home — left in place they silently shadow future stylesheet rules for that
   element, which becomes its own confusing trap later.

### The time-saving heuristic

**When correct, loaded CSS produces zero change, suspect the module-CSS cache
before re-debugging the rule.** Confirm with an inline style, hard-reload, then
move it back. This one check would have saved several rounds of rewriting rules
that were never the problem.

---

## Why these recur

Problems 1 and 2 come from the same root tension: **Foundry's window system owns
the frame's geometry, and your content CSS owns everything inside it — and it's
easy to write a rule that reaches across that boundary.** A `position` on the
root reaches up and fights the window system (Problem 1); a flex wrapper left at
`min-width: auto` lets a child's intrinsic size collapse the layout (Problem 2).
Keep skin/positioning CSS on inner wrappers, and set `min-width: 0` / `min-height: 0`
on flex wrappers in the grow/stretch chain, and neither recurs.

Problem 3 is the meta-lesson that sits above both: **before you trust the symptom,
make sure your CSS is actually loading.** When a verified-correct rule has no
effect at all, prove it with an inline style and hard-reload to clear the
module-CSS cache before you rewrite anything.
