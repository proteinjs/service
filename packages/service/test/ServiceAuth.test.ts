import { UserAuth } from '@proteinjs/user-auth';
import { ServiceAuth } from '../src/ServiceAuth';
import { Service } from '../src/Service';

/**
 * Covers the serviceMetadata auth gate's resolution order, in particular the permission door:
 * generic services declare `{ permission: '<slug>' }` and the slug resolves to consumer roles
 * through `UserAuth.hasPermission` (admin passes via break-glass). Defaults are unchanged —
 * no auth block still means the admin door.
 *
 * `UserAuth` reads from a static repo; tests stub it directly per identity — no server needed.
 */

type UserAuthInternals = {
  userRepo?: { getUser: () => { email: string; roles: string[] } };
  permissionRolesMapping?: { getRoles: (permission: string) => string[] | undefined };
};

const setUser = (roles: string[]) => {
  (UserAuth as unknown as UserAuthInternals).userRepo = {
    getUser: () => ({ email: 'user@test.local', roles }),
  };
};

const setMapping = (mapping: { [permission: string]: string[] }) => {
  (UserAuth as unknown as UserAuthInternals).permissionRolesMapping = {
    getRoles: (permission: string) => mapping[permission],
  };
};

const clear = () => {
  (UserAuth as unknown as UserAuthInternals).userRepo = undefined;
  (UserAuth as unknown as UserAuthInternals).permissionRolesMapping = undefined;
};

const method = { name: 'doThing' } as any;

const serviceWith = (auth: NonNullable<Service['serviceMetadata']>['auth']): Service =>
  ({ serviceMetadata: { auth } }) as unknown as Service;

const canRun = (auth: NonNullable<Service['serviceMetadata']>['auth']) =>
  ServiceAuth.canRunService(serviceWith(auth), method, []);

describe('ServiceAuth — permission door', () => {
  afterEach(clear);

  it('grants a holder of a role the consumer maps to the permission', () => {
    setUser(['ops']);
    setMapping({ ops: ['ops'] });
    expect(canRun({ permission: 'ops' })).toBe(true);
  });

  it('denies a logged-in user without a mapped role', () => {
    setUser(['dev']);
    setMapping({ ops: ['ops'] });
    expect(canRun({ permission: 'ops' })).toBe(false);
  });

  it('admin passes any permission (break-glass), even unmapped', () => {
    setUser(['admin']);
    expect(canRun({ permission: 'ops' })).toBe(true);
  });

  it('permission takes precedence over roles when both are set', () => {
    // Holds the roles-listed role but not the permission: the permission decides.
    setUser(['legacy-role']);
    setMapping({ ops: ['ops'] });
    expect(canRun({ permission: 'ops', roles: ['legacy-role'] })).toBe(false);

    // Holds the mapped role but not the listed role: still granted through the permission.
    setUser(['ops']);
    expect(canRun({ permission: 'ops', roles: ['legacy-role'] })).toBe(true);
  });
});

describe('ServiceAuth — existing doors unchanged', () => {
  afterEach(clear);

  it('no auth block defaults to the admin door', () => {
    setUser([]);
    expect(ServiceAuth.canRunService({} as unknown as Service, method, [])).toBe(false);
    setUser(['admin']);
    expect(ServiceAuth.canRunService({} as unknown as Service, method, [])).toBe(true);
  });

  it('roles door still grants role holders', () => {
    setUser(['ops']);
    expect(canRun({ roles: ['ops'] })).toBe(true);
    setUser(['dev']);
    expect(canRun({ roles: ['ops'] })).toBe(false);
  });

  it('public and allUsers still short-circuit ahead of the permission door', () => {
    clear();
    expect(canRun({ public: true, permission: 'ops' })).toBe(true);
    setUser([]);
    expect(canRun({ allUsers: true, permission: 'ops' })).toBe(true);
  });
});
