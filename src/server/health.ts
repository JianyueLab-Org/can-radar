import { apiOrigin } from "./config";

/**
 * `/health` 给外部可用性监控用：上游 can-api 的 `/health` 回 2xx 才算好。
 * k8s 探针不指向这里 —— 上游宕机不该重启本站的 Pod。
 */

export type Check = () => Promise<void>;

export interface HealthResult {
  status: "ok" | "fail";
  checks: Record<string, string>;
}

const CHECK_TIMEOUT_MS = 3_000;
const CACHE_TTL_MS = 10_000;

export function upstreamCheck(origin: string): Check {
  return async () => {
    const res = await fetch(`${origin}/health`, {
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    await res.body?.cancel();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  };
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError") return "timeout";
    return err.message.slice(0, 120) || err.name;
  }
  return "error";
}

async function runChecks(checks: Record<string, Check>): Promise<HealthResult> {
  const entries = await Promise.all(
    Object.entries(checks).map(async ([name, check]) => {
      try {
        await check();
        return [name, "ok"] as const;
      } catch (err) {
        console.warn(`health check ${name} failed: ${errorText(err)}`);
        return [name, errorText(err)] as const;
      }
    }),
  );
  const result = Object.fromEntries(entries);
  const ok = entries.every(([, v]) => v === "ok");
  return { status: ok ? "ok" : "fail", checks: result };
}

/** 10 秒进程内缓存，刷新期间并发的请求共用同一次检查。 */
export function createHealth(
  checks: Record<string, Check>,
  now: () => number = Date.now,
): () => Promise<HealthResult> {
  let cached: { at: number; result: HealthResult } | null = null;
  let inflight: Promise<HealthResult> | null = null;
  return () => {
    if (cached && now() - cached.at < CACHE_TTL_MS)
      return Promise.resolve(cached.result);
    inflight ??= runChecks(checks)
      .then((result) => {
        cached = { at: now(), result };
        return result;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };
}

export const health = createHealth({ "can-api": upstreamCheck(apiOrigin()) });

export function healthResponse(result: HealthResult): Response {
  return new Response(JSON.stringify(result), {
    status: result.status === "ok" ? 200 : 503,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}
