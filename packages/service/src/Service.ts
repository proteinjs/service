import { SerializableFunction, NotFunction } from '@proteinjs/serializer';
import { Loadable, SourceRepository } from '@proteinjs/reflection';
import { ServiceClient } from './ServiceClient';
import { Debouncer, isInstanceOf } from '@proteinjs/util';

type RemoveIndex<T> = {
  [K in keyof T as string extends K ? never : number extends K ? never : symbol extends K ? never : K]: T[K];
};
type KeysWithoutIndexSignature<T> = keyof RemoveIndex<T>;

// Get keys of T that are not in U
type Diff<T, U> = T extends U ? never : T;

// Get only the keys specific to T, excluding those from Service
type KeysWithoutService<T extends Service> = Diff<KeysWithoutIndexSignature<T>, KeysWithoutIndexSignature<Service>>;

type RetryConfig<T extends Service> = {
  [K in KeysWithoutService<T>]?: number;
};

interface DebounceConfig {
  waitTime: number;
}

type MethodDebounceConfig<T extends Service> = {
  [K in KeysWithoutService<T>]?: DebounceConfig;
};

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

const debouncerMap: { [key: string]: Debouncer } = {};
/** Retrieve an existing debouncer from the map or make a new one.
 * This allows the debouncer instance per method to remain the same across multiple service calls.
 */
function getOrCreateDebouncer(methodName: string, waitTime: number): Debouncer {
  if (!debouncerMap[methodName]) {
    debouncerMap[methodName] = new Debouncer(waitTime);
  }
  return debouncerMap[methodName];
}

/**
 * Create a factory that creates an instance of the Service. The Service instance is a
 * ServiceClient wrapped in the interface's api.
 * @param serviceInterfaceQualifiedName the package-qualified name of the service interface (ie. service-package-name/MyService)
 * @param debouncer pass in either a single debouncer instance or method-specific debounce configurations
 * @returns a function that creates a Service
 */
export const serviceFactory = <T extends Service>(
  serviceInterfaceQualifiedName: string,
  debouncer?: MethodDebounceConfig<T> | Debouncer,
  retryConfig?: RetryConfig<T>
): (() => T) => {
  return () => {
    const service: any = {};
    const serviceInterface = SourceRepository.get().interface(serviceInterfaceQualifiedName);
    for (const method of serviceInterface.methods) {
      const servicePath = `/service/${serviceInterface.qualifiedName}/${method.name}`;
      const methodName = method.name as KeysWithoutService<T>;

      let retryCount = 0;
      if (retryConfig && methodName in retryConfig) {
        retryCount = retryConfig[methodName]!;
      }

      let methodDebouncer: Debouncer | undefined;
      if (debouncer) {
        if (isInstanceOf(debouncer, Debouncer)) {
          methodDebouncer = debouncer as Debouncer;
        } else if (methodName in debouncer) {
          const methodConfig = debouncer[methodName];
          if (methodConfig) {
            methodDebouncer = getOrCreateDebouncer(methodName, methodConfig.waitTime);
          }
        }
      }

      const serviceClient = new ServiceClient(servicePath, method, methodDebouncer, retryCount);
      service[methodName] = serviceClient.send.bind(serviceClient);
    }

    return service;
  };
};
