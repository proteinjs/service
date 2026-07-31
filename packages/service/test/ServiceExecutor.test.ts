// EnvInfo.isDev() requires a GlobalDataStorage implementation that only exists in a running app
jest.mock('@proteinjs/server-api', () => ({
  EnvInfo: { isDev: () => true },
}));

import { Interface, Method } from '@proteinjs/reflection';
import { Serializer } from '@proteinjs/serializer';
import { Service } from '../src/Service';
import { ServiceError, ServiceExecutor } from '../src/ServiceExecutor';
import { ServiceRouter } from '../src/ServiceRouter';

type RouterInternals = {
  serviceExecutorMap: { [path: string]: ServiceExecutor };
};

const createExecutor = (service: Service, methodName: string) => {
  const method = new Method(methodName, undefined, true, false, false, false, 'public', []);
  const _interface = new Interface('@test/test', 'TestService', [], [method]);
  return new ServiceExecutor(service, _interface, method);
};

const createRouter = (servicePath: string, executor: ServiceExecutor) => {
  const router = new ServiceRouter();
  (router as unknown as RouterInternals).serviceExecutorMap = { [servicePath]: executor };
  return router;
};

const createResponse = () => {
  const sent: { status?: number; body?: any } = {};
  const response: any = {
    status(code: number) {
      sent.status = code;
      return response;
    },
    send(body: any) {
      sent.body = body;
      return response;
    },
  };
  return { response, sent };
};

describe('service error transport', () => {
  it('preserves the thrown message on the wire when a service method fails', async () => {
    const service = {
      serviceMetadata: { auth: { public: true } },
      doThing: async () => {
        throw new Error('Release blocked: workspace has uncommitted changes');
      },
    } as unknown as Service;
    const router = createRouter('/service/@test/test/TestService/doThing', createExecutor(service, 'doThing'));
    const { response, sent } = createResponse();

    await router.onRequest(
      { path: '/service/@test/test/TestService/doThing', body: Serializer.serialize([]) },
      response
    );

    expect(sent.status).toBe(400);
    expect(sent.body).toEqual({ error: 'Release blocked: workspace has uncommitted changes' });
  });

  it('preserves non-Error throws as their string form', async () => {
    const service = {
      serviceMetadata: { auth: { public: true } },
      doThing: async () => {
        throw 'plain string refusal';
      },
    } as unknown as Service;
    const executor = createExecutor(service, 'doThing');

    await expect(executor.execute(Serializer.serialize([]))).rejects.toThrow(new ServiceError('plain string refusal'));
  });

  it('sends the authorization refusal message to the client', async () => {
    const service = {
      serviceMetadata: { auth: { canAccess: () => false } },
      doThing: async () => 'never reached',
    } as unknown as Service;
    const router = createRouter('/service/@test/test/TestService/doThing', createExecutor(service, 'doThing'));
    const { response, sent } = createResponse();

    await router.onRequest(
      { path: '/service/@test/test/TestService/doThing', body: Serializer.serialize([]) },
      response
    );

    expect(sent.status).toBe(400);
    expect(sent.body).toEqual({ error: 'User not authorized to run service: TestService.doThing' });
  });

  it('masks non-ServiceError failures as a 500 internal server error', async () => {
    const service = {
      serviceMetadata: { auth: { public: true } },
      doThing: async () => 'never reached',
    } as unknown as Service;
    const router = createRouter('/service/@test/test/TestService/doThing', createExecutor(service, 'doThing'));
    const { response, sent } = createResponse();

    // malformed request body makes Serializer.deserialize throw outside the executor's service-call catch
    await router.onRequest({ path: '/service/@test/test/TestService/doThing', body: '{not json' }, response);

    expect(sent.status).toBe(500);
    expect(sent.body).toEqual({ error: 'Internal server error' });
  });
});
