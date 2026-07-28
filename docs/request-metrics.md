# Per-request metrics

Handlers can use the lightweight `req.metrics` shim for counters that are only relevant to the current request. These counters are deliberately separate from the global metrics registry and are not exported automatically.

## Enabling the shim

Register the middleware before routes that use it:

```ts
import { requestMetrics } from './middleware/requestMetrics.js'

app.use(requestMetrics)
```

The middleware creates a fresh counter store for every request.

## Handler usage

```ts
router.get('/example', (req, res) => {
  req.metrics.increment('example.started')

  const result = doWork()
  req.metrics.inc('example.completed')

  res.json({
    result,
    requestMetrics: req.metrics.snapshot(),
  })
})
```

Available operations:

- `increment(name, amount?)` increments a counter and returns its new value.
- `inc(name, amount?)` is an alias for `increment`.
- `get(name)` returns the current value, or `0` when the counter has not been used.
- `snapshot()` returns a plain object containing the current counters.
- `reset()` clears all counters for the current request.

Counter state is created per request, so values cannot leak between requests or modify the global metrics registry. Counter names must be non-empty strings and increments must be finite numbers.
