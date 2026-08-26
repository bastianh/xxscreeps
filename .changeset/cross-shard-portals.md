---
"xxscreeps": patch
---

Carry creeps through inter-shard portals. A creep stepping onto one is queued in the global database, and the destination shard's `main` turns it into an arrival while it holds the game mutex. `manage portal add` places the portals.
