import { Route } from '@proteinjs/server-api';
import { Service } from './Service';
import { Interface, SourceRepository } from '@proteinjs/reflection';
import { ServiceExecutor } from './ServiceExecutor';
import { Logger, isInstanceOf } from '@proteinjs/util';

export class ServiceRouter implements Route {
  private logger = new Logger(this.constructor.name);
  private serviceExecutorMap: {[path: string]: ServiceExecutor}|undefined;
  path = 'service/*';
  method: 'post' = 'post';

  private getServiceExecutorMap() {
    if (!this.serviceExecutorMap) {
      this.serviceExecutorMap = {};
      const serviceTypes = Object.values(SourceRepository.get().directChildren('@proteinjs/service/Service'));
      for (let serviceType of serviceTypes) {
        this.logger.info(`Loading service: ${serviceType.qualifiedName}`);
        if (!isInstanceOf(serviceType, Interface))
          continue;

        const service = SourceRepository.get().object<Service>(serviceType.qualifiedName);
        for (let method of (serviceType as Interface).methods) {
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
        this.logger.error(error);
        response.send({ error });
        return;
      }

      try {
        const serializedReturn = await serviceExecutor.execute(request.body);
        response.send({ serializedReturn });
      } catch (error: any) {
        this.logger.error(error.stack);
        response.send({ error: error.message });
      }
  }
}