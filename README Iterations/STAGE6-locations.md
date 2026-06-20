# Terminal — Locations (galaxy hierarchy)

A four-tier galaxy map: Region -> Cluster -> System -> Celestial Body. ONE
collection "location", ONE render type "location" for all tiers, distinguished by
a "tier" field. Relationships declared once on the child (parent), children
derived. Standalone for now; Black Box / Mission Log wiring is the next step.

## Two render types
- "location-directory": standalone screen, collection "location". Lists regions.
- "location": every location member. Renders description + children table +
  parent breadcrumb (+ body details).

## Member schema (all tiers share render "location")
{
  "render": "location",
  "tier": "region" | "cluster" | "system" | "body",
  "name": "...",
  "parent": "<id of the tier above>",   // omit on regions (top tier)
  "description": "...",
  "bodyType": "Garden World",            // bodies only (planet/relay/belt/etc)
  "details": [ ["Key","Value"], ... ]    // bodies only, optional keyvalue
}

## How it works
- Children are DERIVED: a screen lists all members whose parent === its id, as a
  linked table. Declare the link once (on the child); parents need no child list.
- Breadcrumb walks UP the parent chain (with a cycle guard) so you can climb back
  to the region from any depth.
- The children table header uses the child tier label; a Type column appears only
  when the children are bodies.
- Bodies show an optional details keyvalue block (gravity, atmosphere, etc).

## Setup / test
1. Directory: journal w/ screen-locations.json, Collection BLANK, id "locations".
   (Add a main-hub link to screen "locations".)
2. Members (Collection "location" each, id = the file's name slug):
   - location-attican-traverse.json  -> id "attican-traverse"
   - location-shadow-sea.json        -> id "shadow-sea"
   - location-iera.json              -> id "iera"
   - location-horizon.json           -> id "horizon"
3. Open the directory -> Attican Traverse -> Shadow Sea -> Iera -> Horizon.
   Each level shows its children table; breadcrumb climbs back up. Horizon (body)
   shows its details block and no children.

## Next: wiring (follow-up)
- Black Box movement-log location refs -> links to location/<id>.
- Mission Log structured location (sector/cluster/system/planet) -> links to
  location/<id>.
These just swap display text for nav links once the ids exist.
