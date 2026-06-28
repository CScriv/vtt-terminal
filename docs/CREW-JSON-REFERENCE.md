# Crew Dossier JSON — authoring reference

How to build a crew member for the terminal. Each crew member is one journal in
the **`crew`** collection: set its Terminal Data → Collection `crew`, id = a slug
(e.g. `matthews`), enabled. The JSON below goes in the body (dossiers aren't
written to, so they don't need flag storage).

The Crew Roster (`crew-roster`) self-generates from these members, grouped by
department; each member's detail screen renders from its own JSON.

---

## ID convention

The id is the journal flag, not the filename. Standard: **last name**, or
**last name + - + first initial** when two crew share a surname.
- `matthews`, `voss`, `markov`
- Collisions: the Ennidos brothers → `ennidos-j` / `ennidos-p`; the vas Daro pair
  → `daro-k` / `daro-m`.

Every `relationships[].target` must match the id you assign that person's journal.

---

## Minimal dossier

```json
{
  "render": "dossier",
  "title": "SSV MIDWAY SR-2 // PERSONNEL FILE",
  "tag": "SASO",
  "prompt": "DOSSIER LOADED",
  "name": "Gunner Roe",
  "role": "Ship Technician",
  "department": "Technical",
  "status": "active"
}
```

`render`, `name`, `role`, `department`, and `status` are the essentials;
everything else is optional and simply doesn't render if absent. The
`title`/`tag`/`prompt` header is the standard personnel-file framing — keep it
consistent across all dossiers.

---

## Full field reference

### Header / core

| Field | Type | Notes |
|---|---|---|
| `render` | string | Always `"dossier"`. Required. |
| `title` | string | Screen header. Standard: `"SSV MIDWAY SR-2 // PERSONNEL FILE"`. |
| `tag` | string | Header tag, e.g. `"SASO"`. |
| `prompt` | string | Sub-header prompt, e.g. `"DOSSIER LOADED"`. |
| `name` | string | Full name (shown on dossier + roster). Required. |
| `role` | string | Job/position, e.g. `"Navigator"`. |
| `department` | string | Drives roster grouping. Must match a department in the roster screen's `departments` config (see below). Required. |
| `subgroup` | string | OPTIONAL. Sub-grouping within a department (e.g. `"Alliance"` / `"Turian"` under Security, `"Thresher Maw"` under Strike Team). Must match a subgroup the roster declares for that department. |
| `status` | string | One of: `active`, `kia`, `mia`, `discharged`, `detached`. Renders as a colored flag on both dossier and roster. Required. |
| `sort` | number | OPTIONAL. Orders members within their group (lower = first). Default 999 → unsorted members fall to the end, then alphabetical by name. Use e.g. `10`, `20` to pin order. |

### Identity details

| Field | Type | Notes |
|---|---|---|
| `species` | string | e.g. `"Human"`, `"Turian"`, `"Krogan"`, `"Quarian"`, `"Asari"`. |
| `gender` | string | Free text. |
| `dateOfHire` | string | Display date, e.g. `"05 October 2186"`. |
| `nickname` | string | OPTIONAL. Short name used in COMPACT FEED contexts (likes, comments) where the full name is too long or wrong (e.g. Krogan clan-first names). Full `name` is used everywhere formal. If absent, full name is used everywhere. |

### Station bonus

```json
"stationBonus": { "label": "+1 Navigation", "system": true }
```

| Field | Type | Notes |
|---|---|---|
| `stationBonus` | object | OPTIONAL. The bonus this crew member provides at their station, shown prominently at the top of the dossier. |
| `stationBonus.label` | string | The bonus text, e.g. `"+1 Drive"`, `"Improved Medi-gel (+1 Rank)"`, `"Runs the ship bar"`. |
| `stationBonus.system` | boolean | `true` for system-station bonuses (Navigation, Drive, Weapons, etc.); `false` for non-system perks (bar, armory access, maneuvers, medi-gel). Affects styling/labeling. |

### Background

| Field | Type | Notes |
|---|---|---|
| `background` | string | Prose bio paragraph. Single string (not an array). |

### Proficiencies

```json
"proficiencies": [
  { "name": "Drive Systems" },
  { "name": "Ship Systems", "tag": "in training" }
]
```

| Field | Type | Notes |
|---|---|---|
| `proficiencies` | array of objects | OPTIONAL. Skills list. |
| `proficiencies[].name` | string | The proficiency. |
| `proficiencies[].tag` | string | OPTIONAL small label after the name (e.g. `"in training"`). |

### Relationships (cross-links to other crew)

```json
"relationships": [
  { "label": "Friend", "display": "James Markov", "target": "crew/markov" },
  { "label": "Mentor To", "display": "Jake Huntley", "target": "crew/huntley" }
]
```

| Field | Type | Notes |
|---|---|---|
| `relationships` | array of objects | OPTIONAL. Links to other crew, shown as a labelled list; each is clickable to that dossier. |
| `relationships[].label` | string | The relationship, e.g. `"Friend"`, `"Served Under"`, `"Younger Brother"`, `"Rival"`. |
| `relationships[].display` | string | The other person's name as shown. |
| `relationships[].target` | string | `crew/<id>` — must match the other member's assigned id. **Verify these resolve.** |

Relationships are declared per-dossier and are NOT auto-reciprocal — if A lists B
as a Friend, add the matching entry on B too if you want it both ways.

### Notes

```json
"notes": [
  "No friends from the service, but might have some old connections out there.",
  "Likes poker?"
]
```

| Field | Type | Notes |
|---|---|---|
| `notes` | array of strings | OPTIONAL. Misc bullet points shown in a notes block. Each string is its own line. |

---

## Department / subgroup — must match the roster

The roster screen (`crew-roster`) defines the department order and any subgroups:

```json
"departments": [
  "Administrative",
  "Systems",
  "Engineering",
  "Technical",
  "Medical",
  { "name": "Security", "subgroups": ["Alliance", "Turian"] },
  "Flight",
  { "name": "Strike Team", "subgroups": ["Thresher Maw"] }
]
```

- A dossier's `department` must match one of these names, and its `subgroup`
  (if any) must match a subgroup listed for that department.
- A department a member references but the roster doesn't list still renders —
  it's appended at the end, ungrouped — but for intended ordering, keep the
  roster's `departments` in sync with the dossiers.

### Status flag values

`active`, `kia`, `mia`, `discharged`, `detached` — each renders as a distinct
colored flag. Use lowercase.

---

## Field order (cosmetic)

Order doesn't affect function. Existing files use:
`render, title, tag, prompt, name, role, department, subgroup, status, sort,
species, gender, dateOfHire, nickname, stationBonus, background, proficiencies,
relationships, notes`.

---

## Quick checklist for a new crew member

1. `render: "dossier"`, the standard `title`/`tag`/`prompt` header.
2. `name`, `role`, `department` (+ `subgroup` if the department has them),
   `status`.
3. `species`, `gender`, `dateOfHire`.
4. `nickname` if the full name is awkward in the feed.
5. `stationBonus` if they provide one (`system` true/false).
6. `background` prose; `proficiencies`; `notes`.
7. `relationships` with `crew/<id>` targets — confirm each id exists, and add
   the reciprocal entry on the other dossier if you want it mutual.
8. Import: journal → Collection `crew`, id = slug (last name, +initial on
   collision), enabled.
