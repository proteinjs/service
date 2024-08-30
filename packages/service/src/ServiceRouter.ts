import { Route } from '@proteinjs/server-api';
import { Service } from './Service';
import { Interface, SourceRepository } from '@proteinjs/reflection';
import { ServiceError, ServiceExecutor } from './ServiceExecutor';
import { isInstanceOf } from '@proteinjs/util';
import { Logger } from '@proteinjs/logger';

function isServiceError(error: unknown): error is ServiceError {
  return (
    typeof error === 'object' && error !== null && 'name' in error && (error as ServiceError).name === 'ServiceError'
  );
}

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
      response.send({ error });
      return;
    }

    try {
      const serializedReturn = await serviceExecutor.execute(request.body);
      response.send({ serializedReturn });
    } catch (error: any) {
      let errorMessage = error.message;
      if (!isServiceError(error)) {
        this.logger.error({ error });
        errorMessage = 'Internal server error';
      }
      response.send({ error: errorMessage });
    }
  }
}
