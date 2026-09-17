import { Logger, type Log, type DefaultLogWriter } from '@proteinjs/logger';
import { ServiceRouter } from '../src/ServiceRouter';

type RouterInternals = { logger: Logger; serviceExecutorMap: Record<string, unknown> };

/**
 * An unknown service door answers 404 — a client calling a door this build does not declare
 * (a build ahead of or behind the server's). The line that records it names the path AND the
 * status it answered, so a log pipeline reading the line beside the request's own facts (the
 * caller's declared build, the server's) can tell a rollout from a stale client from a door
 * that never landed.
 */
describe('ServiceRouter — an unknown door', () => {
  it('answers 404 and logs the path with the status it answered', async () => {
    const router = new ServiceRouter();
    const entries: Log[] = [];
    const internals = router as unknown as RouterInternals;
    internals.serviceExecutorMap = {};
    internals.logger = new Logger({
      name: 'ServiceRouter',
      logWriter: { write: (log: Log) => entries.push(log) } as unknown as DefaultLogWriter,
    });
    const response = { status: jest.fn().mockReturnThis(), send: jest.fn() };

    await router.onRequest({ path: '/service/@x/y/ZService/doThing', body: '[]' }, response);

    expect(response.status).toHaveBeenCalledWith(404);
    expect(response.send).toHaveBeenCalledWith({
      error: 'Unable to find service matching path: /service/@x/y/ZService/doThing',
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].logLevel).toBe('error');
    expect(entries[0].obj).toEqual({ path: '/service/@x/y/ZService/doThing', status: 404 });
  });
});
