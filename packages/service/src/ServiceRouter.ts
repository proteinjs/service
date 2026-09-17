import { Route } from '@proteinjs/server-api';
import { Service } from './Service';
import { Interface, SourceRepository } from '@proteinjs/reflection';
import { ServiceError, ServiceExecutor } from './ServiceExecutor';
import { isInstanceOf } from '@proteinjs/util';
import { Logger } from '@proteinjs/logger';
import { ClientBuildVersion } from './ClientBuildVersion';
import { getServerBuildVersion } from './ServerBuildVersion';

function isServiceError(error: unknown): error is ServiceError {
  return (
    typeof error === 'object' && error !== null && 'name' in error && (error as ServiceError).name === 'ServiceError'
  );
}

/**
 * How an unknown service path is recorded, by the one comparison that diagnoses it: the caller's
 * declared build version against this server's.
 */
type UnknownPathDiagnosis = { logLevel: 'warn' | 'error'; message: string };

export class ServiceRouter implements Route {
  private logger = new Logger({ name: this.constructor.name });
  private serviceExecutorMap: { [path: string]: ServiceExecutor } | undefined;
  private resolvedServerBuildVersion: { version: string | undefined } | undefined;
  path = 'service/*';
  method: 'post' = 'post';

  private getServiceExecutorMap() {
    if (!this.serviceExecutorMap) {
      this.serviceExecutorMap = {};
      const serviceTypes = Object.values(SourceRepository.get().directChildren('@proteinjs/service/Service'));
      for (const serviceType of serviceTypes) {
        this.logger.info({ message: `Loading service: ${serviceType.qualifiedName}` });
        if (!isInstanceOf(serviceType, Interface)) {
          continue;
        }

        const service = SourceRepository.get().object<Service>(serviceType.qualifiedName);
        for (const method of (serviceType as Interface).methods) {
          const servicePath = `/service/${serviceType.qualifiedName}/${method.name}`;
          this.serviceExecutorMap[servicePath] = new ServiceExecutor(service, serviceType as Interface, method);
        }
      }
    }

    return this.serviceExecutorMap;
  }

  async onRequest(request: any, response: any): Promise<any> {
    const serviceExecutor = this.getServiceExecutorMap()[request.path];
    if (!serviceExecutor) {
      this.logUnknownPath(request);
      response.status(404).send({ error: `Unable to find service matching path: ${request.path}` });
      return;
    }

    try {
      const serializedReturn = await serviceExecutor.execute(request.body);
      response.send({ serializedReturn });
    } catch (error: any) {
      if (isServiceError(error)) {
        // ServiceExecutor wraps service-thrown errors in ServiceError; the message crosses the wire.
        response.status(400).send({ error: error.message });
        return;
      }

      this.logger.error({ error });
      response.status(500).send({ error: 'Internal server error' });
    }
  }

  /**
   * A request for a service path this server does not register is, far more often than a
   * defect, a build skew between the caller and the server — and which kind it is turns on ONE
   * comparison, so the record carries both sides (the caller's `x-client-version` header, see
   * ClientBuildVersion; the server's ServerBuildVersion) and names the class:
   *
   *  - the caller's build is NEWER: a rollout in progress — the bundle a new server build served
   *    reached a pod still running the previous build. Expected and transient: warn.
   *  - the caller's build is OLDER: a stale client (a tab loaded before a deploy) calling a
   *    service the newer server renamed or removed. Expected until the client reloads: warn.
   *  - the SAME build: the client calls a service its own server build does not register — a
   *    client shipped ahead of its server half. A defect: error.
   *  - the versions cannot be ordered (a side declares none, or a build id that is not a release
   *    version): nothing rules out a defect. Error, with what was declared verbatim.
   *
   * One fixed message per class so the record groups by class, never by path; the path and both
   * versions are the entry's `obj`. The 404 body is unchanged.
   */
  private logUnknownPath(request: any): void {
    const clientVersion = ClientBuildVersion.fromRequest(request);
    const serverVersion = this.serverBuildVersion();
    const { logLevel, message } = this.diagnoseUnknownPath(clientVersion, serverVersion);
    this.logger[logLevel]({ message, obj: { path: request.path, clientVersion, serverVersion } });
  }

  private diagnoseUnknownPath(
    clientVersion: string | undefined,
    serverVersion: string | undefined
  ): UnknownPathDiagnosis {
    const order = this.compareReleaseVersions(clientVersion, serverVersion);
    if (order === undefined) {
      return {
        logLevel: 'error',
        message:
          'Unknown service path: the client build and the server build cannot be ordered ' +
          '(a build version is absent or not a release version)',
      };
    }

    if (order > 0) {
      return {
        logLevel: 'warn',
        message: 'Unknown service path: the client build is newer than this server build (a rollout in progress)',
      };
    }

    if (order < 0) {
      return {
        logLevel: 'warn',
        message:
          'Unknown service path: the client build is older than this server build ' +
          '(a stale client calling a renamed or removed service)',
      };
    }

    return {
      logLevel: 'error',
      message:
        'Unknown service path: the client build declares the same version as this server build, ' +
        'which does not register the service',
    };
  }

  /** The running server's declared build version (ServerBuildVersion), resolved once. */
  private serverBuildVersion(): string | undefined {
    if (!this.resolvedServerBuildVersion) {
      this.resolvedServerBuildVersion = { version: getServerBuildVersion()?.getVersion() };
    }

    return this.resolvedServerBuildVersion.version;
  }

  /**
   * Numeric order of two release versions: negative when `a` is older, positive when newer, 0
   * when equal; undefined when either is not a release version.
   */
  private compareReleaseVersions(a: string | undefined, b: string | undefined): number | undefined {
    const parsedA = this.parseReleaseVersion(a);
    const parsedB = this.parseReleaseVersion(b);
    if (!parsedA || !parsedB) {
      return undefined;
    }

    for (let i = 0; i < parsedA.length; i++) {
      if (parsedA[i] !== parsedB[i]) {
        return parsedA[i] - parsedB[i];
      }
    }

    return 0;
  }

  /** `MAJOR.MINOR.PATCH` (an optional leading `v`) as numbers; undefined for anything else. */
  private parseReleaseVersion(version: string | undefined): number[] | undefined {
    const match = version?.match(/^v?(\d+)\.(\d+)\.(\d+)$/);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
  }
}
