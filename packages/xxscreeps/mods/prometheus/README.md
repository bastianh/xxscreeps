# Prometheus Mod

This mod exposes xxscreeps runtime metrics in Prometheus text format at `GET /metrics`.

It is designed to work with xxscreeps' existing service split:

- `main`
- `backend`
- `runner`
- `processor`

It does not depend on `prom-client` or any other external metrics library. All aggregation is done with the shard scratch store so the metrics work across worker threads and service instances.

## What It Exposes

The mod currently exports four groups of metrics:

1. Tick and queue metrics
2. Process memory metrics
3. Per-user runtime metrics
4. Config limit metrics

It also exports histogram counters for:

- overall tick execution time
- per-user CPU time per tick

These histogram counters are the preferred source for percentile-style dashboards because they accumulate every observed tick between Prometheus scrapes.

## Endpoint

The metrics endpoint is served by the backend service:

```text
GET /metrics
```

The exact host and port match the backend bind configuration. In the default setup that is usually port `21025`.

Example:

```bash
curl http://127.0.0.1:21025/metrics
```

## Enable The Mod

Add the mod to `.screepsrc.yaml`:

```yaml
mods:
  - xxscreeps/mods/classic
  - xxscreeps/mods/backend/cookie
  - xxscreeps/mods/backend/password
  - xxscreeps/mods/backend/steam
  - xxscreeps/mods/prometheus
```

Then rebuild and restart the server.

## Exported Metrics

### Tick Metrics

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `xxscreeps_tick_time_ms` | gauge | none | Wall-clock duration of the most recently completed game tick. |
| `xxscreeps_tick_avg_time_ms` | gauge | none | Rolling average tick duration. |
| `xxscreeps_tick_game_time` | gauge | none | Current game tick number. |
| `xxscreeps_tick_rooms_processed` | gauge | none | Number of rooms in the processor queue for the tick that is about to run. This is captured before the queue is drained. |
| `xxscreeps_tick_active_users` | gauge | none | Number of users queued for the runner for the tick that is about to run. |
| `xxscreeps_active_rooms` | gauge | none | Current number of rooms tracked as active by the processor. |

### Tick Histogram

This histogram tracks every completed tick, not just the last one seen by Prometheus.

Metric family:

- `xxscreeps_tick_duration_ms_bucket{le="..."}`
- `xxscreeps_tick_duration_ms_sum`
- `xxscreeps_tick_duration_ms_count`

Buckets are in milliseconds:

```text
1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, +Inf
```

### Process Memory Metrics

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `xxscreeps_process_memory_bytes` | gauge | `service`, `instance`, `pid`, `type` | Node.js memory stats for each instrumented service thread. `type` is one of `rss`, `heapTotal`, `heapUsed`, `external`. |

Notes:

- `instance` is thread-aware and looks like `<hostname>:<pid>:t<threadId>`
- this is important because `runner` and `processor` can run in worker threads that share the same process ID
- dead process entries expire automatically

### Per-User Runtime Metrics

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `xxscreeps_user_cpu_total_seconds` | counter | `username` | Cumulative CPU time spent by that user's code across all ticks. |
| `xxscreeps_user_game_memory_bytes` | gauge | `username` | Serialized `Memory` size for that user. |
| `xxscreeps_user_heap_used_bytes` | gauge | `username` | VM heap currently used by the user's runtime. |
| `xxscreeps_user_heap_total_bytes` | gauge | `username` | VM heap currently allocated by the user's runtime. |
| `xxscreeps_user_vm_resets_total` | counter | `username` | Number of runtime initializations or resets. |
| `xxscreeps_user_last_reset_tick` | gauge | `username` | Game tick at which the user's runtime was last initialized or reset. |
| `xxscreeps_user_code_size_bytes` | gauge | `username` | Serialized user code size in bytes. |

### Per-User CPU Histogram

This histogram tracks per-tick CPU cost per user.

Metric family:

- `xxscreeps_user_cpu_tick_ms_bucket{username="...",le="..."}`
- `xxscreeps_user_cpu_tick_ms_sum{username="..."}`
- `xxscreeps_user_cpu_tick_ms_count{username="..."}`

Buckets are in milliseconds:

```text
1, 2, 5, 10, 20, 50, 100, 200, 500, +Inf
```

### Config Limit Metrics

These are static gauges derived from server configuration and built-in limits.

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `xxscreeps_config_cpu_tick_limit_ms` | gauge | none | Configured per-user CPU tick limit from `runner.cpu.tickLimit`. |
| `xxscreeps_config_heap_limit_bytes` | gauge | none | Configured per-user heap limit from `runner.cpu.memoryLimit`, converted to bytes. |
| `xxscreeps_config_raw_memory_limit_bytes` | gauge | none | Current RawMemory size limit. This is derived from the memory mod's internal hard limit. |

## Important Semantics

### Last-value gauges vs accumulated counters

Some metrics are point-in-time gauges, for example:

- `xxscreeps_tick_time_ms`
- `xxscreeps_user_game_memory_bytes`
- `xxscreeps_user_heap_used_bytes`

These reflect the latest known state at scrape time.

Histogram counters and cumulative counters are different:

- `xxscreeps_tick_duration_ms_bucket`
- `xxscreeps_tick_duration_ms_sum`
- `xxscreeps_tick_duration_ms_count`
- `xxscreeps_user_cpu_total_seconds`
- `xxscreeps_user_cpu_tick_ms_bucket`

These accumulate every event between scrapes and are usually the better choice for dashboards and alerts.

### Why the histogram metrics matter

If the game tick is much faster than the Prometheus scrape interval, gauges like `xxscreeps_tick_time_ms` only show one sampled tick. Histograms avoid that problem because every completed tick increments counters.

That makes them suitable for:

- percentiles
- rate-based dashboards
- saturation panels
- spike detection over a time window

## Example PromQL

### Tick Time Percentiles

P50 over 5 minutes:

```promql
histogram_quantile(0.50, sum(rate(xxscreeps_tick_duration_ms_bucket[5m])) by (le))
```

P95 over 5 minutes:

```promql
histogram_quantile(0.95, sum(rate(xxscreeps_tick_duration_ms_bucket[5m])) by (le))
```

P99 over 5 minutes:

```promql
histogram_quantile(0.99, sum(rate(xxscreeps_tick_duration_ms_bucket[5m])) by (le))
```

### Tick Time As Percent Of Limit

Using the rolling average gauge:

```promql
100 * xxscreeps_tick_avg_time_ms / xxscreeps_config_cpu_tick_limit_ms
```

Using the histogram-based P95:

```promql
100 * histogram_quantile(0.95, sum(rate(xxscreeps_tick_duration_ms_bucket[5m])) by (le)) / xxscreeps_config_cpu_tick_limit_ms
```

### User CPU Percentiles

Per-user P95 over 10 minutes:

```promql
histogram_quantile(0.95, sum(rate(xxscreeps_user_cpu_tick_ms_bucket[10m])) by (username, le))
```

Per-user mean CPU per tick over 10 minutes:

```promql
sum(rate(xxscreeps_user_cpu_tick_ms_sum[10m])) by (username)
/
sum(rate(xxscreeps_user_cpu_tick_ms_count[10m])) by (username)
```

### User Heap As Percent Of Configured Limit

```promql
100 * xxscreeps_user_heap_used_bytes / xxscreeps_config_heap_limit_bytes
```

### User Game Memory Against Limit

Current usage:

```promql
xxscreeps_user_game_memory_bytes
```

Limit line:

```promql
xxscreeps_config_raw_memory_limit_bytes
```

Usage as percent of limit:

```promql
100 * xxscreeps_user_game_memory_bytes / xxscreeps_config_raw_memory_limit_bytes
```

### Runtime Reset Age

Ticks since last user reset:

```promql
xxscreeps_tick_game_time - xxscreeps_user_last_reset_tick
```

### Number Of Runner / Processor Threads Seen By Prometheus

Processor threads:

```promql
count(count by (instance) (xxscreeps_process_memory_bytes{service="processor",type="rss"}))
```

Runner threads:

```promql
count(count by (instance) (xxscreeps_process_memory_bytes{service="runner",type="rss"}))
```

## Internal Design

### Service hooks

The mod uses existing xxscreeps hooks instead of patching core engine logic directly.

- `beforeTick`
  - snapshots room and runner queue sizes before they are consumed
- `afterTick`
  - stores the latest tick timing gauges
  - appends the completed tick to the tick-time histogram
- `serviceInitialized`
  - starts the main service process reporter
- backend middleware hook
  - starts the backend process reporter lazily
  - exposes `/metrics`
- `runnerConnector`
  - records user CPU totals, CPU histogram buckets, memory size, heap stats, reset counters, and code size
- `workerInitialized`
  - starts one process reporter per processor worker thread

### Scratch-store aggregation

The mod writes intermediate values into `shard.scratch`.

This is what makes the endpoint work correctly across:

- worker threads
- service restarts
- clustered service roles

The `/metrics` endpoint does not need direct access to runner or processor memory; it only reads the shared scratch store and formats the result.

### Process identity

Process memory entries are keyed by:

```text
<hostname>:<pid>:t<threadId>
```

This avoids collisions when multiple worker threads share the same process ID.

## Operational Notes

### Security

`/metrics` is a plain HTTP endpoint. If your backend is publicly reachable, protect it at the ingress or reverse-proxy layer.

Typical options:

- restrict by source IP
- expose it only inside the cluster
- require auth in front of the route

### Metric lifetime

Process memory entries are refreshed periodically and expire automatically if a service thread dies.

Counter-style histogram data and per-user cumulative counters live in scratch until scratch is reset, for example on fresh startup.

### Scrape interval guidance

For xxscreeps, a typical Prometheus scrape interval of `15s` is fine.

If your tick rate is much faster than the scrape interval:

- use histograms and counters for trend analysis
- use gauges for current state only

## Files In This Mod

| File | Purpose |
| --- | --- |
| `index.ts` | Mod manifest |
| `main.ts` | Tick metrics, tick histogram, main service memory reporter |
| `driver.ts` | User CPU and memory metrics, runner and processor reporters |
| `backend.ts` | `/metrics` endpoint and Prometheus exposition formatting |

## Troubleshooting

### Only one processor thread appears

Check the `instance` label on `xxscreeps_process_memory_bytes`. The mod now includes thread ID in the label. If only one processor thread still appears, check whether your current runtime configuration is actually creating more than one processor worker.

### `tick_rooms_processed` or `tick_active_users` looks wrong

These values are captured before the tick work begins, not after the queues are drained. That is intentional, because the queue keys are consumed during processing.

### Percentiles look empty

Histogram queries require `rate(...)` or `increase(...)` over a time range. A raw instant query on `_bucket` counters is usually not what you want.

Example:

```promql
histogram_quantile(0.95, sum(rate(xxscreeps_tick_duration_ms_bucket[5m])) by (le))
```

## Future Extensions

Potential additions that fit this design well:

- sleeping room counts
- abandoned intent counts
- inter-room finalize counts
- per-service loop latency histograms
- CPU bucket distribution per user
