import { Buffer } from "node:buffer";

type Limits = {
  maxEntries: number;
  maxBytes: number;
  maxBodyBytes: number;
  maxKeyBytes: number;
  maxInFlight: number;
};

type ProxyOptions = {
  ttlSeconds: number;
  timeoutMs: number;
  validate: (payload: unknown) => boolean;
};

type Snapshot = {
  body: string;
  status: number;
  headers: Record<string, string>;
  cacheable: boolean;
};

type Entry = { response: Snapshot; expiresAt: number; bytes: number };

const DEFAULT_LIMITS: Limits = {
  maxEntries: 512,
  maxBytes: 32 * 1024 * 1024,
  maxBodyBytes: 1024 * 1024,
  maxKeyBytes: 4 * 1024,
  maxInFlight: 64,
};

/** Public anonymous proxies only. Each Node process owns its bounded cache. */
export class PublicProxyCache {
  private readonly entries = new Map<string, Entry>();
  private readonly inFlight = new Map<string, Promise<Snapshot>>();
  private readonly limits: Limits;
  private storedBytes = 0;

  constructor(
    limits: Partial<Limits> = {},
    private readonly now: () => number = () => Date.now(),
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  async fetch(url: string, options: ProxyOptions): Promise<Response> {
    // The complete fixed upstream URL is the key, including its query.
    const cacheKeyAllowed = Buffer.byteLength(url) <= this.limits.maxKeyBytes;
    if (cacheKeyAllowed) {
      const cached = this.entries.get(url);
      if (cached) {
        if (cached.expiresAt > this.now()) {
          this.entries.delete(url);
          this.entries.set(url, cached);
          return this.respond(cached.response);
        }
        this.remove(url);
      }
    }

    const pending = this.inFlight.get(url);
    if (pending) return this.respond(await pending);

    if (this.inFlight.size >= this.limits.maxInFlight) {
      return this.respond(this.failure());
    }

    const task = this.load(url, options)
      .then((response) => {
        if (cacheKeyAllowed && response.cacheable) {
          this.store(url, response, options.ttlSeconds);
        }
        return response;
      })
      .finally(() => this.inFlight.delete(url));
    this.inFlight.set(url, task);
    return this.respond(await task);
  }

  private failure(): Snapshot {
    return {
      body: JSON.stringify({ status: 502, error: "上游没有响应。" }),
      status: 502,
      headers: { "Content-Type": "application/json" },
      cacheable: false,
    };
  }

  private respond(response: Snapshot): Response {
    return new Response(response.body, {
      status: response.status,
      headers: response.headers,
    });
  }

  private async load(url: string, options: ProxyOptions): Promise<Snapshot> {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Accept: "application/json" },
        credentials: "omit",
        // Shared work owns its timeout, not any individual caller's signal.
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch {
      return this.failure();
    }

    const body = await this.readBody(response);
    if (body === null) return this.failure();
    const contentType =
      response.headers.get("content-type") ?? "application/json";
    let cacheable = false;
    if (
      response.ok &&
      /^application\/json\s*(?:;|$)/i.test(contentType) &&
      !response.headers.has("set-cookie") &&
      !response.headers.has("www-authenticate") &&
      !/(?:^|,)\s*(?:cookie|authorization|\*)\s*(?:,|$)/i.test(
        response.headers.get("vary") ?? "",
      ) &&
      !/(?:^|,)\s*private(?:\s|=|,|$)/i.test(
        response.headers.get("cache-control") ?? "",
      )
    ) {
      try {
        cacheable = options.validate(JSON.parse(body));
      } catch {
        // Invalid success bodies are forwarded unchanged, but not cached.
      }
    }

    return {
      body,
      status: response.status,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": cacheable
          ? `public, max-age=${options.ttlSeconds}`
          : "no-store",
      },
      cacheable,
    };
  }

  private async readBody(response: Response): Promise<string | null> {
    if (!response.body) return "";
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > this.limits.maxBodyBytes) {
          await reader.cancel();
          return null;
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(body);
  }
  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (entry) {
      this.storedBytes -= entry.bytes;
      this.entries.delete(key);
    }
  }

  private store(key: string, response: Snapshot, ttlSeconds: number): void {
    const bytes = Buffer.byteLength(response.body);
    if (
      this.limits.maxEntries < 1 ||
      bytes > this.limits.maxBytes ||
      bytes > this.limits.maxBodyBytes
    ) {
      return;
    }
    const now = this.now();
    for (const [expiredKey, entry] of this.entries) {
      if (entry.expiresAt <= now) this.remove(expiredKey);
    }
    while (
      this.entries.size >= this.limits.maxEntries ||
      this.storedBytes + bytes > this.limits.maxBytes
    ) {
      this.remove(this.entries.keys().next().value!);
    }
    this.entries.set(key, {
      response,
      expiresAt: now + ttlSeconds * 1000,
      bytes,
    });
    this.storedBytes += bytes;
  }
}

export function isPublicMetar(payload: unknown, icao: string): boolean {
  if (!isRecord(payload)) return false;
  return payload.icao === icao && typeof payload.metar === "string";
}

export function isPublicRoute(payload: unknown): boolean {
  if (!isRecord(payload) || payload.status !== 200 || !isRecord(payload.data)) {
    return false;
  }
  const points = payload.data.points;
  return (
    Array.isArray(points) &&
    points.every(
      (point) =>
        isRecord(point) &&
        typeof point.ident === "string" &&
        typeof point.lat === "number" &&
        Number.isFinite(point.lat) &&
        Math.abs(point.lat) <= 90 &&
        typeof point.lon === "number" &&
        Number.isFinite(point.lon) &&
        Math.abs(point.lon) <= 180 &&
        typeof point.kind === "string" &&
        ["airport", "fix", "airway", "sid", "star"].includes(point.kind) &&
        (point.via === undefined || typeof point.via === "string"),
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const publicProxyCache = new PublicProxyCache();
