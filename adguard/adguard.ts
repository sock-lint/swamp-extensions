/**
 * `@lint/adguard` — AdGuard Home control-API wrapper for swamp.
 *
 * Provides two methods against an AdGuard Home instance:
 *
 *   - `sync`              full snapshot (status, stats, filter lists, clients, DNS rewrites)
 *                         emitted as `inventory` + a compact `summary` resource
 *   - `reconcileRewrites` converge `/control/rewrite/list` to a desired set of
 *                         (domain, answer) pairs; idempotent, additive by default
 *
 * Auth is HTTP Basic against the AdGuard admin UI account (no API key concept
 * in AdGuard Home; see https://github.com/AdguardTeam/AdGuardHome/wiki/API ).
 *
 * Transport is `curl` via `Deno.Command` — chosen over `fetch` so the model is
 * trivially debuggable from a shell against the same baseUrl/credentials.
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
  baseUrl: z.string().describe(
    "AdGuard Home base URL, e.g. http://192.168.4.5",
  ),
  username: z.string().describe("AdGuard admin username"),
  password: z.string().describe("AdGuard admin password"),
  instanceLabel: z.string().describe("Human label, e.g. 'homelab-dns'"),
});

const StatusSchema = z.object({
  version: z.string(),
  language: z.string().optional(),
  dnsAddresses: z.array(z.string()),
  dnsPort: z.number(),
  httpPort: z.number(),
  protectionEnabled: z.boolean(),
  dhcpAvailable: z.boolean().optional(),
  running: z.boolean(),
});

const TopEntrySchema = z.object({
  key: z.string(),
  count: z.number(),
});

const StatsSchema = z.object({
  numDnsQueries: z.number(),
  numBlockedFiltering: z.number(),
  numReplacedSafebrowsing: z.number(),
  numReplacedSafesearch: z.number(),
  numReplacedParental: z.number(),
  avgProcessingTimeMs: z.number(),
  blockRatePct: z.number().describe("blocked / total * 100, rounded to 0.01"),
  topQueriedDomains: z.array(TopEntrySchema),
  topClients: z.array(TopEntrySchema),
  topBlockedDomains: z.array(TopEntrySchema),
  topUpstreams: z.array(TopEntrySchema),
  timeUnits: z.string().describe("aggregation window: 'hours' or 'days'"),
});

const FilterSchema = z.object({
  id: z.number(),
  name: z.string(),
  url: z.string(),
  enabled: z.boolean(),
  rulesCount: z.number(),
  lastUpdated: z.string().optional().describe("ISO timestamp or empty"),
});

const FilteringSchema = z.object({
  enabled: z.boolean(),
  intervalHours: z.number().describe("auto-update interval"),
  filters: z.array(FilterSchema),
  whitelistFilters: z.array(FilterSchema),
  userRulesCount: z.number(),
});

const ClientSchema = z.object({
  name: z.string(),
  ids: z.array(z.string()),
  tags: z.array(z.string()).optional(),
  filteringEnabled: z.boolean().optional(),
  safebrowsingEnabled: z.boolean().optional(),
  parentalEnabled: z.boolean().optional(),
  useGlobalSettings: z.boolean().optional(),
  upstreams: z.array(z.string()).optional(),
});

const ClientsSchema = z.object({
  clients: z.array(ClientSchema),
  autoClients: z.array(ClientSchema),
});

const RewriteSchema = z.object({
  domain: z.string().describe("source domain, e.g. radarr.lab"),
  answer: z.string().describe("target IP or CNAME, e.g. 192.168.4.50"),
});

const ReconcileResultSchema = z.object({
  instanceLabel: z.string(),
  desiredCount: z.number(),
  added: z.array(RewriteSchema),
  removed: z.array(RewriteSchema),
  kept: z.array(RewriteSchema),
  skippedRemovals: z.array(RewriteSchema).describe(
    "present-but-not-desired entries that prune=false left alone",
  ),
  pruneRequested: z.boolean(),
  appliedAt: z.iso.datetime(),
});

const InventorySchema = z.object({
  instanceLabel: z.string(),
  baseUrl: z.string(),
  status: StatusSchema,
  stats: StatsSchema,
  filtering: FilteringSchema,
  clients: ClientsSchema,
  rewrites: z.array(RewriteSchema),
  fetchedAt: z.iso.datetime(),
});

const SummarySchema = z.object({
  instanceLabel: z.string(),
  baseUrl: z.string(),
  version: z.string(),
  protectionEnabled: z.boolean(),
  running: z.boolean(),
  numDnsQueries: z.number(),
  numBlockedFiltering: z.number(),
  blockRatePct: z.number(),
  filterListCount: z.number(),
  filterListsEnabled: z.number(),
  filterListsStale: z.number().describe("enabled lists not updated in >7 days"),
  configuredClientCount: z.number(),
  autoClientCount: z.number(),
  rewriteCount: z.number(),
  fetchedAt: z.iso.datetime(),
});

async function adguardRequest(
  baseUrl: string,
  username: string,
  password: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const url = `${baseUrl.replace(/\/$/, "")}${path}`;
  const args = [
    "-sS",
    "-X",
    method,
    "-u",
    `${username}:${password}`,
    "-H",
    "Accept: application/json",
    "-w",
    "\n__HTTP_STATUS__:%{http_code}",
  ];
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

function adguardGet(
  baseUrl: string,
  username: string,
  password: string,
  path: string,
): Promise<unknown> {
  return adguardRequest(baseUrl, username, password, "GET", path);
}

function flattenTopList(raw: unknown): { key: string; count: number }[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const obj = item as Record<string, number>;
    const [key, count] = Object.entries(obj)[0] ?? ["", 0];
    return { key, count };
  });
}

/** Swamp model definition for `@lint/adguard`. */
export const model: {
  type: string;
  version: string;
  reports: string[];
  resources: Record<string, unknown>;
  globalArguments: unknown;
  methods: Record<string, unknown>;
} = {
  type: "@lint/adguard",
  version: "2026.05.21.1",
  reports: [],
  globalArguments: GlobalArgsSchema,
  resources: {
    "inventory": {
      description:
        "Full AdGuard snapshot: status, stats, filter lists, clients, rewrites",
      schema: InventorySchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    "summary": {
      description:
        "Compact summary: block rate, list health, client counts, rewrite count",
      schema: SummarySchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    "reconcile_result": {
      description: "Diff and outcome of the last reconcileRewrites call",
      schema: ReconcileResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    sync: {
      description:
        "Fetch AdGuard status, stats, filter lists, and clients in one snapshot",
      arguments: z.object({}),
      execute: async (_args: ExecuteArgs, context: ExecuteContext) => {
        const { baseUrl, username, password, instanceLabel } =
          context.globalArgs;
        const fetchedAt = new Date().toISOString();

        const [statusRaw, statsRaw, filteringRaw, clientsRaw, rewritesRaw] =
          await Promise.all([
            adguardGet(baseUrl, username, password, "/control/status"),
            adguardGet(baseUrl, username, password, "/control/stats"),
            adguardGet(
              baseUrl,
              username,
              password,
              "/control/filtering/status",
            ),
            adguardGet(baseUrl, username, password, "/control/clients"),
            adguardGet(baseUrl, username, password, "/control/rewrite/list"),
            // deno-lint-ignore no-explicit-any
          ]) as [any, any, any, any, any];

        const rewrites: z.infer<typeof RewriteSchema>[] =
          (Array.isArray(rewritesRaw) ? rewritesRaw : [])
            // deno-lint-ignore no-explicit-any
            .map((r: any) => ({
              domain: r.domain ?? "",
              answer: r.answer ?? "",
            }))
            .filter((r) => r.domain && r.answer);

        const status = {
          version: statusRaw.version ?? "",
          language: statusRaw.language,
          dnsAddresses: statusRaw.dns_addresses ?? [],
          dnsPort: statusRaw.dns_port ?? 53,
          httpPort: statusRaw.http_port ?? 80,
          protectionEnabled: !!statusRaw.protection_enabled,
          dhcpAvailable: statusRaw.dhcp_available,
          running: !!statusRaw.running,
        };

        const totalQueries: number = statsRaw.num_dns_queries ?? 0;
        const blocked: number = statsRaw.num_blocked_filtering ?? 0;
        const blockRatePct = totalQueries > 0
          ? Math.round((blocked / totalQueries) * 10000) / 100
          : 0;

        const stats = {
          numDnsQueries: totalQueries,
          numBlockedFiltering: blocked,
          numReplacedSafebrowsing: statsRaw.num_replaced_safebrowsing ?? 0,
          numReplacedSafesearch: statsRaw.num_replaced_safesearch ?? 0,
          numReplacedParental: statsRaw.num_replaced_parental ?? 0,
          avgProcessingTimeMs:
            Math.round((statsRaw.avg_processing_time ?? 0) * 1000 * 100) / 100,
          blockRatePct,
          topQueriedDomains: flattenTopList(statsRaw.top_queried_domains),
          topClients: flattenTopList(statsRaw.top_clients),
          topBlockedDomains: flattenTopList(statsRaw.top_blocked_domains),
          topUpstreams: flattenTopList(statsRaw.top_upstreams_responses),
          timeUnits: statsRaw.time_units ?? "hours",
        };

        // deno-lint-ignore no-explicit-any
        const mapFilter = (f: any) => ({
          id: f.id ?? 0,
          name: f.name ?? "",
          url: f.url ?? "",
          enabled: !!f.enabled,
          rulesCount: f.rules_count ?? 0,
          lastUpdated: f.last_updated ?? "",
        });

        const filters = (filteringRaw.filters ?? []).map(mapFilter);
        const whitelistFilters = (filteringRaw.whitelist_filters ?? []).map(
          mapFilter,
        );
        const userRules: string[] = filteringRaw.user_rules ?? [];

        const filtering = {
          enabled: !!filteringRaw.enabled,
          intervalHours: filteringRaw.interval ?? 24,
          filters,
          whitelistFilters,
          userRulesCount: userRules.length,
        };

        // deno-lint-ignore no-explicit-any
        const mapClient = (c: any) => ({
          name: c.name ?? "",
          ids: c.ids ?? [],
          tags: c.tags,
          filteringEnabled: c.filtering_enabled,
          safebrowsingEnabled: c.safebrowsing_enabled,
          parentalEnabled: c.parental_enabled,
          useGlobalSettings: c.use_global_settings,
          upstreams: c.upstreams,
        });

        const clientsConfigured = (clientsRaw.clients ?? []).map(mapClient);
        const clientsAuto = (clientsRaw.auto_clients ?? []).map(mapClient);

        const clientsBlock = {
          clients: clientsConfigured,
          autoClients: clientsAuto,
        };

        const inventory = {
          instanceLabel,
          baseUrl,
          status,
          stats,
          filtering,
          clients: clientsBlock,
          rewrites,
          fetchedAt,
        };

        const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const staleCount =
          filters.filter((f: { enabled: boolean; lastUpdated: string }) => {
            if (!f.enabled) return false;
            if (!f.lastUpdated) return true;
            const ts = Date.parse(f.lastUpdated);
            return Number.isFinite(ts) && ts < sevenDaysAgo;
          }).length;

        const summary = {
          instanceLabel,
          baseUrl,
          version: status.version,
          protectionEnabled: status.protectionEnabled,
          running: status.running,
          numDnsQueries: totalQueries,
          numBlockedFiltering: blocked,
          blockRatePct,
          filterListCount: filters.length,
          filterListsEnabled:
            filters.filter((f: { enabled: boolean }) => f.enabled).length,
          filterListsStale: staleCount,
          configuredClientCount: clientsConfigured.length,
          autoClientCount: clientsAuto.length,
          rewriteCount: rewrites.length,
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
    reconcileRewrites: {
      description:
        "Converge AdGuard DNS rewrites to a desired list. Adds entries that are missing; if prune=true, removes entries not in the desired list. Idempotent.",
      arguments: z.object({
        desired: z.array(RewriteSchema).describe(
          "Desired set of (domain, answer) pairs",
        ),
        prune: z.boolean().default(false).describe(
          "Remove rewrites present in AdGuard but absent from desired. Defaults to false (additive only) to avoid clobbering hand-managed entries.",
        ),
      }),
      execute: async (args: ExecuteArgs, context: ExecuteContext) => {
        const { baseUrl, username, password, instanceLabel } =
          context.globalArgs;
        const { desired, prune } = args as {
          desired: { domain: string; answer: string }[];
          prune: boolean;
        };
        const appliedAt = new Date().toISOString();

        const currentRaw = await adguardGet(
          baseUrl,
          username,
          password,
          "/control/rewrite/list",
        ) as unknown[];
        const current = (Array.isArray(currentRaw) ? currentRaw : [])
          // deno-lint-ignore no-explicit-any
          .map((r: any) => ({ domain: r.domain ?? "", answer: r.answer ?? "" }))
          .filter((r) => r.domain && r.answer);

        const key = (r: { domain: string; answer: string }) =>
          `${r.domain} ${r.answer}`;
        const currentSet = new Set(current.map(key));
        const desiredSet = new Set(desired.map(key));

        const toAdd = desired.filter((r) => !currentSet.has(key(r)));
        const toRemoveCandidate = current.filter((r) =>
          !desiredSet.has(key(r))
        );
        const kept = current.filter((r) => desiredSet.has(key(r)));

        const toRemove = prune ? toRemoveCandidate : [];
        const skippedRemovals = prune ? [] : toRemoveCandidate;

        for (const r of toAdd) {
          await adguardRequest(
            baseUrl,
            username,
            password,
            "POST",
            "/control/rewrite/add",
            r,
          );
        }
        for (const r of toRemove) {
          await adguardRequest(
            baseUrl,
            username,
            password,
            "POST",
            "/control/rewrite/delete",
            r,
          );
        }

        const result = {
          instanceLabel,
          desiredCount: desired.length,
          added: toAdd,
          removed: toRemove,
          kept,
          skippedRemovals,
          pruneRequested: prune,
          appliedAt,
        };

        const handle = await context.writeResource(
          "reconcile_result",
          "reconcile_result",
          result,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
