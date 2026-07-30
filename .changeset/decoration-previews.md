---
"xxscreeps": patch
---

Draw inventory previews for landscape decorations. A landscape is pure colour, so no pack can ship artwork for it and the client's inventory showed empty tiles; the catalog now renders an svg from the definition's own colours and serves it from `assets/decorations/`, leaving packs that declare a `preview` untouched.

Decoration asset urls are now relative to the document rather than rooted at `/`, matching how the client references its own assets. A rooted url escapes a proxy that serves the client under a path prefix — the steamless client mounts a backend at `/(http://host:21025)/`, where every asset 404'd. `decorations.assetBaseUrl` still overrides this with an absolute url.

Colour properties seeded with something that is not `#rrggbb` now fail the server at startup, since both the client and the drawing read them as colours.
