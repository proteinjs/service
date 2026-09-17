import { Loadable, SourceRepository } from '@proteinjs/reflection';

export const getServerBuildVersion = (): ServerBuildVersion | undefined =>
  SourceRepository.get().objects<ServerBuildVersion>('@proteinjs/service/ServerBuildVersion')[0];

/**
 * Implement this (server-side) to tell the service layer which build version the RUNNING server
 * serves — the server's half of the comparison ServiceRouter makes when a request names a
 * service path this build does not register: against the caller's declared build
 * (ClientBuildVersion), the router can tell a rollout in progress or a stale client from a
 * client build that calls a service its own server build never registered, and log each as what
 * it is. Without an implementation the router still answers 404, but every unknown path is
 * recorded as the unordered (error) class.
 *
 * Release versions are compared numerically (`MAJOR.MINOR.PATCH`, an optional leading `v`);
 * anything else cannot be ordered.
 */
export interface ServerBuildVersion extends Loadable {
  /** The build version of the running server (e.g. the fixed app-workspace version). */
  getVersion(): string;
}
