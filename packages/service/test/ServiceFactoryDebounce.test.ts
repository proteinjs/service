import { Method } from '@proteinjs/reflection';
import { Serializer } from '@proteinjs/serializer';
import { Debouncer } from '@proteinjs/util';
import { Service, serviceFactory } from '../src/Service';
import { ServiceClient } from '../src/ServiceClient';

/**
 * A method with a retry declaration is never debounced. The debouncer runs the call later and
 * returns nothing to the caller, so a debounced call's value — and the typed transport error the
 * declaration exists to deliver — would reach no one. The pair is refused where the two meet:
 * the client that would carry both, and the factory as soon as it is handed both configs (at the
 * consumer's module load, before any service is made), naming the method and the reason. An
 * undeclared method keeps its debounce road.
 */

beforeAll(() => {
  global.Request = class {
    constructor(
      public url: string,
      public init: any
    ) {}
  } as any;
});

interface TestService extends Service {
  doThing(arg: string): Promise<string>;
  otherThing(arg: string): Promise<string>;
}

const SERVICE_NAME = '@test/test/TestService';
const method = () => new Method('doThing', undefined, true, false, false, false, 'public', []);

describe('a declared method with a debounce config', () => {
  it('is refused at the factory, before any service is made: the error names the method and why', () => {
    expect(() => serviceFactory<TestService>(SERVICE_NAME, { doThing: { waitTime: 10 } }, { doThing: 'read' })).toThrow(
      /@test\/test\/TestService\.doThing.*cannot be debounced/
    );
  });

  it('is refused when the debouncer is one instance over every method', () => {
    expect(() =>
      serviceFactory<TestService>(SERVICE_NAME, new Debouncer(10), { doThing: { idempotent: true } })
    ).toThrow(/doThing.*cannot be debounced/);
  });

  it('is refused by the client itself — the owner of both fields', () => {
    expect(() => new ServiceClient(`/service/${SERVICE_NAME}/doThing`, method(), new Debouncer(10), 'read')).toThrow(
      /cannot be debounced/
    );
  });

  it('a debounce on one method and a declaration on another is fine', () => {
    expect(
      typeof serviceFactory<TestService>(SERVICE_NAME, { doThing: { waitTime: 10 } }, { otherThing: 'read' })
    ).toBe('function');
  });
});

describe('an undeclared debounced method', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('keeps its road: the call leaves after the wait, the caller is handed nothing to await', async () => {
    global.fetch = jest.fn(async () => ({
      status: 200,
      statusText: 'OK',
      json: async () => ({ serializedReturn: Serializer.serialize('ok') }),
    })) as any;
    const client = new ServiceClient(`/service/${SERVICE_NAME}/doThing`, method(), new Debouncer(10));
    const returned = await client.send('a');
    expect(returned).toBeUndefined();
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(10);
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(1);
  });
});
