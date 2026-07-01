# Angular Client Stats Design

Dieses Dokument beschreibt, welche Statistikdaten der Legacy-Angular-Client unter
`/Users/bastianh/Development/screeps-client/reference/angular` erwartet:

- welche Seiten Statistiken anzeigen
- welche Endpunkte dafür relevant sind
- welche Query-/Body-Parameter verwendet werden
- welche Datenstrukturen der Client erwartet
- welche Stat-Namen und Zeitauflösungen unterstützt werden
- an welchen Stellen der aktuelle Private-Server-Code noch Platzhalter liefert

Der Fokus liegt auf den klassischen Screeps-Statistiken:

- `energyControl`
- `energyHarvested`
- `energyConstruction`
- `energyCreeps`
- `creepsProduced`
- `creepsLost`
- `powerProcessed`

## Quellen

Client:

- `/Users/bastianh/Development/screeps-client/reference/angular/components/common/profile-stats/profile-stats.html`
- `/Users/bastianh/Development/screeps-client/reference/angular/components/profile/profile.html`
- `/Users/bastianh/Development/screeps-client/reference/angular/components/game/overview/overview.html`
- `/Users/bastianh/Development/screeps-client/reference/angular/components/game/overview/room/overview-room.html`
- `/Users/bastianh/Development/screeps-client/reference/angular/components/game/world-map/world-map.html`
- `/Users/bastianh/Development/screeps-client/reference/angular/app2/main.js`

Backend:

- [docs/backend-local-endpoints.md](/Users/bastianh/Development/screeps-server-monorepo/docs/backend-local-endpoints.md:88)
- [packages/backend-local/lib/game/api/user.js](/Users/bastianh/Development/screeps-server-monorepo/packages/backend-local/lib/game/api/user.js:371)
- [packages/backend-local/lib/game/api/game.js](/Users/bastianh/Development/screeps-server-monorepo/packages/backend-local/lib/game/api/game.js:186)
- [packages/backend-local/lib/game/api/game.js](/Users/bastianh/Development/screeps-server-monorepo/packages/backend-local/lib/game/api/game.js:583)

## Begriffe

Dieses Dokument unterscheidet zwei Ebenen:

- Raw API Response: das JSON, das der Backend-Endpunkt direkt zurückgibt
- Client View-Model: die Struktur, wie der Angular-Client die Daten im Scope/Controller nutzt

An mehreren Stellen ist der Client-View-State verschachtelt unter:

- `Profile.data`
- `GameOverview.data`
- `GameOverviewRoom.data`
- `WorldMap.roomStats`

Das bedeutet nicht zwingend, dass der jeweilige HTTP-Endpunkt exakt diese Struktur liefert. Ein Teil wird clientseitig zusammengebaut.

## Unterstützte Zeitauflösungen

Der Angular-Client unterstützt für diese Statistiken genau drei Intervalle:

- `8` = letzte `1 hour`
- `180` = letzte `24 hours`
- `1440` = letzte `7 days`

Verwendet in:

- Profilseite: `[{8: 'Last 1 hour'}, {180: 'Last 24 hours'}, {1440: 'Last 7 days'}]`
- Overview: `1 hour`, `24 hours`, `7 days`
- Room Overview: `1 hour`, `24 hours`, `7 days`
- World Map Layer: `<statName>8`, `<statName>180`, `<statName>1440`

Es gibt im Legacy-Angular-Client keine Monatsauflösung für diese Detailstatistiken.

## Unterstützte Stat-Namen

Die relevanten Stat-Namen werden im Client an mehreren Stellen explizit aufgelistet:

- `energyControl`
- `energyHarvested`
- `energyConstruction`
- `energyCreeps`
- `creepsProduced`
- `creepsLost`
- `powerProcessed`

Die Semantik im Client:

- `energyControl`: Control points
- `energyHarvested`: geharvestete Energie
- `energyConstruction`: Energie für Bau/Reparatur
- `energyCreeps`: Energie für Spawn/Renew
- `creepsProduced`: produzierte Bodyparts
- `creepsLost`: verlorene Bodyparts
- `powerProcessed`: verarbeitete Power

## Seiten und erwartete Daten

### 1. Profilseite

Template:

- `/components/profile/profile.html`
- `/components/common/profile-stats/profile-stats.html`

Angezeigt wird:

- Benutzername, Badge, Steam-Link
- GCL/GPL
- Saisonale Leaderboard-Werte
- Statistik-Kacheln
- Room-Previews

Statistik-relevant:

- Intervall-Selector vorhanden
- Gerendert wird das Widget `app-profile-stats`
- Datenquelle im Template: `Profile.data.stats`

Verwendete Struktur im Client View-Model:

```json
{
  "Profile": {
    "statInterval": 8,
    "data": {
      "stats": {
        "energyControl": 0,
        "energyHarvested": 0,
        "energyConstruction": 0,
        "energyCreeps": 0,
        "creepsProduced": 0,
        "creepsLost": 0,
        "powerProcessed": 0
      },
      "rooms": {
        "shard0": ["W1N1", "W1N2"]
      }
    }
  }
}
```

Wichtig:

- Die Profilseite zeigt keine Punchcard-Zeitreihen.
- Trotz Intervall-Dropdown zeigt das Template nur aggregierte Kachelwerte.
- Das spricht dafür, dass `GET /api/user/stats?interval=...` bereits aggregierte Werte pro Intervall liefern soll.

Erwartete Kachelstruktur:

```json
{
  "stats": {
    "energyControl": "number",
    "energyHarvested": "number",
    "energyConstruction": "number",
    "energyCreeps": "number",
    "creepsProduced": "number",
    "creepsLost": "number",
    "powerProcessed": "number"
  }
}
```

Relevante Endpunkte:

- `GET /api/user/stats?interval=8|180|1440`
- `GET /api/user/rooms?id=<userId>`
- `GET /api/user/find?username=...` oder `id=...`
- Badge/Room-Bilder zusätzlich über andere Endpunkte/Assets

Aktueller Backend-Status:

- `GET /api/user/stats` liefert aktuell nur `{ stats: {} }`

### 2. My Overview

Template:

- `/components/game/overview/overview.html`

Angezeigt wird:

- GCL/GPL Summary
- optionale Leaderboard-Infos
- obere Statistik-Kacheln
- Grid-Ansicht mit Räumen
- Listenansicht mit Punchcard pro Raum

Client-seitige Datenquellen:

- `GameOverview.data.overview.totals`
- `GameOverview.data.overview.shards`
- `GameOverview.loader.max`
- `GameOverview.loader.displayOptions.statName`
- `GameOverview.loader.displayOptions.statInterval`

Es gibt zwei relevante Darstellungsformen:

1. Totals oben
2. Zeitreihen pro Raum in Listenansicht

#### 2.1 Totals oben

Das Widget `app-profile-stats` bekommt:

```json
{
  "overview": {
    "totals": {
      "energyControl": 0,
      "energyHarvested": 0,
      "energyConstruction": 0,
      "energyCreeps": 0,
      "creepsProduced": 0,
      "creepsLost": 0,
      "powerProcessed": 0
    }
  }
}
```

#### 2.2 Räume in Grid-Ansicht

Grid erwartet nur Raumlisten pro Shard:

```json
{
  "overview": {
    "shards": {
      "shard0": {
        "rooms": ["W1N1", "W1N2"]
      }
    }
  }
}
```

#### 2.3 Räume in Listenansicht mit Punchcard

Die Listenansicht erwartet pro Raum eine Zeitreihe für genau einen ausgewählten Stat-Namen:

```json
{
  "overview": {
    "shards": {
      "shard0": {
        "rooms": ["W1N1"],
        "stats": {
          "W1N1": [10, 20, 0, 5, 7, 0, 0, 1]
        }
      }
    }
  }
}
```

Zusätzlich wird ein Maximalwert für die Skalierung der Punchcard benötigt:

```json
{
  "loader": {
    "max": 20
  }
}
```

In der Raw-API von `/api/user/overview` sieht das eher nach dieser Form aus:

```json
{
  "rooms": ["W1N1", "W1N2"],
  "stats": {
    "W1N1": [10, 20, 0, 5, 7, 0, 0, 1],
    "W1N2": [0, 0, 0, 1, 0, 0, 0, 0]
  },
  "statsMax": 20,
  "totals": {
    "energyControl": 1234,
    "energyHarvested": 5678
  },
  "gametimes": [12345678, 12345679]
}
```

Der Controller kann daraus dann `overview.shards` und `loader.max` ableiten.

Erwartete Query-Parameter:

- `interval=8|180|1440`
- `statName=energyControl|energyHarvested|energyConstruction|energyCreeps|creepsProduced|creepsLost|powerProcessed`

Raw-Endpunkt:

- `GET /api/user/overview?interval=8&statName=energyHarvested`

Aktueller Backend-Status:

- liefert momentan nur:

```json
{
  "rooms": [],
  "stats": {},
  "statsMax": null,
  "totals": {},
  "gametimes": []
}
```

### 3. Room Overview

Template:

- `/components/game/overview/room/overview-room.html`

Angezeigt wird:

- Owner des Raums
- Room Preview
- obere Statistik-Kacheln via `app-profile-stats`
- mehrere Punchcards nebeneinander

Wichtig:

- Room Overview hat ebenfalls den Intervall-Selector `8|180|1440`
- Im Template werden diese Graphen direkt abgefragt:
  - `energyHarvested`
  - `energyConstruction`
  - `energyControl`
  - `energyCreeps`
  - `creepsProduced`
  - `creepsLost`
- `powerProcessed` wird hier nicht angezeigt

Client View-Model:

```json
{
  "GameOverviewRoom": {
    "roomName": "W1N1",
    "shardName": "shard0",
    "data": {
      "overview": {
        "owner": {
          "username": "alice",
          "badge": {}
        },
        "totals": {
          "energyControl": 0,
          "energyHarvested": 0,
          "energyConstruction": 0,
          "energyCreeps": 0,
          "creepsProduced": 0,
          "creepsLost": 0,
          "powerProcessed": 0
        },
        "stats": {
          "energyHarvested": [0, 1, 2, 3, 4, 5, 6, 7],
          "energyConstruction": [0, 0, 1, 0, 2, 0, 0, 1],
          "energyControl": [0, 0, 0, 5, 0, 0, 0, 0],
          "energyCreeps": [50, 0, 0, 0, 50, 0, 0, 0],
          "creepsProduced": [3, 0, 0, 0, 3, 0, 0, 0],
          "creepsLost": [0, 0, 0, 1, 0, 0, 0, 0]
        }
      }
    },
    "loader": {
      "max": {
        "energyHarvested8": 10,
        "energyConstruction8": 2,
        "energyControl8": 5,
        "energyCreeps8": 50,
        "creepsProduced8": 3,
        "creepsLost8": 1
      },
      "displayOptions": {
        "statInterval": 8
      }
    }
  }
}
```

Besonders wichtig:

- Das Template erwartet `statsMax` nicht als einfache Zahl.
- Es erwartet schlüsselbasierte Maxima wie:
  - `energyHarvested8`
  - `energyConstruction8`
  - `energyControl8`
  - `energyCreeps8`
  - `creepsProduced8`
  - `creepsLost8`
- Für `180` und `1440` entsprechend dieselbe Benennung mit Suffix.

Raw-Endpunkt:

- `GET /api/game/room-overview?room=W1N1`

Vom Backend aktuell geliefert:

```json
{
  "owner": {
    "username": "alice",
    "badge": {}
  },
  "stats": {},
  "statsMax": {},
  "totals": {}
}
```

Aktueller Backend-Status:

- Owner vorhanden
- Stats, StatsMax und Totals sind Platzhalter

### 4. World Map Layer

Templates:

- `/components/game/world-map/world-map.html`
- neues Angular-App2-Service: `/app2/main.js`

Die World Map unterstützt auf Zoom-Level 3 Statistik-Layer.

Verfügbare Statistik-Layer:

- `energyControl8`, `energyControl180`, `energyControl1440`
- `energyHarvested8`, `energyHarvested180`, `energyHarvested1440`
- `energyConstruction8`, `energyConstruction180`, `energyConstruction1440`
- `energyCreeps8`, `energyCreeps180`, `energyCreeps1440`
- `creepsProduced8`, `creepsProduced180`, `creepsProduced1440`
- `creepsLost8`, `creepsLost180`, `creepsLost1440`
- `powerProcessed8`, `powerProcessed180`, `powerProcessed1440`

Map-Endpunkt:

- `POST /api/game/map-stats`

Request:

```json
{
  "rooms": ["W1N1", "W1N2"],
  "shard": "shard0",
  "statName": "energyHarvested8"
}
```

Raw-Response laut Backend:

```json
{
  "gameTime": 12345678,
  "stats": {
    "W1N1": {
      "status": "normal",
      "novice": 0,
      "respawnArea": 0,
      "openTime": 0,
      "own": {
        "user": "u1",
        "level": 4
      },
      "sign": {
        "user": "u1",
        "text": "hello",
        "time": 12340000
      },
      "safeMode": true,
      "minerals0": {
        "type": "H",
        "density": 3
      },
      "energyHarvested8": [
        { "user": "u1", "value": 1000 }
      ]
    }
  },
  "statsMax": {},
  "users": {
    "u1": {
      "_id": "u1",
      "username": "alice",
      "badge": {}
    }
  }
}
```

Wichtige Bemerkung:

- Der aktuelle Backend-Code befüllt Ownership, Sign, SafeMode, Minerals, Users.
- Die eigentlichen Statistik-Layer sind im vorhandenen Private-Server-Stand nicht sichtbar implementiert.
- Der Client erwartet für Statistik-Layer pro Raum eine Liste von User-Beiträgen mit mindestens:
  - `user`
  - `value`

Das sieht man daran, dass der Client im Template direkt auf
`WorldMap.roomStats[room][layer][0].user` und `.value` zugreift.

Minimal erwartete Layer-Struktur pro Raum:

```json
{
  "energyHarvested8": [
    { "user": "u1", "value": 1234 },
    { "user": "u2", "value": 567 }
  ]
}
```

Die Nutzerdetails kommen aus dem separaten `users`-Dictionary:

```json
{
  "users": {
    "u1": { "_id": "u1", "username": "alice", "badge": {} },
    "u2": { "_id": "u2", "username": "bob", "badge": {} }
  }
}
```

### 5. Seasonal Leaderboards

Diese gehören funktional zum Thema Statistik, sind aber nicht Teil der `energyHarvested`-artigen Verlaufstats.

Seiten:

- `/components/profile/profile.html`
- `/components/game/lobby/world/lobby-world.html`
- `/components/game/lobby/power/lobby-power.html`

Angezeigt werden:

- monatliche World-Season-Ränge und Scores
- monatliche Power-Season-Ränge und Scores

Semantik:

- World leaderboard: Control points für Controller-Upgrades
- Power leaderboard: Power points aus `processPower`

Diese Saisondaten sind vom Client klar als Monats-/Season-Konzept modelliert.
Sie sind aber getrennt von den stündlich/täglich/7-Tage-Stats.

## Zusammenfassung der relevanten Endpunkte

### `GET /api/user/stats`

Verwendet für:

- Profilseite

Query:

- `interval=8|180|1440`

Minimal vom Client erwartete Raw-Response:

```json
{
  "stats": {
    "energyControl": 0,
    "energyHarvested": 0,
    "energyConstruction": 0,
    "energyCreeps": 0,
    "creepsProduced": 0,
    "creepsLost": 0,
    "powerProcessed": 0
  }
}
```

Aktueller Status:

- Stub, liefert `{ stats: {} }`

### `GET /api/user/overview`

Verwendet für:

- My Overview Totals
- My Overview Punchcards pro Raum

Query:

- `interval=8|180|1440`
- `statName=<statName>`

Raw-Response laut Backend-Schnittstelle:

```json
{
  "rooms": ["W1N1", "W1N2"],
  "stats": {},
  "statsMax": {},
  "totals": {},
  "gametimes": []
}
```

Client-Erwartung darüber hinaus:

- `totals` mit allen sieben Stat-Feldern
- `stats` mit pro Raum zeitlich aggregierten Reihen
- `statsMax` für Skalierung
- `gametimes` für X-Achse bzw. Zeitbezug

Aktueller Status:

- weitgehend Stub

### `GET /api/game/room-overview`

Verwendet für:

- Room Overview

Query:

- `room=<roomName>`

Raw-Response aktuell:

```json
{
  "owner": {
    "username": "alice",
    "badge": {}
  },
  "stats": {},
  "statsMax": {},
  "totals": {}
}
```

Client-Erwartung darüber hinaus:

- `stats.<statName>` jeweils Arrays
- `statsMax.<statName><interval>` jeweils Maximalwerte
- `totals` für obere Kacheln

### `POST /api/game/map-stats`

Verwendet für:

- World Map Overlay

Body:

```json
{
  "rooms": ["W1N1", "W1N2"],
  "shard": "shard0",
  "statName": "energyHarvested8"
}
```

Raw-Response aktuell:

```json
{
  "gameTime": 12345678,
  "stats": {},
  "statsMax": {},
  "users": {}
}
```

Client-Erwartung:

- pro Raum Standard-Metadaten
- bei Statistik-Layern zusätzlich Arrays von User-Stat-Beiträgen
- `users` Lookup-Tabelle für Badge und Username

## Erwartete Datenformen im Detail

### A. Totals-Objekt

Verwendet auf:

- Profilseite
- Overview
- Room Overview

Struktur:

```json
{
  "energyControl": "number",
  "energyHarvested": "number",
  "energyConstruction": "number",
  "energyCreeps": "number",
  "creepsProduced": "number",
  "creepsLost": "number",
  "powerProcessed": "number"
}
```

### B. Punchcard-Reihe

Verwendet auf:

- Overview Listenansicht
- Room Overview

Struktur:

```json
[0, 10, 4, 0, 2, 1, 0, 0]
```

Interpretation:

- Zeitreihe mit fester Länge je nach Intervall
- `interval=8` und `180` verwenden acht Buckets
- `interval=1440` verwendet sieben Buckets

Das passt zur Backend-Vorbereitung:

- `{8: 8, 180: 8, 1440: 7}`

### C. Punchcard-Maxima

Verwendet auf:

- Room Overview sicher
- Overview vermutlich vereinfacht als bereits vorbereiteter Max-Wert

Struktur:

```json
{
  "energyHarvested8": 100,
  "energyHarvested180": 500,
  "energyHarvested1440": 3000,
  "energyConstruction8": 20,
  "energyControl8": 50
}
```

### D. World-Map-Room-Stat-Liste

Verwendet auf:

- World Map Statistik-Layer

Struktur:

```json
[
  { "user": "u1", "value": 1000 },
  { "user": "u2", "value": 500 }
]
```

Der Client zeigt typischerweise:

- nur den größten Eintrag als Kreis auf der Karte
- im Hover/Float mehrere `stat-user`-Einträge

## Aktuelle Inkonsistenzen und Lücken

### 1. Backend-Stubs

Der aktuelle Private-Server-Stand erfüllt die Client-Erwartung nur teilweise:

- `/api/user/stats` ist Stub
- `/api/user/overview` ist Stub
- `/api/game/room-overview` liefert nur Owner, aber keine Stats
- `/api/game/map-stats` liefert Standard-Raummetadaten, aber keine funktionalen Stat-Layer

### 2. Room Overview zeigt kein `powerProcessed`

Die globale Overview-Seite und die World Map kennen `powerProcessed`, aber
`overview-room.html` rendert keinen separaten `powerProcessed`-Graphen.

### 3. Profilseite hat Interval-Selector ohne sichtbare Zeitreihe

Die Profilseite bietet Intervallwechsel an, zeigt aber nur Totals-Kacheln.
Das ist konsistent, wenn `GET /api/user/stats` bereits interval-spezifisch aggregierte Summen liefert.

### 4. Legacy Angular und App2 unterscheiden sich

Im neueren `app2`-World-Map-Code sind Statistik-Display-Optionen teilweise auskommentiert.
Der Legacy-Angular-Client erwartet die Statistik-Layer jedoch weiterhin klar.

## Empfohlenes Soll-Verhalten

Damit der Legacy-Angular-Client vollständig funktioniert, sollten diese Endpunkte effektiv liefern:

### `GET /api/user/stats`

Soll:

```json
{
  "stats": {
    "energyControl": 123,
    "energyHarvested": 456,
    "energyConstruction": 78,
    "energyCreeps": 90,
    "creepsProduced": 12,
    "creepsLost": 3,
    "powerProcessed": 4
  }
}
```

### `GET /api/user/overview`

Soll:

```json
{
  "rooms": ["W1N1", "W1N2"],
  "stats": {
    "W1N1": [1, 2, 3, 4, 5, 6, 7, 8],
    "W1N2": [0, 1, 0, 1, 0, 1, 0, 1]
  },
  "statsMax": 8,
  "totals": {
    "energyControl": 123,
    "energyHarvested": 456,
    "energyConstruction": 78,
    "energyCreeps": 90,
    "creepsProduced": 12,
    "creepsLost": 3,
    "powerProcessed": 4
  },
  "gametimes": [100, 101, 102, 103, 104, 105, 106, 107]
}
```

### `GET /api/game/room-overview`

Soll:

```json
{
  "owner": {
    "username": "alice",
    "badge": {}
  },
  "stats": {
    "energyHarvested": [0, 1, 2, 3, 4, 5, 6, 7],
    "energyConstruction": [0, 0, 1, 0, 2, 0, 0, 1],
    "energyControl": [0, 0, 0, 5, 0, 0, 0, 0],
    "energyCreeps": [50, 0, 0, 0, 50, 0, 0, 0],
    "creepsProduced": [3, 0, 0, 0, 3, 0, 0, 0],
    "creepsLost": [0, 0, 0, 1, 0, 0, 0, 0]
  },
  "statsMax": {
    "energyHarvested8": 7,
    "energyConstruction8": 2,
    "energyControl8": 5,
    "energyCreeps8": 50,
    "creepsProduced8": 3,
    "creepsLost8": 1
  },
  "totals": {
    "energyControl": 123,
    "energyHarvested": 456,
    "energyConstruction": 78,
    "energyCreeps": 90,
    "creepsProduced": 12,
    "creepsLost": 3,
    "powerProcessed": 4
  }
}
```

### `POST /api/game/map-stats`

Soll für Statistik-Layer:

```json
{
  "gameTime": 12345678,
  "stats": {
    "W1N1": {
      "status": "normal",
      "novice": 0,
      "respawnArea": 0,
      "openTime": 0,
      "own": { "user": "u1", "level": 4 },
      "energyHarvested8": [
        { "user": "u1", "value": 1000 },
        { "user": "u2", "value": 500 }
      ]
    }
  },
  "statsMax": {
    "energyHarvested8": 1000
  },
  "users": {
    "u1": { "_id": "u1", "username": "alice", "badge": {} },
    "u2": { "_id": "u2", "username": "bob", "badge": {} }
  }
}
```

## Fazit

Der Legacy-Angular-Client erwartet ein klar getrenntes Statistikmodell:

- Profilseite: aggregierte Totals pro Intervall
- Overview: Totals plus zeitliche Reihen pro Raum
- Room Overview: Owner plus mehrere Zeitreihen plus Maxima
- World Map: per-Raum Metadaten plus per-Layer User-Beitragslisten
- Saison-Rankings: separates Monats-/Season-Modell

Der aktuelle Private-Server-Code enthält bereits die richtigen Endpunktnamen und
teilweise die richtige Form, liefert aber die eigentlichen Statistikdaten noch nicht
vollständig aus.
