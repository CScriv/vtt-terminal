/* =============================================================
   TERMINAL — scene controls (top-level launch button)
   -------------------------------------------------------------
   The v13 scene-controls DATA api (getSceneControlButtons) is buggy
   for standalone top-level buttons — a malformed control group
   crashes the canvas (_updateNotesIcon), and a tool added to an
   existing group renders nested, not top-level.

   So, following the Levels module's proven approach, we inject the
   button into the controls DOM directly on renderSceneControls.
   This yields a genuine top-level button and avoids the broken API.

   ⚠ FRAGILITY: depends on the #scene-controls-layers element id and
   the native control button classes. These are Foundry UI internals
   that a future version could rename (same risk Levels carries). If
   the button vanishes after a Foundry update, this selector/markup is
   the thing to refresh against the then-current scene-controls DOM.
   ============================================================= */

const MODULE_ID = "vtt-terminal";

Hooks.on("renderSceneControls", () => {
  // Re-render safe: bail if our button is already present.
  if (document.querySelector(`#scene-controls-layers button[data-control='${MODULE_ID}']`)) return;

  const layers = document.querySelector("#scene-controls-layers");
  if (!layers) return;

  layers.insertAdjacentHTML(
    "beforeend",
    `<li>
      <button type="button" class="control ui-control layer icon fa-solid fa-terminal" role="tab" data-action="${MODULE_ID}" data-control="${MODULE_ID}" data-tooltip="Terminal" aria-controls="scene-controls-tools"></button>
    </li>`
  );

  document
    .querySelector(`#scene-controls-layers button[data-control='${MODULE_ID}']`)
    .addEventListener("click", () => {
      game.modules.get(MODULE_ID)?.api?.open();
    });
});
