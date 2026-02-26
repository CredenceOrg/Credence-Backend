# Observability: Request Tracing

To facilitate debugging in our distributed environment, every request is assigned a `Request ID` and a `Correlation ID`.

- **X-Request-ID**: Unique to every single HTTP call to this service.
- **X-Correlation-ID**: Persists across services. If an upstream service sends one, we propagate it.

## Log Format
All logs emitted during a request lifecycle include these IDs automatically:
`[INFO] [RequestID: <uuid>] [CorrelationID: <uuid>] - <message>`