# Prometheus Mod

This mod exposes xxscreeps runtime metrics in Prometheus text format at `GET /metrics`.

It is designed to work with xxscreeps' existing service split:

- `main`
- `backend`
- `runner`
- `processor`

It does not depend on `prom-client` or any other external metrics library. All aggregation is done with the shard scratch store so the metrics work across worker threads and service instances.

Everything here is built entirely from hooks and utilities the engine already exports (`registerShardTickProcessor`, `registerShardInitializer`, `runnerConnector`, `refreshRoom`, `sandboxCreated`, the backend `middleware` hook, and the existing `channel/processor` / `channel/service` pub/sub channels). **No core engine files are modified.** That constraint is why a couple of the timing metrics below are approximations rather than exact core-measured values — see "Important Semantics" for the details.

## What It Exposes

The mod currently exports five groups of metrics:

1. Tick and queue metrics
2. Processor-phase and runner-phase timing
3. Process memory metrics
4. Per-user runtime metrics
5. Config limit metrics

It also exports histogram counters for:

- overall tick execution time (approximate, see below)
- processor-phase duration (precise)
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
| `xxscreeps_tick_time_ms` | gauge | none | Approximate wall-clock duration of the most recently completed game tick. See "Tick timing is approximate" below. |
| `xxscreeps_tick_avg_time_ms` | gauge | none | Rolling average tick duration (same caveat). |
| `xxscreeps_tick_game_time` | gauge | none | Current game tick number. |
| `xxscreeps_tick_rooms_processed` | gauge | none | Number of rooms in the processor queue for the most recently completed tick. |
| `xxscreeps_tick_active_users` | gauge | none | Number of users in the runner queue for the most recently completed tick. |
| `xxscreeps_active_rooms` | gauge | none | Current number of rooms tracked as active by the processor. |

### Tick Histogram (approximate)

Metric family:

- `xxscreeps_tick_duration_ms_bucket{le="..."}`
- `xxscreeps_tick_duration_ms_sum`
- `xxscreeps_tick_duration_ms_count`

Buckets are in milliseconds:

```text
1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, +Inf
```

### Processor-Phase Metrics (precise)

The processor phase (room processing + finalize) is bounded by the `'process'` and `'tickFinished'` messages on the engine's own `channel/processor` / `channel/service` pub/sub channels, so this timing matches the real duration the core itself waits on.

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `xxscreeps_processor_phase_ms` | gauge | none | Duration of the processor phase for the most recently completed tick. |
| `xxscreeps_processor_phase_tick_time` | gauge | none | Game tick that `xxscreeps_processor_phase_ms` was measured for. |

Histogram family (same buckets as the tick histogram):

- `xxscreeps_processor_phase_duration_ms_bucket{le="..."}`
- `xxscreeps_processor_phase_duration_ms_sum`
- `xxscreeps_processor_phase_duration_ms_count`

### Runner-Phase Metrics (approximate, no histogram)

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `xxscreeps_runner_phase_ms` | gauge | none | Approximate span from the first player `refresh()` to the last player `save()` seen for a tick. |
| `xxscreeps_runner_phase_tick_time` | gauge | none | Game tick that `xxscreeps_runner_phase_ms` was measured for. |

There is no histogram for this one on purpose — see "Runner-phase timing is approximate" below for why treating it as a precise, disjoint duration would be misleading.

### Process Memory Metrics

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `xxscreeps_process_memory_bytes` | gauge | `service`, `instance`, `pid`, `type` | Node.js memory stats for each instrumented service thread. `type` is one of `rss`, `heapTotal`, `heapUsed`, `external`. |

Notes:

- `instance` is thread-aware and looks like `<hostname>:<pid>:t<threadId>`
- this is important because `runner` and `processor` can run in worker threads that share the same process ID
- dead process entries expire automatically
- the `processor` reporter starts on a worker thread's first `refreshRoom` call rather than a true "worker started" event (there is no such hook on this engine version) — see "Processor worker reporting" below

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

Metric family:

- `xxscreeps_user_cpu_tick_ms_bucket{username="...",le="..."}`
- `xxscreeps_user_cpu_tick_ms_sum{username="..."}`
- `xxscreeps_user_cpu_tick_ms_count{username="..."}`

Buckets are in milliseconds:

```text
1, 2, 5, 10, 20, 50, 100, 200, 500, +Inf
```

### Config Limit Metrics

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `xxscreeps_config_cpu_tick_limit_ms` | gauge | none | Configured per-user CPU tick limit from `runner.cpu.tickLimit`. |
| `xxscreeps_config_heap_limit_bytes` | gauge | none | Configured per-user heap limit from `runner.cpu.memoryLimit`, converted to bytes. |
| `xxscreeps_config_raw_memory_limit_bytes` | gauge | none | Current RawMemory size limit, from the memory mod's `kMaxMemoryLength`. |

## Important Semantics

### Tick timing is approximate

This engine version has no hook that carries the exact tick duration measured by `engine/service/main.ts`'s own loop, and that value isn't published anywhere a mod can read it — getting it precisely would require a small core change. The nearest hook a mod *can* observe without touching core is one `registerShardTickProcessor` call per completed tick, so `xxscreeps_tick_time_ms` / `xxscreeps_tick_avg_time_ms` / the tick histogram time the gap between successive calls instead. That gap also includes the inter-tick pause/delay (tick pacing, `pause`/`unpause`) that the core's own measurement excludes, so expect these numbers to run a little high relative to the true tick-processing time, especially at slow tick speeds.

If you need a precise, delay-free duration, use `xxscreeps_processor_phase_ms` and its histogram instead — that one is measured off the same `'process'` → `'tickFinished'` boundary the core itself waits on, so it has no such caveat (it doesn't cover runner time, though — see below).

### Runner-phase timing is approximate

There is no core "runner finished this tick" signal to bound the runner phase against. This mod tracks the span between the first `refresh()` call seen for a tick and the last `save()` call seen before the next tick's first `refresh()` — which is a safe boundary (the runner service processes one tick's `'run'` message fully before starting the next), but it comes with two caveats worth knowing before you build alerts on it:

- Players run in concurrency-limited batches with a migration-timeout straggler window, so a few slow/late sandboxes can stretch this span well past when "most" players finished.
- Runner dispatch and processor dispatch are published together by the core (`engine/service/main.ts` fires `'process'` and `'run'` almost simultaneously), so the runner phase's wall-clock window already overlaps the processor phase's. **Do not add `xxscreeps_runner_phase_ms` and `xxscreeps_processor_phase_ms` together expecting them to sum to the tick duration** — they are concurrent, not sequential.

There is no histogram for this metric because treating an already-approximate, overlapping span as material for percentile math would overstate its precision.

### Processor worker reporting

There is no `workerInitialized` hook on this engine version, so `xxscreeps_process_memory_bytes{service="processor",...}` reporting piggybacks on the `refreshRoom` hook, which fires once per room whenever "processor continuity has broken" — in practice this includes the initial room load every worker performs at startup, which is close enough to "worker started" for a memory gauge. The one edge case: a worker that is never assigned a room never reports.

### Last-value gauges vs accumulated counters

Some metrics are point-in-time gauges, for example:

- `xxscreeps_tick_time_ms`
- `xxscreeps_user_game_memory_bytes`
- `xxscreeps_user_heap_used_bytes`

These reflect the latest known state at scrape time.

Histogram counters and cumulative counters are different:

- `xxscreeps_tick_duration_ms_bucket` / `_sum` / `_count`
- `xxscreeps_processor_phase_duration_ms_bucket` / `_sum` / `_count`
- `xxscreeps_user_cpu_total_seconds`
- `xxscreeps_user_cpu_tick_ms_bucket` / `_sum` / `_count`

These accumulate every event between scrapes and are usually the better choice for dashboards and alerts.

### Why the histogram metrics matter

If the game tick is much faster than the Prometheus scrape interval, gauges like `xxscreeps_tick_time_ms` only show one sampled tick. Histograms avoid that problem because every completed tick (or processor phase, or user tick) increments counters.

That makes them suitable for:

- percentiles
- rate-based dashboards
- saturation panels
- spike detection over a time window

## Example PromQL

### Tick Time Percentiles (approximate)

P95 over 5 minutes:

```promql
histogram_quantile(0.95, sum(rate(xxscreeps_tick_duration_ms_bucket[5m])) by (le))
```

### Processor-Phase Time Percentiles (precise)

P95 over 5 minutes:

```promql
histogram_quantile(0.95, sum(rate(xxscreeps_processor_phase_duration_ms_bucket[5m])) by (le))
```

### Tick Time As Percent Of Limit

```promql
100 * xxscreeps_tick_avg_time_ms / xxscreeps_config_cpu_tick_limit_ms
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

```promql
100 * xxscreeps_user_game_memory_bytes / xxscreeps_config_raw_memory_limit_bytes
```

### Runtime Reset Age

```promql
xxscreeps_tick_game_time - xxscreeps_user_last_reset_tick
```

### Number Of Runner / Processor Threads Seen By Prometheus

```promql
count(count by (instance) (xxscreeps_process_memory_bytes{service="processor",type="rss"}))
count(count by (instance) (xxscreeps_process_memory_bytes{service="runner",type="rss"}))
```

## Internal Design

### No core changes

Everything in this mod is built from hooks and utilities the engine already exports:

- `registerShardTickProcessor` / `registerShardInitializer` (`xxscreeps/engine/processor/index.js`) — tick-boundary and startup work in the `main` process
- the `channel/processor` and `channel/service` pub/sub channels (`getProcessorChannel`, `getServiceChannel`) — subscribed independently for processor-phase timing, alongside whatever the core itself is already listening for
- `runnerConnector` (`xxscreeps/engine/runner/index.js`) — per-player CPU/memory/reset/code-size metrics and the runner-phase approximation
- `sandboxCreated` (`xxscreeps/driver/index.js`) — decorates `sandbox.run` to capture isolate VM heap statistics
- `refreshRoom` (`xxscreeps/engine/processor/symbols.js`) — stand-in for processor-worker startup, see above
- the backend `middleware` hook (`xxscreeps/backend/index.js`) — exposes `/metrics`

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
| `main.ts` | Tick metrics, tick histogram, processor-phase timing, main-service memory reporter |
| `driver.ts` | User CPU/memory/heap metrics, runner-phase timing, runner and processor-worker memory reporters |
| `backend.ts` | `/metrics` endpoint and Prometheus exposition formatting |

## Troubleshooting

### Only one processor thread appears

Check the `instance` label on `xxscreeps_process_memory_bytes`. If only one processor thread appears, check whether your current runtime configuration is actually creating more than one processor worker, and whether that worker has been assigned any rooms yet (see "Processor worker reporting" above).

### `tick_rooms_processed` or `tick_active_users` looks off

These are read from the same scratch keys the processor and runner queues use for the tick that was just completed. They reflect the queue as scheduled, not necessarily every intermediate state during the tick.

### Percentiles look empty

Histogram queries require `rate(...)` or `increase(...)` over a time range. A raw instant query on `_bucket` counters is usually not what you want.

```promql
histogram_quantile(0.95, sum(rate(xxscreeps_processor_phase_duration_ms_bucket[5m])) by (le))
```

### `xxscreeps_tick_time_ms` looks higher than expected

That metric includes inter-tick pause/delay by design (see "Tick timing is approximate" above). Use `xxscreeps_processor_phase_ms` for a delay-free measurement of processing time alone.

## Future Extensions

Potential additions that fit this design well:

- sleeping room counts
- abandoned intent counts
- inter-room finalize counts
- CPU bucket distribution per user

Getting a precise, disjoint runner-phase duration and separating "process" from "finalize" within the processor phase would both require a small core change (a phase tag on `flushContext`, or a `runnerFinished` broadcast) — out of scope for this mod as long as it stays core-change-free, but worth keeping in mind if this ever moves into a maintained core hook instead of an external mod.
