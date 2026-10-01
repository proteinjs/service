export * from './src/Service';
// ServiceError is the one error type whose message passes through to the client verbatim
// (ServiceRouter returns it as the 400 body; everything else becomes 'Internal server error').
// ServiceExecutor wraps every error a service method throws in a ServiceError that preserves the
// original message, so service messages always reach the client. Exported for layers that throw
// outside a service method body (e.g. @proteinjs/db TableServiceAuth) and want the same pass-through.
export { ServiceError } from './src/ServiceExecutor';
// ServiceRefusal is a refusal an operation throws on purpose (403 / 404 / 409 / 400): the router
// answers with its status and the executor logs it at WARN — a refusal, never a failure.
export { ServiceRefusal, ServiceRefusalStatus } from './src/ServiceRefusal';
// ServiceClient is the one HTTP transport every service call flows through; exported for the
// app-level owners of ambient client-context headers (see setDefaultHeadersProvider) and of
// per-request transport options such as keepalive (see setRequestInitProvider).
export {
  ServiceClient,
  ServiceRequestHeadersProvider,
  ServiceRequestInit,
  ServiceRequestInitProvider,
} from './src/ServiceClient';
// ServiceTransportError is the one error a service call rejects with when it produced NO response —
// the transport rejected the request, or a declared method's first-contact watchdog abandoned it —
// after the client's own redelivery series: reachedServer is false (contact was never confirmed),
// attempts counts the deliveries, and a consumer surface reads it to offer a retry in place of what it
// could not load. The declaration per method at the factory (`'read'` | `{ idempotent: true }`), the
// first-contact bound and the redelivery series' numbers are exported beside it, for consumers that
// bound their own loading states on the same clock; the idempotency key's header name for a server
// or a proxy that reads it.
export { ServiceTransportError } from './src/ServiceTransportError';
export {
  IDEMPOTENCY_KEY_HEADER,
  READ_CONTACT_TIMEOUT_MS,
  REDELIVERY_BASE_MS,
  REDELIVERY_BUDGET,
  REDELIVERY_CAP_MS,
  REDELIVERY_TOTAL_BOUND_MS,
  ServiceMethodRetry,
} from './src/ServiceClient';
// The server's seat for methods declared idempotent: one ledger per server (ServiceExecutor.setIdempotencyLedger),
// in-process by default; a deployment of several server processes registers one they share.
export {
  IDEMPOTENCY_KEY_TTL_MS,
  IdempotencyLedger,
  IdempotencyScope,
  InProcessIdempotencyLedger,
} from './src/IdempotencyLedger';
export { ServiceExecutionOptions } from './src/ServiceExecutor';
// The environment flag a multi-process deployment sets (`SERVICE_MULTI_PROCESS=true`): under it the executor
// refuses a keyed call (501) until a shared ledger is registered — the in-process one cannot see another process.
export { MULTI_PROCESS_ENV } from './src/ServiceExecutor';
