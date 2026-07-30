# Decorations

Room decorations — the cosmetic overlays a player places in their rooms. This mod owns the
*catalog* (which decorations a server offers) and *ownership* (who has which of them).

Placing decorations, rendering them in rooms and painting them on the world map are not
implemented yet; see `docs/room-decorations.md` for the plan.

## Decoration packs

A pack is a `pack.json` plus, optionally, the images it references:

```
my-pack/
  pack.json
  art/wall.png
```

```json
{
  "name": "my-pack",
  "themes": [ { "_id": "my-theme", "name": "My Theme", "color": "#8f8f8f" } ],
  "decorations": [ {
    "_id": "my-walls",
    "type": "wallLandscape",
    "name": "My Walls",
    "theme": "my-theme",
    "rarity": 2,
    "foregroundUrl": "art/wall.png",
    "props": {
      "backgroundColor": { "type": "color", "label": "Wall", "default": "#111111" },
      "world": { "type": "boolean", "label": "Show on the world map", "default": true }
    }
  } ]
}
```

- `type` is one of `floorLandscape`, `wallLandscape`, `landscape` (both at once), `wallGraffiti`,
  `creep` or `object`.
- `props` describes what a player may edit, and seeds the values when a decoration is placed. The
  names are the ones the client reads: `floorBackgroundColor`, `swampColor`, `roadsColor`,
  `backgroundColor`, `strokeColor`, `strokeWidth`, … A `world` property controls whether the
  decoration also shows on the world map.
- `graphics[]` entries reference properties by *name*: `{ "url": "art/x.png", "color": "myColor" }`
  tints the image with whatever the player picked for `myColor`.
- `layout` holds the placement constraints (`proportional`, `minWidth`, `maxWidth`, `minHeight`,
  `maxHeight`).
- Asset references are either external urls (`https://…`, `data:…`, `/…`) or paths inside the pack.
  Pack-local files are checked when the server starts and served from
  `assets/decorations/<pack>/<path>`. That url is handed to the client relative to the document, not
  rooted at `/`, because a proxy may serve the client under a path prefix — the steamless client
  mounts a backend at `/(http://host:21025)/`, and a rooted url would escape it. Set
  `decorations.assetBaseUrl` when the assets need an absolute url instead.
- `preview` is what the client's inventory shows, as `original`, `128x128` and `256x256`. A landscape
  that declares none gets an svg drawn from its own colours, so a colour-only pack needs no image
  files at all. Declaring a `preview` replaces the drawing. Types with artwork of their own —
  `wallGraffiti`, `creep`, `object` — are never drawn for; give them a `preview`. Note that the
  official client sanitizes these urls: a `data:` preview only survives as one of the raster types
  Angular allows, never as `data:image/svg+xml`. Pack-local files and http urls are always fine.

Anything wrong with a pack — an unknown type, a missing asset, a dangling theme or property
reference, a duplicate id, a colour property seeded with something that is not `#rrggbb` — fails the
server at startup rather than handing the client something it cannot render.

## Configuration

```yaml
decorations:
  # Load the pack bundled with the server. Default: true
  builtin: true
  # Every user owns the whole catalog. Default: true
  grantAll: true
  # Extra packs, as a path to a pack.json or the directory holding one
  packs: [ ./my-pack ]
  # Only needed when the client is served from another origin than the backend
  assetBaseUrl: https://screeps.example.com
```

## Handing out decorations

With `grantAll` (the default) there is nothing to do — everybody owns everything. With it off:

```sh
xxscreeps manage decoration catalog
xxscreeps manage decoration grant  <name|id> <decorationId>
xxscreeps manage decoration list   <name|id>
xxscreeps manage decoration revoke <name|id> <itemId>
```

Grants are stored either way, so turning `grantAll` off later leaves each user with exactly what
they were given.
