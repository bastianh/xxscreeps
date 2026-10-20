---
"xxscreeps": patch
---

Persist each user's CPU bucket in their shard's storage, so restarting a runner no longer hands out a full one, and replace the hard-coded per-tick CPU allotment with the `runner.cpu.limit` option.
