import { SerializableFunction, NotFunction } from '@proteinjs/serializer';
import { Loadable, SourceRepository, Method } from '@proteinjs/reflection';
import { ServiceClient } from './ServiceClient';

export interface Service extends Loadable {
  serviceMetadata?: {
    auth?: {
      /** If true, the user does not need to be logged in or have any roles to call this service. If blank, defaults to false. */
      public?: boolean;
      /** If true, the user does not need to have any roles to call this service, but must be logged in. If blank, defaults to false. */
      allUsers?: boolean;
      /** The user must be logged in and have these roles to call this service. If blank, defaults to requiring the 'admin' role. */
      roles?: string[];
      /**
       * Custom auth function. If provided, all other auth properties are ignored.
       * @param methodName the name of the service method to be executed
       * @param args the args[] that will be passed into the method
       * @return true if the user can access the service method
       */
      canAccess?: (methodName: string, args: any[]) => boolean;
    };
    /** Don't await the service's execution, return a response to the client immediately */
    doNotAwait?: boolean;
  };
  [prop: string]: SerializableFunction | NotFunction<any>;
}

/**
 * Create a factory that creates an instance of the Service. The Service instance is a
 * ServiceClient wrapped in the interface's api.
 * @param serviceInterfaceQualifiedName the package-qualified name of the service interface (ie. service-package-name/MyService)
 * @returns a function that creates a Service
 */
export const serviceFactory = <T extends Service>(serviceInterfaceQualifiedName: string): (() => T) => {
  return () => {
    const service: any = {};
    const serviceInterface = SourceRepository.get().interface(serviceInterfaceQualifiedName);
    for (const method of serviceInterface.methods) {
      const servicePath = `/service/${serviceInterface.qualifiedName}/${method.name}`;
      const serviceClient = new ServiceClient(servicePath);
      service[method.name] = serviceClient.send.bind(serviceClient);
    }

    return service;
  };
};
