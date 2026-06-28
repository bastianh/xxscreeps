# xxscreeps-mod-admin-api

Administrative HTTP API mod for xxscreeps.

Add `xxscreeps-mod-admin-api` to `mods` and bind it explicitly:

```yaml
mods:
  - xxscreeps/mods/classic
  - xxscreeps-mod-admin-api

adminApi:
  bind: 127.0.0.1:21026
```

The v1 API is intentionally network-boundary protected and provides terrain editing under
`/admin/terrain/:room`.

Additional read-only operational endpoints:

- `GET /admin/game`
- `POST /admin/game/pause`
- `POST /admin/game/resume`
- `POST /admin/shutdown`
- `GET /admin/users`
- `GET /admin/users/:user`
- `GET /admin/store/:store/string?key=...`
- `GET /admin/store/:store/blob?key=...`
- `GET /admin/store/:store/hash?key=...`
- `GET /admin/store/:store/list?key=...&start=0&stop=-1`
- `GET /admin/store/:store/set?key=...`
- `GET /admin/store/:store/zset?key=...&start=0&stop=-1`
- `GET /admin/store/:store/ttl?key=...`

Store names are `db`, `shard`, and `scratch`. Known blobs such as terrain, room blobs, memory,
memory segments, and user code blobs are decoded into JSON payloads.
