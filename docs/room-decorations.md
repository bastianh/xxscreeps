# Room Decorations

Decorations are the cosmetic overlays a player places in their rooms. Official Screeps ships them
as an MMO feature; this document tracks what xxscreeps needs to serve the same contract, and in
what order it is built.

The web client is the reference for every data format.

## The contract

| Piece | xxscreeps |
| --- | --- |
| `GET /api/user/decorations/inventory` → `{ ok, list: Item[] }` | done |
| `GET /api/user/decorations/themes` → `{ ok, list: Theme[] }` | done |
| Feature flag `inventory` in `/api/version` → `serverData.features` | done |
| `POST /api/user/decorations/activate` `{ _id, active }` | done |
| `POST /api/user/decorations/deactivate` `{ decorations: string[] }` | done |
| `GET /api/game/room-decorations?room=&shard=` → `{ ok, decorations: Item[] }` | core stub returns `[]` |
| `decorations[]` in the room tick of the `room:<shard>/<room>` socket | missing |
| `stat.decorations[]` plus a top-level `decorations` dictionary in `map-stats` | missing |
| `GET /api/user/rooms?reservation` | already served by the controller mod |

Three data types:

- **Definition** — the catalog entry: `_id`, `type`, `name`, `rarity`, `theme`, `groupDescription`,
  `preview`, `props` (schema of the editable properties), `graphics[]`, `foregroundUrl`,
  `floorForegroundUrl`, `tiling`, `tileScale`, `objectType`.
- **Active** — the values the player chose plus the target (`shard`, `room`). Numbers may arrive as
  strings, lists are `!SEP!`-joined strings, `rotation` is radians. `world` is an ordinary boolean
  property, and it decides whether the decoration shows on the map.
- **Item** — `{ _id, user, active, decoration }` in a room, `{ _id, createdAt, activatedAt, active,
  decoration }` in the inventory. `active: null` means "owned, not placed".

Supported types: `floorLandscape`, `wallLandscape`, `landscape` (both at once), `wallGraffiti`,
`creep`, `object`. The client renders neither `metadata` nor `badge`, so neither is implemented.

## Architecture

The mod lives in `mods/meta/decorations` and is registered from `mods/classic/index.ts`, so a
default server gets it without touching any config. It depends on `mods/classic/controller`,
because placing a decoration checks that the player holds the room.

Decorations are not `RoomObject`s: they cost no bytes in a room blob and the processor never
touches them. Everything is account state in `db.data`, with `active.shard` naming the target.

Core stubs on a path the mod serves are deleted rather than left in place. `installEndpointHandlers`
registers core routes before mod routes, so a second registration on the same path is silently
swallowed — two owners for one path is exactly the muddy ownership the repo conventions forbid. A
server running without the mod answers 404, which the client tolerates: `inventory` and `themes` are
marked silent, the room fetch catches errors, and without the `inventory` feature flag the client
does not show the section at all.

### Storage

```
user/<userId>/decorations                   set:  itemIds with a stored grant
user/<userId>/decorations/<itemId>          hash: { def, createdAt }
user/<userId>/decorations/<itemId>/active   hash: { activatedAt, shard, room, prop/<name>… }
user/<userId>/decorations/active            set:  itemIds this user has placed
decorations/<shard>/<room>                  set:  `userId/itemId` placed in one room
decorations/global                          set:  `userId/itemId` of the creep decorations
```

Each fact gets its own hash field. Property values are prefixed `prop/` so a pack may declare a
property called `room` without colliding with the placement's own fields, and they are decoded back
to their declared types on read — the definition is the authority in both directions.

The per-user `active` set exists because `grantAll` makes the inventory as large as the catalog;
without it, listing an inventory would ask after a placement for every definition on the server.

There is deliberately **no** duplicate item document. An earlier draft of this plan stored the item
twice — once under the user, once under `decorations/item/<itemId>` — to make room queries cheap.
Two writers for one fact is worth more than it saves, and the in-memory registry below solves the
same problem without splitting ownership.

### Catalog

Definitions are static data loaded from *decoration packs* (`pack.json` plus the images it
references), validated with ajv at startup. Anything wrong — unknown type, missing asset, dangling
theme, duplicate id, a colour property seeded with something that is not `#rrggbb` — throws while
loading. Asset paths are rewritten to `assets/decorations/<pack>/<file>` and served by the mod.

Asset urls are document-relative by default, which is what survives a proxy serving the client under
a path prefix. `decorations.assetBaseUrl` overrides that with an absolute origin.

No official Screeps assets in the repo — the S3 artwork belongs to Screeps. The bundled pack is
original content, and it needs no binary files at all: landscapes are pure colour, so their
inventory previews are drawn as svg from the definition's own property defaults.

### Reading placements

`map-stats` asks after hundreds of rooms at once, so a keyval round trip per room is too expensive
once decorations are on the map. Active decorations are few and change rarely, so the backend will
hold a registry — `Map<shard/room, Item[]>` plus the global list — filled at `backendReady` and
kept current over a `Channel` that activate/deactivate publishes on. Keyval stays the truth; the
registry is only the read path, and it belongs to `model.ts` alone.

This is not built yet. `listForRoom` reads the index directly, which is correct and fast enough for
the room endpoint; the registry is what Phase 4 needs.

## Phases

### Phase 1 — catalog, inventory, feature flag *(done)*

Mod skeleton, pack format and loader, the bundled pack, generated landscape previews, ownership,
the `inventory` and `themes` routes, the asset route, the `inventory` feature flag with the menu
entry that carries its client route, `xxscreeps manage decoration <catalog|list|grant|revoke>`, and
a `User.remove` hook that tears down a deleted user's decorations.

`decorations.grantAll` (default on) hands the whole catalog to everybody, which is the setup a
private server wants — decorations as a customisation option rather than something to earn. The
inventory is then synthesised from the catalog and items carry no stored grant, so their ids name
the decoration directly. Explicit grants are still written and surface once the flag is off.

### Phase 2 — activate and deactivate *(done)*

`POST activate` / `POST deactivate`, with the placement rules:

- The item is owned — including implicitly, under `grantAll`.
- The target shard is this one and the room exists.
- The player controls or reserves the room, unless `decorations.requireRoomOwnership` is off.
- Property values are checked against the definition: range bounds, `#rrggbb` colours, string
  length, unknown properties rejected. An invalid value is an error, never a silent default.
  Omitted properties fall back to the definition's seed, so a stored placement is always complete.
- Collisions are mirrored server-side: `landscape` blocks `floorLandscape` and `wallLandscape` in
  the same room, `object` only argues with another `object` decorating the same `objectType`,
  `wallGraffiti` stacks freely. Checked per user and room.
- `creep` decorations are global — no room, no ownership check, indexed under `decorations/global`.
- Activating an already-placed item moves it. The client depends on this when repositioning.

### Phase 3 — the room view

- `GET /api/game/room-decorations`, and **delete the core stub** in `backend/endpoints/game/room.ts`.
- A `roomSocket` hook. The hook returns a per-tick function whose object is merged into the tick
  message, so returning `{ decorations }` is all it takes. Send it only when it changes — the
  registry carries a version per room for that.
- This lights up `wallGraffiti`, `creep` and `object` at the same time: the client already has those
  render paths and only lacks data.

### Phase 4 — the world map

- A `mapStats` hook: per room `stats.decorations = [{ _id, user, decoration: <defId>, active }]`,
  filtered to placements whose `world` property is set, adding each owner to `userIds`.
- The referenced definitions go in the top-level response as a dictionary
  `id → { type, graphics, tiling, foregroundUrl, floorForegroundUrl }`. Without it the client falls
  back to guessing from fields; with it the detection is type-based.

### Later, if ever

Pixel economy (`PIXEL` already exists), rarity as real draw weighting rather than a display value,
and `metadata`/`badge` if the client ever renders them. None of it matters for a private server, so
none of it is scheduled.
