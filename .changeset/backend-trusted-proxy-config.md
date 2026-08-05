---
"xxscreeps": patch
---

Add `backend.proxy`, `backend.proxyIpHeader`, and `backend.maxIpsCount` config options to trust `X-Forwarded-*` headers when running behind a reverse proxy. When enabled, `ctx.secure`/`ctx.protocol` honor `X-Forwarded-Proto` (so `https` is reported correctly when TLS is terminated upstream, e.g. for OAuth redirect URIs) and the client IP is derived from `X-Forwarded-For`.
