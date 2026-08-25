---
"xxscreeps": patch
---

Run and serve every configured shard instead of only the first. `main`, `processor` and `runner` take `--shard`, the launcher starts a set of services per shard, the backend resolves the shard a request or subscription addressed, and `manage` takes `--shard` for its world-scoped verbs.
