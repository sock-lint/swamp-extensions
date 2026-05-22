/**
 * `@lint/cert-health` — TLS-certificate expiry tracker.
 *
 * Two complementary methods:
 *
 * 1. `syncNpm` — log into Nginx Proxy Manager via `POST /api/tokens` (same
 *    auth flow as `@lint/nginx-proxy-manager`), fetch every cert from
 *    `/api/nginx/certificates`, project into a typed inventory + summary.
 *    Catches certs NPM is *trying* to manage even if nothing is currently
 *    requesting them through the proxy.
 *
 * 2. `probe` — for a list of hostnames, open a TLS connection via
 *    `openssl s_client`, extract the leaf cert (subject, issuer, notAfter),
 *    and compute days-until-expiry. Catches what the *public* actually sees
 *    — important when a CDN's edge cert (not NPM's) is the user-facing
 *    certificate.
 *
 * Probes run in parallel via `Promise.all` (fan-out, no per-call lock
 * contention). Status thresholds: `ok` (>30d), `warn` (14–30d), `critical`
 * (<14d), `expired` (<0d), `error` (probe failed).
 */
import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  npmBaseUrl: z.string().describe(
    "NPM base URL, e.g. http://192.168.4.60:81 (no trailing slash)",
  ),
  npmEmail: z.string().describe("NPM admin email (vault-resolved)"),
  npmPassword: z.string().describe("NPM admin password (vault-resolved)"),
  warnThresholdDays: z.number().default(30).describe(
    "Days-remaining below which a cert is `warn`",
  ),
  criticalThresholdDays: z.number().default(14).describe(
    "Days-remaining below which a cert is `critical`",
  ),
  requestTimeoutSec: z.number().default(15),
  probeTimeoutSec: z.number().default(10),
});

const StatusEnum = z.enum(["ok", "warn", "critical", "expired", "error"]);

const NpmCertSchema = z.object({
  id: z.number(),
  provider: z.string(),
  niceName: z.string(),
  domainNames: z.array(z.string()),
  expiresOn: z.string().nullable(),
  daysRemaining: z.number().nullable(),
  status: StatusEnum,
});

const NpmInventorySchema = z.object({
  fetchedAt: z.iso.datetime(),
  npmBaseUrl: z.string(),
  certs: z.array(NpmCertSchema),
});

const NpmSummarySchema = z.object({
  fetchedAt: z.iso.datetime(),
  totalCount: z.number(),
  okCount: z.number(),
  warnCount: z.number(),
  criticalCount: z.number(),
  expiredCount: z.number(),
  worstExpiring: z.array(z.object({
    niceName: z.string(),
    domainNames: z.array(z.string()),
    expiresOn: z.string().nullable(),
    daysRemaining: z.number().nullable(),
    status: StatusEnum,
  })).describe("Top 10 closest-to-expiry"),
});

const ProbeResultSchema = z.object({
  host: z.string(),
  port: z.number(),
  ok: z.boolean(),
  subject: z.string().nullable(),
  issuer: z.string().nullable(),
  expiresAt: z.string().nullable(),
  daysRemaining: z.number().nullable(),
  status: StatusEnum,
  error: z.string().nullable(),
});

const ProbeResultsSchema = z.object({
  probedAt: z.iso.datetime(),
  results: z.array(ProbeResultSchema),
});

const ProbeSummarySchema = z.object({
  probedAt: z.iso.datetime(),
  totalCount: z.number(),
  okCount: z.number(),
  warnCount: z.number(),
  criticalCount: z.number(),
  expiredCount: z.number(),
  errorCount: z.number(),
  worstExpiring: z.array(z.object({
    host: z.string(),
    issuer: z.string().nullable(),
    expiresAt: z.string().nullable(),
    daysRemaining: z.number().nullable(),
    status: StatusEnum,
  })).describe("Top 10 closest-to-expiry (excludes errors)"),
});

const SyncLogSchema = z.object({
  ranAt: z.iso.datetime(),
  method: z.string(),
  ok: z.boolean(),
  detail: z.string().nullable(),
});

// deno-lint-ignore no-explicit-any
type ExecuteArgs = any;
// deno-lint-ignore no-explicit-any
type ExecuteContext = any;

async function curlReq(
  method: "GET" | "POST",
  url: string,
  headers: string[],
  body?: string,
  timeoutSec = 15,
): Promise<{ status: number; body: string }> {
  const args = ["-sS", "-X", method, "-m", String(timeoutSec)];
  for (const h of headers) args.push("-H", h);
  args.push("-w", "\n__HTTP_STATUS__:%{http_code}");
  if (body != null) args.push("--data-binary", "@-");
  args.push(url);
  const cmd = new Deno.Command("curl", {
    args,
    stdin: body != null ? "piped" : "null",
    stdout: "piped",
    stderr: "piped",
  });
  const proc = cmd.spawn();
  if (body != null) {
    const w = proc.stdin.getWriter();
    await w.write(new TextEncoder().encode(body));
    await w.close();
  }
  const { code, stdout, stderr } = await proc.output();
  if (code !== 0) {
    throw new Error(
      `curl ${method} ${url} exit=${code}: ${new TextDecoder().decode(stderr)}`,
    );
  }
  const out = new TextDecoder().decode(stdout);
  const m = out.match(/__HTTP_STATUS__:(\d+)\s*$/);
  return {
    status: m ? parseInt(m[1], 10) : -1,
    body: m ? out.slice(0, m.index).trimEnd() : out,
  };
}

async function npmLogin(
  baseUrl: string,
  email: string,
  password: string,
  timeoutSec: number,
): Promise<string> {
  const r = await curlReq(
    "POST",
    baseUrl.replace(/\/$/, "") + "/api/tokens",
    ["Content-Type: application/json"],
    JSON.stringify({ identity: email, secret: password }),
    timeoutSec,
  );
  if (r.status < 200 || r.status >= 300) {
    throw new Error(
      `NPM login failed: HTTP ${r.status}: ${r.body.slice(0, 200)}`,
    );
  }
  const parsed = JSON.parse(r.body) as { token?: string };
  if (!parsed.token) throw new Error("NPM login returned no token");
  return parsed.token;
}

function classify(
  daysRemaining: number | null,
  warnDays: number,
  criticalDays: number,
): z.infer<typeof StatusEnum> {
  if (daysRemaining == null) return "error";
  if (daysRemaining < 0) return "expired";
  if (daysRemaining < criticalDays) return "critical";
  if (daysRemaining < warnDays) return "warn";
  return "ok";
}

function daysBetween(future: string, now: Date): number {
  const t = Date.parse(future);
  if (Number.isNaN(t)) return Number.NaN;
  return Math.floor((t - now.getTime()) / 86_400_000);
}

function requireHostname(host: string): string {
  if (!/^[A-Za-z0-9.-]+$/.test(host)) {
    throw new Error(
      `hostname must match [A-Za-z0-9.-]+, got: ${JSON.stringify(host)}`,
    );
  }
  return host;
}

async function probeOne(
  host: string,
  port: number,
  timeoutSec: number,
  warnDays: number,
  criticalDays: number,
): Promise<z.infer<typeof ProbeResultSchema>> {
  requireHostname(host);
  try {
    const probe = new Deno.Command("openssl", {
      args: [
        "s_client",
        "-servername",
        host,
        "-connect",
        `${host}:${port}`,
      ],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    });
    const proc = probe.spawn();
    proc.stdin.close();
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch { /* already exited */ }
    }, timeoutSec * 1000);
    const { code, stdout, stderr } = await proc.output();
    clearTimeout(timer);
    if (code !== 0) {
      const errText = new TextDecoder().decode(stderr).slice(0, 300);
      return {
        host,
        port,
        ok: false,
        subject: null,
        issuer: null,
        expiresAt: null,
        daysRemaining: null,
        status: "error",
        error: `s_client exit=${code}: ${errText}`,
      };
    }
    const pem = new TextDecoder().decode(stdout);
    const parseProc = new Deno.Command("openssl", {
      args: ["x509", "-noout", "-enddate", "-subject", "-issuer"],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    });
    const p2 = parseProc.spawn();
    const w = p2.stdin.getWriter();
    await w.write(new TextEncoder().encode(pem));
    await w.close();
    const out2 = await p2.output();
    if (out2.code !== 0) {
      return {
        host,
        port,
        ok: false,
        subject: null,
        issuer: null,
        expiresAt: null,
        daysRemaining: null,
        status: "error",
        error: `x509 parse exit=${out2.code}`,
      };
    }
    const text = new TextDecoder().decode(out2.stdout);
    const endLine = text.match(/notAfter=(.+)/);
    const subjLine = text.match(/subject=\s?(.+)/);
    const issLine = text.match(/issuer=\s?(.+)/);
    const expiresAt = endLine
      ? new Date(endLine[1].trim()).toISOString()
      : null;
    const now = new Date();
    const daysRemaining = expiresAt ? daysBetween(expiresAt, now) : null;
    const status = classify(daysRemaining, warnDays, criticalDays);
    return {
      host,
      port,
      ok: status !== "error",
      subject: subjLine ? subjLine[1].trim() : null,
      issuer: issLine ? issLine[1].trim() : null,
      expiresAt,
      daysRemaining,
      status,
      error: null,
    };
  } catch (e) {
    return {
      host,
      port,
      ok: false,
      subject: null,
      issuer: null,
      expiresAt: null,
      daysRemaining: null,
      status: "error",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * TLS-certificate expiry tracker. Combines an NPM-side inventory pull with
 * end-to-end TLS probes via openssl s_client; both classify certs into
 * ok/warn/critical/expired/error buckets and emit summary resources with the
 * top-10 closest to expiry. Read-only.
 */
export const model = {
  type: "@lint/cert-health",
  version: "2026.05.22.1",
  reports: [] as string[],
  globalArguments: GlobalArgsSchema,
  resources: {
    "npm_inventory": {
      description: "Full list of NPM-managed certs with days-until-expiry.",
      schema: NpmInventorySchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    "npm_summary": {
      description: "Counts + top-10 closest-to-expiry NPM certs.",
      schema: NpmSummarySchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    "probe_results": {
      description: "Per-host TLS probe results from the last `probe` run.",
      schema: ProbeResultsSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    "probe_summary": {
      description:
        "Counts + top-10 closest-to-expiry hosts from probe results.",
      schema: ProbeSummarySchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    "sync_log": {
      description: "Per-method audit (syncNpm, probe).",
      schema: SyncLogSchema,
      lifetime: "infinite" as const,
      garbageCollection: 30,
    },
  },
  methods: {
    syncNpm: {
      description:
        "Log into NPM, fetch /api/nginx/certificates, classify by days-until-expiry, write inventory + summary.",
      arguments: z.object({}),
      execute: async (_args: ExecuteArgs, context: ExecuteContext) => {
        const {
          npmBaseUrl,
          npmEmail,
          npmPassword,
          warnThresholdDays,
          criticalThresholdDays,
          requestTimeoutSec,
        } = context.globalArgs;
        const now = new Date();
        const nowIso = now.toISOString();
        const token = await npmLogin(
          npmBaseUrl,
          npmEmail,
          npmPassword,
          requestTimeoutSec,
        );
        const r = await curlReq(
          "GET",
          npmBaseUrl.replace(/\/$/, "") + "/api/nginx/certificates",
          [`Authorization: Bearer ${token}`, "Accept: application/json"],
          undefined,
          requestTimeoutSec,
        );
        if (r.status < 200 || r.status >= 300) {
          const detail = `GET /api/nginx/certificates -> ${r.status}: ${
            r.body.slice(0, 200)
          }`;
          await context.writeResource("sync_log", "sync_log", {
            ranAt: nowIso,
            method: "syncNpm",
            ok: false,
            detail,
          });
          throw new Error(detail);
        }
        // deno-lint-ignore no-explicit-any
        const raw = JSON.parse(r.body) as any[];
        const certs: z.infer<typeof NpmCertSchema>[] = raw
          // deno-lint-ignore no-explicit-any
          .filter((c: any) => !c.is_deleted)
          // deno-lint-ignore no-explicit-any
          .map((c: any) => {
            const expiresOn = typeof c.expires_on === "string"
              ? c.expires_on
              : null;
            const daysRemaining = expiresOn
              ? daysBetween(expiresOn, now)
              : null;
            return {
              id: c.id,
              provider: typeof c.provider === "string" ? c.provider : "unknown",
              niceName: typeof c.nice_name === "string"
                ? c.nice_name
                : `#${c.id}`,
              domainNames: Array.isArray(c.domain_names) ? c.domain_names : [],
              expiresOn,
              daysRemaining,
              status: classify(
                daysRemaining,
                warnThresholdDays,
                criticalThresholdDays,
              ),
            };
          })
          .sort((a, b) => {
            const da = a.daysRemaining ?? Number.POSITIVE_INFINITY;
            const db = b.daysRemaining ?? Number.POSITIVE_INFINITY;
            return da - db;
          });

        const inventory: z.infer<typeof NpmInventorySchema> = {
          fetchedAt: nowIso,
          npmBaseUrl,
          certs,
        };
        const summary: z.infer<typeof NpmSummarySchema> = {
          fetchedAt: nowIso,
          totalCount: certs.length,
          okCount: certs.filter((c) => c.status === "ok").length,
          warnCount: certs.filter((c) => c.status === "warn").length,
          criticalCount: certs.filter((c) => c.status === "critical").length,
          expiredCount: certs.filter((c) => c.status === "expired").length,
          worstExpiring: certs.slice(0, 10).map((c) => ({
            niceName: c.niceName,
            domainNames: c.domainNames,
            expiresOn: c.expiresOn,
            daysRemaining: c.daysRemaining,
            status: c.status,
          })),
        };
        const h1 = await context.writeResource(
          "npm_inventory",
          "npm_inventory",
          inventory,
        );
        const h2 = await context.writeResource(
          "npm_summary",
          "npm_summary",
          summary,
        );
        const h3 = await context.writeResource("sync_log", "sync_log", {
          ranAt: nowIso,
          method: "syncNpm",
          ok: true,
          detail:
            `${certs.length} certs (${summary.criticalCount} critical, ${summary.warnCount} warn, ${summary.expiredCount} expired)`,
        });
        return { dataHandles: [h1, h2, h3] };
      },
    },

    probe: {
      description:
        "Open a TLS connection to each host (port 443 by default) via openssl s_client, extract the leaf cert, classify by days-until-expiry. Probes run in parallel.",
      arguments: z.object({
        hosts: z.array(z.string()).describe(
          "Hostnames to probe. Use `host:port` to override the default port.",
        ),
        defaultPort: z.number().default(443),
      }),
      execute: async (args: ExecuteArgs, context: ExecuteContext) => {
        const { probeTimeoutSec, warnThresholdDays, criticalThresholdDays } =
          context.globalArgs;
        const hosts: string[] = args.hosts;
        const defaultPort: number = args.defaultPort;
        const now = new Date().toISOString();
        const targets = hosts.map((raw) => {
          const m = raw.match(/^([^:]+):(\d+)$/);
          if (m) return { host: m[1], port: parseInt(m[2], 10) };
          return { host: raw, port: defaultPort };
        });
        const results = await Promise.all(
          targets.map((t) =>
            probeOne(
              t.host,
              t.port,
              probeTimeoutSec,
              warnThresholdDays,
              criticalThresholdDays,
            )
          ),
        );
        const valid = results.filter((r) => r.status !== "error");
        const summary: z.infer<typeof ProbeSummarySchema> = {
          probedAt: now,
          totalCount: results.length,
          okCount: results.filter((r) => r.status === "ok").length,
          warnCount: results.filter((r) => r.status === "warn").length,
          criticalCount: results.filter((r) => r.status === "critical").length,
          expiredCount: results.filter((r) => r.status === "expired").length,
          errorCount: results.filter((r) => r.status === "error").length,
          worstExpiring: valid
            .sort((a, b) =>
              (a.daysRemaining ?? Number.POSITIVE_INFINITY) -
              (b.daysRemaining ?? Number.POSITIVE_INFINITY)
            )
            .slice(0, 10)
            .map((r) => ({
              host: r.host,
              issuer: r.issuer,
              expiresAt: r.expiresAt,
              daysRemaining: r.daysRemaining,
              status: r.status,
            })),
        };
        const h1 = await context.writeResource(
          "probe_results",
          "probe_results",
          { probedAt: now, results },
        );
        const h2 = await context.writeResource(
          "probe_summary",
          "probe_summary",
          summary,
        );
        const h3 = await context.writeResource("sync_log", "sync_log", {
          ranAt: now,
          method: "probe",
          ok: true,
          detail:
            `${results.length} hosts (${summary.criticalCount} critical, ${summary.warnCount} warn, ${summary.errorCount} error)`,
        });
        return { dataHandles: [h1, h2, h3] };
      },
    },
  },
};
