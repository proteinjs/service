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
