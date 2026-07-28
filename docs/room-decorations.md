# Room Decorations — Umsetzungsplan für xxscreeps

Dekorationen sind bisher ein reines MMO-Feature. Der neue Client
(`bastianh/screeps-client`) rendert sie inzwischen vollständig — Landscapes, Graffiti,
Creep- und Object-Overlays, Weltkarte, Inventar und Platzierungs-Dialog — aber nur gegen den
offiziellen Server. Dieses Dokument beschreibt, was xxscreeps braucht, um denselben Vertrag zu
bedienen, und in welcher Reihenfolge das gebaut wird.

Der Client ist die Referenz für alle Datenformate; sein Stand ist in
`screeps-client/docs/project/room-decorations-gap-analysis.md` dokumentiert.

---

## 1. Der Vertrag, den der Client erwartet

| Baustein | Client-Seite | xxscreeps heute |
| --- | --- | --- |
| `GET /api/user/decorations/inventory` → `{ ok, list: Item[] }` | `screeps-connectivity/src/http/endpoints/user.ts:108` | Stub, `list: []` (`backend/endpoints/user/index.ts:23`) |
| `GET /api/user/decorations/themes` → `{ ok, list: Theme[] }` | ebd. `:109` | Stub, `list: []` (`backend/endpoints/user/index.ts:13`) |
| `POST /api/user/decorations/activate` `{ _id, active }` | ebd. `:110` | fehlt |
| `POST /api/user/decorations/deactivate` `{ decorations: string[] }` | ebd. `:111` | fehlt |
| `GET /api/game/room-decorations?room=&shard=` → `{ ok, decorations: Item[] }` | `endpoints/game.ts:79` | Stub, `decorations: []` (`backend/endpoints/game/room.ts:4`) |
| `decorations[]` im Room-Tick des Sockets `room:<shard>/<room>` | `stores/RoomStore.ts:206` | fehlt |
| `stat.decorations[]` + Top-Level-`decorations`-Dictionary in `map-stats` | `stores/MapStatsStore.ts:170` | fehlt |
| Feature-Flag `inventory` in `/api/version` → `serverData.features` | `screeps-client/src/stores/capabilities.ts:43` | fehlt |
| `GET /api/user/rooms?reservation` | `endpoints/user.ts:33` | vorhanden (`mods/classic/controller/backend.ts:80`) |

Die drei Datentypen (alle in `screeps-connectivity/src/types/api.ts`):

- **Definition** (`ApiRoomDecorationDef`) — der Katalogeintrag: `_id`, `type`, `name`, `rarity`,
  `theme`, `restricted`, `groupDescription`, `preview`, `props` (Schema der editierbaren
  Eigenschaften), `graphics[]`, `foregroundUrl`, `floorForegroundUrl`, `tiling`, `tileScale`,
  `objectType`.
- **Active** (`ApiRoomDecorationActive`) — die vom Nutzer gewählten Werte plus Ziel
  (`shard`, `room`) und `world` (auf der Karte sichtbar). Zahlen dürfen als Strings kommen,
  Listen sind `!SEP!`-getrennte Strings, `rotation` ist Radiant.
- **Item** — `{ _id, user, active, decoration }` im Raum, `{ _id, createdAt, activatedAt,
  active, decoration }` im Inventar. `active: null` heißt „im Besitz, nicht platziert".

Unterstützte Typen: `floorLandscape`, `wallLandscape`, `landscape` (beides zugleich),
`wallGraffiti`, `creep`, `object`. `metadata` und `badge` rendert der Client nicht — die
lassen wir außen vor.

---

## 2. Was xxscreeps mitbringt

- **Mod-System** mit den passenden Hooks: `route`, `roomSocket`, `mapStats`, `version`,
  `backendReady`, `middleware` (`backend/symbols.ts:32`).
- **Account-Store** `db.data` (shard-übergreifend) für Nutzerdaten, wie ihn `messages` und
  `notifications` schon nutzen.
- **Kein** Bedarf an Room-Blob-Schema: Dekorationen sind keine `RoomObject`s. Sie kosten
  keine Bytes im Blob und werden nicht vom Processor angefasst.
- **Raumbesitz** steht in `shard.scratch` unter `controlledRoomsKey` / `reservedRoomsKey`
  (`mods/classic/controller/model.ts:5`) — die Validierung beim Aktivieren kann das direkt lesen.
- `Id.generateId()` (`engine/schema/id.ts`) erzeugt Mongo-förmige Hex-Ids, wie sie der
  Client als `_id` erwartet.

---

## 3. Architekturentscheidungen

### 3.1 Ein eigener Mod: `xxscreeps/mods/meta/decorations`

Dekorationen sind ein Account-Feature wie `messages` und gehören nach `mods/meta/`.

```
mods/meta/decorations/
  index.ts       Manifest — dependencies: [ 'xxscreeps/mods/classic/controller' ],
                 provides: [ 'backend', 'test' ]
  catalog.ts     Katalog laden, validieren, Asset-URLs auflösen
  model.ts       Persistenz (Besitz + Aktivierung), Registry, Channel
  backend.ts     Routen, roomSocket-, mapStats- und version-Hook
  pack/          mitgelieferter Standard-Katalog (siehe 3.3)
  test.ts
```

Abhängigkeit auf `classic/controller`, weil die Aktivierung Raumbesitz prüft. Eingetragen wird
der Mod in `mods/classic/index.ts` (der Aggregator, der auch die anderen `meta`-Mods zieht),
damit Standardserver ihn ohne Config-Änderung bekommen.

**Die Stubs in `backend/endpoints/user/index.ts` und `backend/endpoints/game/room.ts` werden
gelöscht.** `installEndpointHandlers` (`backend/endpoints/index.ts:14`) registriert Core-Routen
vor Mod-Routen; eine zweite Registrierung auf denselben Pfad würde still verschluckt. Zwei
Besitzer für einen Pfad ist genau die „muddy ownership", die die Repo-Konventionen verbieten.
Server ohne den Mod antworten dann mit 404 — der Client verträgt das: `inventory` und `themes`
sind als `silent` markiert (`endpoints/user.ts:107`), und der Raum-Fetch fängt Fehler ab
(`RoomViewer.tsx:154`). Ohne Feature-Flag `inventory` zeigt er den Inventarbereich ohnehin nicht.

### 3.2 Persistenz: Besitz und Aktivierung getrennt

Alles in `db.data` (Account-Ebene, shard-übergreifend — `active.shard` sagt, wohin es zeigt):

```
user/<userId>/decorations        hash: itemId → { def, createdAt, activatedAt, active }
decorations/rooms/<shard>/<room> set:  itemId          — Index für Raum- und Kartenabfragen
decorations/global               set:  itemId          — creep-Dekorationen (ohne Raum)
decorations/item/<itemId>        hash: { user, def, active }  — Rückwärtsauflösung für den Index
```

Das Item-Dokument steht doppelt (im Nutzer-Hash und unter `decorations/item/…`) — bewusst: der
Inventar-Endpunkt liest genau einen Hash, die Raumabfrage genau einen Set plus N Hashes, und
keiner der beiden Pfade muss über fremde Nutzer iterieren. Geschrieben wird nur an einer Stelle
(`model.ts`), die beide Seiten in einem Rutsch aktualisiert.

### 3.3 Katalog: Definitionen als statische Daten

Definitionen sind keine Nutzerdaten. Sie kommen aus einem **Decoration Pack**:

```
pack/
  pack.json     { themes: Theme[], decorations: Definition[] }
  assets/…      PNG/SVG, relativ aus pack.json referenziert
```

- Der Mod bringt ein Standard-Pack mit. Zusätzliche Packs werden über
  `.screepsrc.yaml` (`decorations.packs: [ path… ]`) geladen.
- Geladen und mit ajv validiert wird beim Start (`backendReady`). Unbekannter `type`, fehlendes
  Asset, doppelte `_id` → Exception beim Start. Kein stilles Überspringen.
- Asset-Pfade werden beim Laden auf `<publicUrl>/assets/decorations/<pack>/<datei>` umgeschrieben
  und von einer Route des Mods ausgeliefert (ETag + `immutable`, Pfad-Traversal-Schutz; das
  Vorbild ist `xxscreeps-mod-client/backend.js`). Same-Origin heißt: der Dev-Proxy-Hack, den der
  Client für `s3.amazonaws.com` braucht (`renderer/decorationTextures.ts`), entfällt hier.
- **Keine offiziellen Screeps-Assets ins Repo.** Die S3-Grafiken gehören Screeps. Das
  Standard-Pack besteht aus selbst erstellten Inhalten.

Praktischer Nebeneffekt: `floorLandscape`/`wallLandscape` funktionieren **ohne jedes Asset** —
sie sind reine Farbwerte (`floorBackgroundColor`, `swampColor`, `backgroundColor`, `strokeColor`,
…). Das Standard-Pack kann also mit null Binärdateien starten; Texturen und Graffiti kommen
später dazu.

### 3.4 Nachschlagen: In-Memory-Registry im Backend

`map-stats` fragt hunderte Räume auf einmal ab. Ein Keyval-Roundtrip pro Raum ist dafür zu teuer,
und aktive Dekorationen sind wenige und ändern sich selten.

Deshalb hält der Backend-Prozess eine Registry: `Map<shard/room, Item[]>` plus die globale Liste,
befüllt bei `backendReady` aus dem Keyval-Store und aktualisiert über einen `Channel`
(`engine/db/channel.js`), auf dem Activate/Deactivate publiziert. Keyval bleibt die Wahrheit,
die Registry ist nur der Lesepfad — und sie gehört ausschließlich `model.ts`.

### 3.5 Was wir *nicht* bauen

- Steam-Inventar, Xsolla-Store, `steamItemDefId` — für einen privaten Server bedeutungslos.
- `metadata`- und `badge`-Dekorationen — der Client rendert sie nicht.
- Pixelization/Convert als Ökonomie — siehe Phase 6, bewusst ans Ende und optional.

---

## 4. Phasen

### Phase 1 — Katalog, Inventar, Feature-Flag ✅ erledigt

*Ziel: der Inventarbereich des Clients erscheint und zeigt Items an. Noch nichts ist platzierbar.*

- ✔ Mod `mods/meta/decorations` (`backend`, `test`), eingetragen in `mods/classic/index.ts`.
- ✔ `catalog.ts`: Pack-Format samt ajv-Schema, Laden, Validieren, Asset-Auflösung. Unbekannter
  Typ, fehlendes Asset, hängende Theme- oder Prop-Referenz, doppelte Id, Asset außerhalb des
  Pack-Verzeichnisses oder mit nicht renderbarem Dateityp → Fehler beim Start.
- ✔ Standard-Pack `pack/pack.json`: zwei Themes, vier reine Farb-Landscapes (Floor, Walls, Neon
  Floor, Neon Room). Keine Binärdateien — Landscapes brauchen keine.
- ✔ `model.ts`: Besitz in `db.data`, `grant()` / `revoke()` / `listForUser()`, `User.remove`-Hook.
- ✔ Routen `inventory` und `themes`, Asset-Route `/assets/decorations/…` (serviert nur Dateien,
  die im Katalog referenziert sind — der Request nennt einen Map-Key, nie einen Pfad).
- ✔ Core-Stubs für `inventory`/`themes` entfernt; der Mod ist alleiniger Besitzer der Pfade.
- ✔ `version`-Hook meldet `{ name: 'inventory', version: 1 }`. Nebenbei ist der Hook jetzt auf
  `ServerData` typisiert statt auf `Record<string, unknown>`, damit `features` ohne Cast erreichbar ist.
- ✔ `xxscreeps manage decoration <catalog|list|grant|revoke>`.
- ✔ Config `decorations.{builtin,grantAll,packs,assetBaseUrl}`; `grantAll` standardmäßig an.
- ✔ 15 Tests (`test.ts`), Pack-Doku in `mods/meta/decorations/README.md`.

**Entschieden:** `grantAll` (Standard) macht den ganzen Katalog für jeden verfügbar — ohne
Ops-Aufwand nutzbar. Explizite Grants werden trotzdem gespeichert und greifen, sobald das Flag
aus ist. Sie zusätzlich zum impliziten Besitz anzuzeigen wäre doppelt, deshalb gilt: `grantAll`
an → Katalog, `grantAll` aus → nur Vergebenes.

**Bewusst offen:** Pixel-Ökonomie als Erwerbsweg (Phase 6).

### Phase 2 — Aktivieren und Deaktivieren

*Ziel: der Platzierungs-Dialog des Clients funktioniert Ende zu Ende.*

- `POST activate`: Item gehört dem Nutzer, Ziel-Shard existiert, Raumname ist gültig, Raum ist
  vom Nutzer kontrolliert oder reserviert (`controlledRoomsKey`/`reservedRoomsKey`, aus
  `shard.scratch`; abschaltbar über `decorations.requireRoomOwnership`, Standard an).
- Props gegen das Definitions-Schema validieren: Bereichsgrenzen, Farbformat `#rrggbb`,
  Längenlimits für Strings, unbekannte Props werden abgelehnt. Ein ungültiger Wert ist ein
  Fehler, kein stiller Default.
- Kollisionsregeln serverseitig spiegeln (Client: `components/inventory/activation.ts`):
  `landscape` blockiert `floorLandscape` *und* `wallLandscape` im selben Raum, `object` nur
  gegen sich selbst, `wallGraffiti` ungeprüft. Geprüft wird pro Nutzer und Raum.
- `creep`-Dekorationen sind global — kein Raum, kein Besitzcheck, Eintrag in
  `decorations/global`.
- Ein bereits aktives Item neu zu aktivieren ersetzt die Platzierung (der Client verlässt sich
  darauf: er deaktiviert vor dem Umsetzen, `screeps-client` Commit 764b871).
- `POST deactivate`: Nur eigene Items, Index und Registry aufräumen, Channel publizieren.

### Phase 3 — Auslieferung an die Raumansicht

*Ziel: platzierte Dekorationen sind im Raum sichtbar, live.*

- `GET /api/game/room-decorations`: Registry-Lookup für `<shard>/<room>` plus die globalen
  `creep`-Items, jeweils zu `{ _id, user, active, decoration }` aufgelöst (volle Definition,
  wie der Client sie erwartet).
- `roomSocket`-Hook: Der Hook liefert pro Tick ein Objekt, das in die Tick-Nachricht gemerged
  wird (`backend/sockets/room.ts:205`). Wir schicken `decorations` **nur bei Änderung** — die
  Registry führt dafür einen Versionszähler pro Raum. Der Client merged nach `_id` und behält
  seine Array-Referenz, wenn sich nichts ändert; jeden Tick dieselbe Liste zu schicken wäre
  trotzdem verschwendete Bandbreite.
- Damit funktionieren automatisch auch `wallGraffiti`, `creep` und `object` — der Client hat
  die Renderpfade bereits, sie brauchen nur Daten (siehe Phase 3 der Gap-Analyse).

### Phase 4 — Weltkarte

*Ziel: Dekorationen färben die Karte, wie auf dem offiziellen Server.*

- `mapStats`-Hook: pro Raum `stats.decorations = [{ _id, user, decoration: <defId>, active }]`,
  gefiltert auf `active.world`; `userIds.add(user)`.
- Die referenzierten Definitionen in `payload.response.decorations` als Dictionary
  `id → { type, graphics, tiling, foregroundUrl, floorForegroundUrl }` — der reduzierte Shape,
  den `MapStatsStore.buildRoomDecorations()` erwartet (`stores/MapStatsStore.ts:170`). Ohne
  dieses Dictionary fällt der Client auf Feld-Heuristik zurück; mit ihm wird die Erkennung
  typbasiert.

### Phase 5 — Tests und Doku

Läuft mitlaufend, hier zusammengefasst, was mindestens abgedeckt sein muss:

- Katalog: ungültiges Pack schlägt beim Laden fehl; Asset-URLs korrekt aufgelöst.
- Aktivierung: Besitz, Raumbesitz, Kollisionsregeln, Prop-Validierung, Ersetzen.
- Registry: Channel-Update hält zwei Backend-Prozesse konsistent.
- Raum-Endpunkt und `mapStats`-Payload gegen die Client-Typen (die Formen aus
  `screeps-connectivity/src/mocks/roomDecorations.ts` sind die beste Vorlage).
- `README`-Abschnitt zum Pack-Format und zu `xxscreeps manage decoration`.

### Phase 6 — Optional, später

- Pixel-Ökonomie: `PIXEL` gibt es bereits (`mods/intershardResource/constants.ts:3`).
  `POST /api/user/decorations/pixelize` (Zufallsziehung gegen Pixel) und `…/convert`
  (Item → Pixel) wären damit baubar. Nur sinnvoll, wenn der Server Pixel-Wirtschaft fährt.
- Rarität als echte Ziehungsgewichtung statt nur als Anzeigewert.
- `metadata`/`badge`, falls der Client sie je unterstützt.

---

## 5. Client-seitige Restarbeiten

Der Client ist praktisch fertig; erwartet wird nur:

1. Ein Blick darauf, ob der Inventar-Refetch nach `activate`/`deactivate` sauber greift, sobald
   ein echter Server antwortet (bisher nur gegen Mock getestet).
2. Eventuell den Texturlader vereinfachen, wenn Assets same-origin kommen — der Dev-Proxy-Pfad
   für `s3.amazonaws.com` bleibt für den offiziellen Server nötig, ist für xxscreeps aber
   überflüssig.

---

## 6. Reihenfolge in einem Satz

Katalog + Inventar sichtbar machen (Phase 1) → platzierbar machen (Phase 2) → im Raum
ausliefern (Phase 3) → auf die Karte bringen (Phase 4). Jede Phase ist für sich lauffähig und
im Client sichtbar.
