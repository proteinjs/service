export * from './src/Service';
// ServiceError is the one error type whose message passes through to the client verbatim
// (ServiceRouter returns it as the 400 body; everything else becomes 'Internal server error').
// ServiceExecutor wraps every error a service method throws in a ServiceError that preserves the
// original message, so service messages always reach the client. Exported for layers that throw
// outside a service method body (e.g. @proteinjs/db TableServiceAuth) and want the same pass-through.
export { ServiceError } from './src/ServiceExecutor';
// ServiceClient is the one HTTP transport every service call flows through; exported for the
// app-level owner of ambient client-context headers (see setDefaultHeadersProvider).
export { ServiceClient, ServiceRequestHeadersProvider } from './src/ServiceClient';
// The two halves of the build-version comparison ServiceRouter makes on an unknown service path:
// the client installs its build version once (ClientBuildVersion.set; every request then carries
// the header), the server declares its own by implementing ServerBuildVersion.
export { ClientBuildVersion, CLIENT_BUILD_VERSION_HEADER } from './src/ClientBuildVersion';
export * from './src/ServerBuildVersion';
