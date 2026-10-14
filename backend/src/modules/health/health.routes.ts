import type { FastifyPluginAsync } from "fastify";

export type HealthChecks = Record<string, () => Promise<unknown>>;

const TIMEOUT_MS = 2000;

function withTimeout<T>(p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS).unref()),
  ]);
}

// /health/live  -> process is up (container restart probe)
// /health/ready -> every dependency answers (load balancer / compose probe); 503 lists what is down
export const healthRoutes =
  (checks: HealthChecks): FastifyPluginAsync =>
  async (app) => {
    app.get("/health/live", async () => ({ status: "ok" }));

    app.get("/health/ready", async (_req, reply) => {
      const names = Object.keys(checks);
      const results = await Promise.allSettled(names.map((n) => withTimeout(Promise.resolve().then(checks[n]!))));
      const deps = Object.fromEntries(
        results.map((r, i) => [names[i], r.status === "fulfilled" ? "up" : `down: ${(r.reason as Error).message}`]),
      );
      const ok = results.every((r) => r.status === "fulfilled");
      return reply.code(ok ? 200 : 503).send({ status: ok ? "ok" : "degraded", deps });
    });
  };
