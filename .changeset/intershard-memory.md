---
"xxscreeps": patch
---

Add `InterShardMemory`, the one channel a player's code has between shards. Each shard publishes a string of up to 100 KB and reads what the others published, through the global database.
