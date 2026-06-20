/* =============================================================
   vtt-terminal — ONE-TIME MIGRATION MACRO
   -------------------------------------------------------------
   Run this ONCE, as a GM, after updating to the build where MODULE_ID
   changed from "terminal" to "vtt-terminal".

   Why: the package id in module.json (and the install folder) is
   "vtt-terminal", but earlier builds wrote journal flags and world
   settings under the namespace "terminal". Foundry namespaces flags and
   settings by the ACTIVE package id, so after the rename the code looks
   under "vtt-terminal" and can't see the old "terminal" data. This macro
   copies the old data into the new namespace.

   What it does:
     1. For every JournalEntry carrying flags.terminal.*, copy
        { enabled, id, collection, json } to flags.vtt-terminal.*.
     2. Copy the three world settings (themeClass, homeScreenId, bindings)
        from the old "terminal" namespace to "vtt-terminal".

   Safe to run more than once (it overwrites the new-namespace copies with
   the old values each time, and skips journals with no old flags). It
   does NOT delete the old "terminal" flags, so you can verify first and
   clean them up later if you wish.

   HOW TO RUN: paste into a Script macro (or the console) and execute.
   ============================================================= */

(async () => {
  const OLD = "terminal";
  const NEW = "vtt-terminal";

  if (!game.user.isGM) {
    ui.notifications.error("Run the terminal migration as a GM.");
    return;
  }

  /* ---- 1. Journal flags ---- */
  const FLAG_KEYS = ["enabled", "id", "collection", "json"];
  let migrated = 0;

  for (const journal of game.journal.contents) {
    const oldFlags = journal.flags?.[OLD];
    if (!oldFlags) continue;

    const update = {};
    for (const key of FLAG_KEYS) {
      if (oldFlags[key] !== undefined) {
        update[`flags.${NEW}.${key}`] = oldFlags[key];
      }
    }
    if (!Object.keys(update).length) continue;

    await journal.update(update);
    migrated++;
    console.log(`vtt-terminal migration | journal "${journal.name}" flags copied`, update);
  }

  /* ---- 2. World settings ---- */
  /* The old settings were registered under "terminal", which is no longer
     an active package, so game.settings.get(OLD, ...) would throw. Read
     them straight from the world Settings collection by their storage key
     ("<namespace>.<key>") instead. */
  const SETTING_KEYS = ["themeClass", "homeScreenId", "bindings"];
  let settingsCopied = 0;

  for (const key of SETTING_KEYS) {
    const storageKey = `${OLD}.${key}`;
    const doc = game.settings.storage.get("world")?.getSetting?.(storageKey)
      ?? game.settings.storage.get("world")?.find?.(s => s.key === storageKey);
    if (!doc) continue;

    let value = doc.value;
    try { value = JSON.parse(doc.value); } catch { /* value was a plain string */ }

    try {
      await game.settings.set(NEW, key, value);
      settingsCopied++;
      console.log(`vtt-terminal migration | setting "${key}" copied`, value);
    } catch (err) {
      console.warn(`vtt-terminal migration | could not set "${key}" (is it registered?)`, err);
    }
  }

  ui.notifications.info(
    `Terminal migration complete: ${migrated} journal(s), ${settingsCopied} setting(s) copied to "${NEW}". ` +
    `Reload the world (F5) to pick up the migrated data.`
  );
  console.log(`vtt-terminal migration | done — ${migrated} journals, ${settingsCopied} settings`);
})();
