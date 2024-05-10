import { Method } from '@proteinjs/reflection';
import { UserAuth } from '@proteinjs/user-auth';
import { Service } from './Service';

export class ServiceAuth {
  static canRunService(service: Service, method: Method, deserializedArgs: any): boolean {
    if (service.serviceMetadata?.auth?.canAccess) {
      return service.serviceMetadata.auth.canAccess(method.name, deserializedArgs);
    }

    if (service.serviceMetadata?.auth?.public) {
      return true;
    }

    if (service.serviceMetadata?.auth?.allUsers) {
      return UserAuth.isLoggedIn();
    }

    if (!service.serviceMetadata?.auth?.roles) {
      return UserAuth.hasRole('admin');
    }

    return UserAuth.hasRoles(service.serviceMetadata.auth?.roles);
  }
}
