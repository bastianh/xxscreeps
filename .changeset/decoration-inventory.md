---
"xxscreeps": patch
---

Add a `decorations` mod with the catalog and inventory half of room decorations: decoration packs (a validated `pack.json` plus its assets, served from `/assets/decorations/`), per-user ownership, the `user/decorations/inventory` and `…/themes` endpoints, the `inventory` feature flag on `/api/version`, and `xxscreeps manage decoration <catalog|list|grant|revoke>`. Every user owns the whole catalog by default; set `decorations.grantAll: false` to hand decorations out explicitly. Placing decorations comes next — nothing is rendered in rooms or on the map yet.
