export * from './src/Service';
// ServiceError is the one error type whose message passes through to the client verbatim
// (ServiceRouter returns it as the 400 body; everything else becomes 'Internal server error').
// ServiceExecutor wraps every error a service method throws in a ServiceError that preserves the
// original message, so service messages always reach the client. Exported for layers that throw
// outside a service method body (e.g. @proteinjs/db TableServiceAuth) and want the same pass-through.
export { ServiceError } from './src/ServiceExecutor';
// ExpectedServiceOutcome marks a throw as a designed outcome (gone, not shared, already done):
// ServiceExecutor logs it at warn without a stack instead of as a failure, and the message still
// reaches the client as a ServiceError. Services subclass it to name their own outcomes.
export { ExpectedServiceOutcome, isExpectedServiceOutcome } from './src/ServiceExecutor';
// ServiceClient is the one HTTP transport every service call flows through; exported for the
// app-level owner of ambient client-context headers (see setDefaultHeadersProvider).
export { ServiceClient, ServiceRequestHeadersProvider } from './src/ServiceClient';
