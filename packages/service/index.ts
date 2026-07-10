export * from './src/Service';
// ServiceError is the one error type whose message passes through to the client verbatim
// (ServiceRouter returns it as the 400 body; everything else becomes 'Internal server error').
// Exported so auth layers (e.g. @proteinjs/db TableServiceAuth) can reject with a clean,
// actionable message instead of a generic authorization failure.
export { ServiceError } from './src/ServiceExecutor';
