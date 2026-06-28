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
