/* =============================================================
   TERMINAL — player -> dossier bindings
   -------------------------------------------------------------
   Maps a Foundry USER (by stable user id) to a crew collection
   member id, so a player's comments/likes are authored as their
   character with a correct authorId (dossier link). Also the basis
   for routing inbox messages to a player's character later.

   Storage: a world setting (terminal.bindings), a single global map:
     { "<userId>": "<crewMemberId>", ... }

   Managed via a binding UI (GM only): one row per non-GM user with a
   crew-member dropdown. No console, no hand-authoring of user ids.
   ============================================================= */

import { loadCollection } from "./data.mjs";

const MODULE_ID = "terminal";
const SETTING = "bindings";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/* ---- Read helpers ---- */

export function getBindings() {
  return game.settings.get(MODULE_ID, SETTING) ?? {};
}

/* The crew member id bound to a user (default: the current user). */
export function boundMemberId(userId = game.user.id) {
  return getBindings()[userId] ?? null;
}

/* Resolve { author, authorId } for the current user's comments/likes.
   If bound to a crew member, returns that member's display name + id
   (link-correct). Otherwise falls back to the character/user name with
   no authorId (plain text, no link). */
export function resolveSelfAuthor() {
  const memberId = boundMemberId();
  if (memberId) {
    const member = loadCollection("crew").find(m => m.id === memberId);
    if (member) {
      // Feed display uses nickname if declared, else full name.
      const display = member.data?.nickname ?? member.data?.name ?? memberId;
      return { author: display, authorId: memberId };
    }
  }
  return {
    author: game.user.character?.name ?? game.user.name,
    authorId: null
  };
}

/* ---- The binding UI ---- */

class BindingConfig extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "terminal-bindings",
    tag: "form",
    classes: ["terminal-bindings"],
    window: { title: "Terminal — Player Bindings", contentClasses: ["standard-form"] },
    position: { width: 480 },
    form: { handler: BindingConfig.#onSubmit, closeOnSubmit: true }
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/bindings.hbs` }
  };

  async _prepareContext() {
    const bindings = getBindings();
    const crew = loadCollection("crew")
      .map(m => ({ id: m.id, name: m.data?.name ?? m.id }))
      .sort((a, b) => a.name.localeCompare(b.name));

    // One row per non-GM user (players). GMs author as NPCs via the
    // crew picker, so they don't need a binding.
    const users = game.users
      .filter(u => !u.isGM)
      .map(u => ({
        id: u.id,
        name: u.name,
        boundTo: bindings[u.id] ?? ""
      }));

    return { users, crew };
  }

  static async #onSubmit(_event, _form, formData) {
    const data = foundry.utils.expandObject(formData.object);
    // data.bind is { "<userId>": "<memberId or ''>" }
    const next = {};
    for (const [userId, memberId] of Object.entries(data.bind ?? {})) {
      if (memberId) next[userId] = memberId;
    }
    await game.settings.set(MODULE_ID, SETTING, next);
    ui.notifications.info("Terminal: player bindings saved.");
  }
}

/* ---- Registration ---- */

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, SETTING, {
    name: "Player Bindings",
    scope: "world",
    config: false,           // managed through the binding UI, not the settings panel
    type: Object,
    default: {}
  });

  // A settings-menu button to open the binding UI.
  game.settings.registerMenu(MODULE_ID, "bindingsMenu", {
    name: "Player Bindings",
    label: "Configure Player Bindings",
    hint: "Map each player to the crew member they play, so their feed activity links to the right dossier.",
    icon: "fa-solid fa-user-tag",
    type: BindingConfig,
    restricted: true         // GM only
  });
});

export { BindingConfig };
