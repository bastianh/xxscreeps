---
"xxscreeps": patch
---

Split a user's CPU across shards. The account's allowance and its division live in the global database, each shard's slice is `Game.cpu.limit` and the rate that shard's bucket refills at, and `/api/user/cpu-shards` and `Game.cpu.setShardLimits` read and rewrite the division. A shard given no CPU stops running that user's code. `manage user cpu` sets the account total.
