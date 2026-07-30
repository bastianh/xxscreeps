---
"xxscreeps": patch
---

Ship the inventory's sidebar entry and route with the `inventory` feature on `/api/version`. The official client boots with an empty router configuration and a sidebar holding only its built-in links, so a bare feature flag left the inventory unreachable; `ServerFeature` now carries `menuData`, which is how a feature contributes both.
