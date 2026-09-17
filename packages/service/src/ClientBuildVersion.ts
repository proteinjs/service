/**
 * Header every service request carries, naming the build version of the client that sent it —
 * the caller's half of the comparison ServiceRouter makes when a request names a service path
 * this server does not register (see ServiceRouter).
 */
export const CLIENT_BUILD_VERSION_HEADER = 'x-client-version';

/**
 * ONE owner of "which build of the client is issuing service requests".
 *
 * - CLIENT: the app installs its bundle's version once ({@link set} — e.g. from the same
 *   package.json version it hands the version checker); ServiceClient then attaches
 *   {@link CLIENT_BUILD_VERSION_HEADER} to every request it sends. The transport attaches the
 *   header itself rather than leaving it to the app's default-headers provider: it is a fact of
 *   the service protocol, not app context, so every consumer gets it by installing one value —
 *   and no provider can override it. Fail closed: until a version is installed, no header is sent
 *   (a placeholder would masquerade as a real build in the server's record).
 * - SERVER: ServiceRouter reads the request's header through {@link fromRequest}.
 */
export class ClientBuildVersion {
  private static version: string | undefined;

  /** CLIENT: install the build version of this client (blank clears it). */
  static set(version: string | undefined): void {
    const trimmed = version?.trim();
    ClientBuildVersion.version = trimmed ? trimmed : undefined;
  }

  /** CLIENT: the installed build version, if any. */
  static get(): string | undefined {
    return ClientBuildVersion.version;
  }

  /** CLIENT: the header slice ServiceClient attaches ({} until a version is installed). */
  static headers(): { [headerName: string]: string } {
    const version = ClientBuildVersion.get();
    return version ? { [CLIENT_BUILD_VERSION_HEADER]: version } : {};
  }

  /** SERVER: the build version a request declared, if any (header names arrive lower-cased). */
  static fromRequest(request: { headers?: { [name: string]: string | string[] | undefined } }): string | undefined {
    const value = request.headers?.[CLIENT_BUILD_VERSION_HEADER];
    const declared = (Array.isArray(value) ? value[0] : value)?.trim();
    return declared ? declared : undefined;
  }
}
