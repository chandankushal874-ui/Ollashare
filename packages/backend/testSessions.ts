import { convexTest as baseConvexTest } from 'convex-test';
import schema from './convex/schema';
/** Test fixture adapter: authenticated operations use real session rows. */
export function convexTest(definition: typeof schema, modules?: Record<string, () => Promise<any>>) {
  const test = baseConvexTest(definition, modules);
  const withIdentity = test.withIdentity.bind(test);
  const sessions = new Map<string, string>();
  test.withIdentity = ((identity: { subject?: string }) => {
    const userId = identity.subject?.split('|')[0];
    const invoke = async (kind: 'query' | 'mutation' | 'action', reference: unknown, values: unknown) => {
      if (!userId) throw new Error('Test identity requires a user');
      let sessionId = sessions.get(userId);
      if (!sessionId) {
        sessionId = await test.run(async (ctx) => ctx.db.insert('authSessions', { userId: userId as never, expirationTime: Date.now() + 3_600_000 }));
        sessions.set(userId, sessionId);
      }
      const caller = withIdentity({ ...identity, subject: `${userId}|${sessionId}` });
      return (caller[kind] as Function)(reference, values);
    };
    return { query: (ref: unknown, values: unknown) => invoke('query', ref, values), mutation: (ref: unknown, values: unknown) => invoke('mutation', ref, values), action: (ref: unknown, values: unknown) => invoke('action', ref, values) } as ReturnType<typeof withIdentity>;
  }) as typeof test.withIdentity;
  return test;
}
