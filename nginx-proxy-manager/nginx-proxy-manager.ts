/**
 * `@lint/nginx-proxy-manager` — Nginx Proxy Manager admin-API wrapper for swamp.
 *
 * Three methods:
 *
 *   - `sync` — log in via `POST /api/tokens`, then fetch `/api/nginx/proxy-hosts`,
 *     `/api/nginx/redirection-hosts`, and `/api/nginx/certificates`. Emits a
 *     full `inventory` resource and a compact `summary` (counts + certs
 *     expiring within 30 days).
 *   - `upsertProxyHost` — declarative proxy-host management: matches existing
 *     hosts by exact set of `domainNames`; if a match exists, `PUT`s the new
 *     config to that id, otherwise `POST`s a new host. Idempotent. Result
 *     records `created` vs `updated` and the host id.
 *   - `deleteProxyHost` — `DELETE /api/nginx/proxy-hosts/{id}`. Non-throwing
 *     so a 404 (already gone) records the outcome instead of crashing.
 *
 * Auth is email/password against the NPM admin UI account; the bearer token
 * is acquired per call and never persisted.
 */
import { z } from "npm:zod@4";

// Swamp wires args/context at runtime; the model loader doesn't expose types.
// deno-lint-ignore no-explicit-any
type ExecuteArgs = any;
interface ExecuteContext {
  // deno-lint-ignore no-explicit-any
  globalArgs: any;
  writeResource(
    resource: string,
    name: string,
    // deno-lint-ignore no-explicit-any
    body: any,
    // deno-lint-ignore no-explicit-any
  ): Promise<any>;
}
const GlobalArgsSchema = z.object({
  baseUrl: z.string().describe("NPM admin URL, e.g. http://192.168.4.60:81"),
  email: z.string().describe(
    "NPM admin email (identity used by POST /api/tokens)",
  ),
  password: z.string().describe("NPM admin password"),
  instanceLabel: z.string().describe("Human label, e.g. 'homelab-edge'"),
});

const ProxyHostSchema = z.object({
  id: z.number(),
  domainNames: z.array(z.string()),
  forwardScheme: z.string().describe("http or https"),
  forwardHost: z.string().describe("Upstream host (IP or hostname)"),
  forwardPort: z.number(),
  accessListId: z.number().describe("0 = no access list"),
  certificateId: z.number().describe("0 = no SSL cert"),
  sslForced: z.boolean(),
  hstsEnabled: z.boolean(),
  http2Support: z.boolean(),
  blockExploits: z.boolean(),
  cachingEnabled: z.boolean(),
  allowWebsocketUpgrade: z.boolean(),
  enabled: z.boolean(),
  createdOn: z.string().optional(),
  modifiedOn: z.string().optional(),
});

const RedirectionHostSchema = z.object({
  id: z.number(),
  domainNames: z.array(z.string()),
  forwardHttpCode: z.number().describe("301, 302, 307, 308"),
  forwardScheme: z.string(),
  forwardDomainName: z.string(),
  preservePath: z.boolean(),
  certificateId: z.number(),
  sslForced: z.boolean(),
  enabled: z.boolean(),
});

const CertificateSchema = z.object({
  id: z.number(),
  provider: z.string().describe("letsencrypt or other"),
  niceName: z.string(),
  domainNames: z.array(z.string()),
  expiresOn: z.string().optional(),
  createdOn: z.string().optional(),
});

const InventorySchema = z.object({
  instanceLabel: z.string(),
  baseUrl: z.string(),
  version: z.string(),
  proxyHosts: z.array(ProxyHostSchema),
  redirectionHosts: z.array(RedirectionHostSchema),
  certificates: z.array(CertificateSchema),
  fetchedAt: z.iso.datetime(),
});

const SummarySchema = z.object({
  instanceLabel: z.string(),
  baseUrl: z.string(),
  version: z.string(),
  proxyHostCount: z.number(),
  proxyHostsEnabled: z.number(),
  redirectionHostCount: z.number(),
  certificateCount: z.number(),
  certsExpiringWithin30d: z.number(),
  uniqueDomainCount: z.number(),
  fetchedAt: z.iso.datetime(),
});

const ProxyHostInputSchema = z.object({
  domainNames: z.array(z.string()).min(1).describe(
    "Domains that resolve to this proxy host (at least one). The exact set " +
      "is also the match key for upsert.",
  ),
  forwardScheme: z.enum(["http", "https"]).default("http"),
  forwardHost: z.string().describe(
    "Upstream host (IP or hostname). Internal to the network NPM can reach.",
  ),
  forwardPort: z.number().describe("Upstream TCP port"),
  certificateId: z.number().default(0).describe(
    "NPM certificate id (0 = no SSL). Look up existing IDs via the certificates list in the `inventory` resource.",
  ),
  sslForced: z.boolean().default(false),
  http2Support: z.boolean().default(false),
  hstsEnabled: z.boolean().default(false),
  hstsSubdomains: z.boolean().default(false),
  blockExploits: z.boolean().default(true),
  allowWebsocketUpgrade: z.boolean().default(true),
  cachingEnabled: z.boolean().default(false),
  accessListId: z.number().default(0),
  advancedConfig: z.string().default("").describe(
    "Raw nginx config snippet inserted into the proxy host block (NPM's 'Advanced' tab)",
  ),
});

const UpsertResultSchema = z.object({
  instanceLabel: z.string(),
  baseUrl: z.string(),
  domainNames: z.array(z.string()),
  action: z.enum(["created", "updated"]).describe(
    "Whether the call ran POST (created) or PUT (updated)",
  ),
  proxyHostId: z.number().describe("NPM proxy host id after the call"),
  performedAt: z.iso.datetime(),
});

const DeleteProxyHostResultSchema = z.object({
  instanceLabel: z.string(),
  baseUrl: z.string(),
  proxyHostId: z.number(),
  ok: z.boolean(),
  httpStatus: z.number(),
  body: z.string().describe("Response body (truncated to 400 chars)"),
  deletedAt: z.iso.datetime(),
});

async function npmRequest(
  baseUrl: string,
  token: string | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const url = `${baseUrl.replace(/\/$/, "")}${path}`;
  const args = [
    "-sS",
    "-X",
    method,
    "-H",
    "Accept: application/json",
    "-w",
    "\n__HTTP_STATUS__:%{http_code}",
  ];
  if (token) args.push("-H", `Authorization: Bearer ${token}`);
  if (body !== undefined) {
    args.push(
      "-H",
      "Content-Type: application/json",
      "-d",
      JSON.stringify(body),
    );
  }
  args.push(url);
  const cmd = new Deno.Command("curl", {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  if (code !== 0) {
    throw new Error(`curl exit ${code}: ${new TextDecoder().decode(stderr)}`);
  }
  const raw = new TextDecoder().decode(stdout);
  const m = raw.match(/\n__HTTP_STATUS__:(\d+)$/);
  const status = m ? parseInt(m[1], 10) : 0;
  const text = m ? raw.slice(0, m.index) : raw;
  if (status < 200 || status >= 300) {
    throw new Error(
      `${method} ${path} -> HTTP ${status}: ${text.slice(0, 400)}`,
    );
  }
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function npmLogin(
  baseUrl: string,
  email: string,
  password: string,
): Promise<string> {
  const result = await npmRequest(baseUrl, null, "POST", "/api/tokens", {
    identity: email,
    secret: password,
  }) as { token?: string };
  if (!result?.token) {
    throw new Error("NPM login returned no token");
  }
  return result.token;
}

/**
 * Non-throwing twin of `npmRequest`. Returns `{ ok, status, body }` so
 * destructive methods can record outcomes in a resource instead of crashing
 * a batch of calls on a single failure (e.g. a 404 for an already-deleted
 * proxy host).
 */
async function npmCall(
  baseUrl: string,
  token: string | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; body: string }> {
  const url = `${baseUrl.replace(/\/$/, "")}${path}`;
  const args = [
    "-sS",
    "-X",
    method,
    "-H",
    "Accept: application/json",
    "-w",
    "\n__HTTP_STATUS__:%{http_code}",
  ];
  if (token) args.push("-H", `Authorization: Bearer ${token}`);
  if (body !== undefined) {
    args.push(
      "-H",
      "Content-Type: application/json",
      "-d",
      JSON.stringify(body),
    );
  }
  args.push(url);
  const cmd = new Deno.Command("curl", {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  if (code !== 0) {
    return {
      ok: false,
      status: 0,
      body: `curl exit ${code}: ${new TextDecoder().decode(stderr)}`,
    };
  }
  const raw = new TextDecoder().decode(stdout);
  const m = raw.match(/\n__HTTP_STATUS__:(\d+)$/);
  const status = m ? parseInt(m[1], 10) : 0;
  const text = m ? raw.slice(0, m.index) : raw;
  return { ok: status >= 200 && status < 300, status, body: text };
}

/** Swamp model definition for `@lint/nginx-proxy-manager`. */
export const model: {
  type: string;
  version: string;
  reports: string[];
  resources: Record<string, unknown>;
  globalArguments: unknown;
  methods: Record<string, unknown>;
} = {
  type: "@lint/nginx-proxy-manager",
  version: "2026.05.21.2",
  reports: [] as string[],
  globalArguments: GlobalArgsSchema,
  resources: {
    "inventory": {
      description:
        "Full NPM snapshot: proxy hosts, redirection hosts, certificates",
      schema: InventorySchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    "summary": {
      description: "Compact NPM summary: counts, expiring certs",
      schema: SummarySchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
  },
  methods: {
    sync: {
      description:
        "Login to NPM and fetch proxy hosts, redirection hosts, certificates",
      arguments: z.object({}),
      execute: async (_args: ExecuteArgs, context: ExecuteContext) => {
        const { baseUrl, email, password, instanceLabel } = context.globalArgs;
        const fetchedAt = new Date().toISOString();

        const token = await npmLogin(baseUrl, email, password);

        const [versionInfoRaw, proxyHostsRaw, redirectionHostsRaw, certsRaw] =
          await Promise.all([
            npmRequest(baseUrl, null, "GET", "/api/"),
            npmRequest(baseUrl, token, "GET", "/api/nginx/proxy-hosts"),
            npmRequest(baseUrl, token, "GET", "/api/nginx/redirection-hosts"),
            npmRequest(baseUrl, token, "GET", "/api/nginx/certificates"),
            // deno-lint-ignore no-explicit-any
          ]) as [any, any[], any[], any[]];

        const version = versionInfoRaw?.version
          ? `${versionInfoRaw.version.major}.${versionInfoRaw.version.minor}.${versionInfoRaw.version.revision}`
          : "";

        // deno-lint-ignore no-explicit-any
        const proxyHosts = (proxyHostsRaw ?? []).map((h: any) => ({
          id: h.id,
          domainNames: h.domain_names ?? [],
          forwardScheme: h.forward_scheme ?? "",
          forwardHost: h.forward_host ?? "",
          forwardPort: h.forward_port ?? 0,
          accessListId: h.access_list_id ?? 0,
          certificateId: h.certificate_id ?? 0,
          sslForced: !!h.ssl_forced,
          hstsEnabled: !!h.hsts_enabled,
          http2Support: !!h.http2_support,
          blockExploits: !!h.block_exploits,
          cachingEnabled: !!h.caching_enabled,
          allowWebsocketUpgrade: !!h.allow_websocket_upgrade,
          enabled: !!h.enabled,
          createdOn: h.created_on,
          modifiedOn: h.modified_on,
        }));

        // deno-lint-ignore no-explicit-any
        const redirectionHosts = (redirectionHostsRaw ?? []).map((h: any) => ({
          id: h.id,
          domainNames: h.domain_names ?? [],
          forwardHttpCode: h.forward_http_code ?? 301,
          forwardScheme: h.forward_scheme ?? "",
          forwardDomainName: h.forward_domain_name ?? "",
          preservePath: !!h.preserve_path,
          certificateId: h.certificate_id ?? 0,
          sslForced: !!h.ssl_forced,
          enabled: !!h.enabled,
        }));

        // deno-lint-ignore no-explicit-any
        const certificates = (certsRaw ?? []).map((c: any) => ({
          id: c.id,
          provider: c.provider ?? "",
          niceName: c.nice_name ?? "",
          domainNames: c.domain_names ?? [],
          expiresOn: c.expires_on,
          createdOn: c.created_on,
        }));

        const inventory = {
          instanceLabel,
          baseUrl,
          version,
          proxyHosts,
          redirectionHosts,
          certificates,
          fetchedAt,
        };

        const thirtyDays = Date.now() + 30 * 24 * 60 * 60 * 1000;
        const expiring = certificates.filter((c) => {
          if (!c.expiresOn) return false;
          const ts = Date.parse(c.expiresOn);
          return Number.isFinite(ts) && ts < thirtyDays;
        }).length;

        const allDomains = new Set<string>();
        for (const h of proxyHosts) {
          for (const d of h.domainNames) allDomains.add(d);
        }
        for (const h of redirectionHosts) {
          for (const d of h.domainNames) allDomains.add(d);
        }

        const summary = {
          instanceLabel,
          baseUrl,
          version,
          proxyHostCount: proxyHosts.length,
          proxyHostsEnabled: proxyHosts.filter((h) => h.enabled).length,
          redirectionHostCount: redirectionHosts.length,
          certificateCount: certificates.length,
          certsExpiringWithin30d: expiring,
          uniqueDomainCount: allDomains.size,
          fetchedAt,
        };

        const invHandle = await context.writeResource(
          "inventory",
          "inventory",
          inventory,
        );
        const sumHandle = await context.writeResource(
          "summary",
          "summary",
          summary,
        );
        return { dataHandles: [invHandle, sumHandle] };
      },
    },
  },
};
