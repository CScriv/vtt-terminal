# Terminal — Stage 4 (crew): collections, roster, dossiers

Crew is a COLLECTION: each member is its own flagged journal, and the roster
discovers them and generates itself. Add a crew member = create one journal.

## New flag: collection
Journals now support an optional flags.terminal.collection. The Terminal Data
config form has a new "Collection" field:
- Standalone screen (hub, roster, blackbox): leave Collection BLANK, set ID.
- Collection member (a dossier): set Collection = "crew", ID = member id
  (e.g. "matthews").

## Two render types
- "crew-roster": a standalone screen (Collection blank, id "crew"). Its JSON
  declares the collection it lists ("collection": "crew") and the department
  order. The engine finds all crew-collection journals, reads their header
  fields, groups by department/subgroup, and renders the index. Rows navigate
  to dossiers.
- "dossier": each crew member journal. Renders the full member detail. The
  roster only reads header fields (name, role, department, status, sort,
  subgroup); the dossier renders everything.

## Parameterized navigation
Targets are now either:
- "missions"        -> standalone screen
- "crew/matthews"   -> collection member (collection "crew", id "matthews")
Relationship links in a dossier use targets like "crew/markov" to jump between
dossiers. The roster builds "crew/<id>" targets automatically.

## Member JSON schema (dossier)
{
  "render": "dossier",
  "name": "...", "role": "...", "department": "...", "status": "active",
  "subgroup": "Turian",            // optional; nests under its department
  "sort": 10,                       // order within group (lower first)
  "species": "...", "gender": "...", "dateOfHire": "...",
  "stationBonus": { "label": "+1 Navigation", "system": true },  // optional
  "background": "...",                                            // optional
  "proficiencies": [ { "name": "X", "tag": "in training" } ],     // optional
  "relationships": [ { "label": "Friend", "display": "Name", "target": "crew/id" } ], // optional, target optional
  "notes": [ "..." ]                                             // optional
}
Roster reads: name, role, department, status, sort, subgroup. Optional blocks
omit cleanly when absent.

## Roster screen JSON
{
  "render": "crew-roster",
  "title": "...", "tag": "SASO", "prompt": "...",
  "collection": "crew",
  "departments": [
    "Administrative",
    { "name": "Security", "subgroups": ["Alliance", "Turian"] }
  ]
}
Departments render in this order. A member whose department isn't listed is
appended at the end (nobody silently vanishes). A member whose subgroup isn't
listed gets an ad-hoc subgroup.

## Setup / test
1. Roster screen: journal with sample-data/screen-crew.json in a code block.
   Terminal Data -> Collection BLANK, ID "crew", Live. (Your main hub already
   links CREW ROSTER -> screen "crew".)
2. Dossiers: one journal each for crew-matthews / crew-markov / crew-domitus.
   Terminal Data -> Collection "crew", ID "matthews" / "markov" / "domitus",
   Live.
3. Open terminal -> CREW ROSTER. You should see collapsible departments
   (Systems, Security w/ Turian subgroup, plus Engineering appended since it's
   not in the sample order). Click Matthews -> his dossier. Click "James Markov"
   in his relationships -> Markov's dossier. BACK / MAIN TERMINAL return.
4. The Domitus relationship links to crew/taniso, which doesn't exist -> clean
   not-found error state. Proves graceful missing-member handling.

## Version-sensitive
- handlebars.loadTemplates for partials incl. the named status-flag partial
  (terminalStatusFlag). If status flags or partials don't render, check that
  registration in _preFirstRender.
- Native <details> collapsibles render in the app window (proven in journals).

## Next
Remaining layouts as render types + partials: missions (board + detail),
intranet feed, requisitions, crew requests, black box table, datapad. Each
follows this same collection-or-screen + render-type + partial pattern.
