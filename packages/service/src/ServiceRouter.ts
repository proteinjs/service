import { Route } from '@proteinjs/server-api';
import { Service } from './Service';
import { Interface, SourceRepository } from '@proteinjs/reflection';
import { ServiceError, ServiceExecutor } from './ServiceExecutor';
import { ServiceRefusal } from './ServiceRefusal';
import {
  DECLARED_READ_HEADER,
  IDEMPOTENCY_KEY_HEADER,
  REQUEST_ID_HEADER,
  SERIALIZED_RETURN_MEDIA_TYPE,
} from './ServiceClient';
import { isInstanceOf } from '@proteinjs/util';
import { Logger } from '@proteinjs/logger';

function isServiceError(error: unknown): error is ServiceError {
  return (
    typeof error === 'object' && error !== null && 'name' in error && (error as ServiceError).name === 'ServiceError'
  );
}

/**
 * The service route. An answer is the serialized return — the string the executor produced —
 * written as the response body itself under {@link SERIALIZED_RETURN_MEDIA_TYPE}, for a client that
 * asked for that form (its `Accept` names the type). The body was once an object wrapping the
 * string (`{ serializedReturn }`), which the web framework serialized again — a second full pass
 * over a large answer, re-escaping every quote and line break in it. A client built before it
 * learned the bare form sends no such `Accept` and still receives the envelope: kept for one release
 * so a server built after this change answers a page built before it, and removed once no client in
 * the field is without the `Accept`.
 *
 * A verdict (a refusal's status, a 400 for a service error, a 500) is chosen after the method ran
 * and rides as `{ error }` under its status, whichever form the client asked for.
 */
export class ServiceRouter implements Route {
  private logger = new Logger({ name: this.constructor.name });
  private serviceExecutorMap: { [path: string]: ServiceExecutor } | undefined;
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
      const error = `Unable to find service matching path: ${request.path}`;
      this.logger.error({ message: error });
      response.status(404).send({ error });
      return;
    }

    try {
      const serializedReturn: string | undefined = await serviceExecutor.execute(request.body, {
        idempotencyKey: ServiceRouter.idempotencyKeyOf(request),
        declaredRead: ServiceRouter.declaredRead(request),
        requestId: ServiceRouter.requestIdOf(response),
      });
      if (ServiceRouter.acceptsSerializedReturn(request)) {
        // The answer's own text as the body; an answer with no text (an undefined return) is an empty body.
        response.type(SERIALIZED_RETURN_MEDIA_TYPE).send(serializedReturn ?? '');
        return;
      }
      response.send({ serializedReturn });
    } catch (error: any) {
      if (ServiceRefusal.is(error)) {
        // A deliberate refusal answers with its own status; the message crosses the wire.
        response.status(error.status).send({ error: error.message });
        return;
      }

      if (isServiceError(error)) {
        // ServiceExecutor wraps service-thrown errors in ServiceError; the message crosses the wire.
        response.status(400).send({ error: error.message });
        return;
      }

      this.logger.error({ error });
      response.status(500).send({ error: 'Internal server error' });
    }
  }

  /** The call's idempotency key, when the client sent one (header names arrive lower-cased). */
  private static idempotencyKeyOf(request: any): string | undefined {
    const value = request.headers?.[IDEMPOTENCY_KEY_HEADER.toLowerCase()];
    return typeof value === 'string' && value !== '' ? value : undefined;
  }

  /** Whether the client declared the delivery a read (see the client's `DECLARED_READ_HEADER`). */
  private static declaredRead(request: any): boolean {
    return request.headers?.[DECLARED_READ_HEADER.toLowerCase()] === 'true';
  }

  /**
   * Whether the client asked for the answer as the serialized text itself: its `Accept` names
   * {@link SERIALIZED_RETURN_MEDIA_TYPE} by name. Read literally — a browser's default `Accept` of
   * every type is not that ask, and an earlier client sends it.
   */
  private static acceptsSerializedReturn(request: any): boolean {
    const accept = request.headers?.accept;
    return typeof accept === 'string' && accept.includes(SERIALIZED_RETURN_MEDIA_TYPE);
  }

  /** The request's id, as the server echoed it on the response ({@link REQUEST_ID_HEADER}); none when the host set none. */
  private static requestIdOf(response: any): string | undefined {
    const value = response.getHeader(REQUEST_ID_HEADER);
    return typeof value === 'string' && value !== '' ? value : undefined;
  }
}
