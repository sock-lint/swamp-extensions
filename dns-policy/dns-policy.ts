import { z } from "npm:zod@4";

const RewriteSchema = z.object({
  domain: z.string(),
  answer: z.string(),
});

const GlobalArgsSchema = z.object({
  instanceLabel: z.string().describe("Human label, e.g. 'homelab'"),
  proxyTargetIp: z.string().describe(
    "Reverse proxy IP — every vhost resolves here, e.g. '192.168.4.60'",
  ),
  proxySuffix: z.string().describe(
    "Vhost domain suffix, e.g. 'bos.lol' — yields '<vhost>.<proxySuffix>'",
  ),
  vhosts: z.array(z.string()).describe(
    "Vhost names exposed via the reverse proxy (e.g. ['sonarr', 'portainer']). Each becomes '<name>.<proxySuffix>' → proxyTargetIp.",
  ),
  staticRewrites: z.array(RewriteSchema).default([]).describe(
    "Hand-listed rewrites for cases the proxy pattern doesn't cover (infra hosts, wildcards, off-proxy targets).",
  ),
  publicVhosts: z.array(z.string()).default([]).describe(
    "Subset of vhosts (bare names) that should ALSO be reachable externally (e.g. via Cloudflare). Emitted as desired_public_records for a downstream public-DNS reconciler.",
  ),
});

const DesiredRewritesSchema = z.object({
  instanceLabel: z.string(),
  entries: z.array(RewriteSchema),
  vhostCount: z.number(),
  discoveredVhostCount: z.number(),
  staticCount: z.number(),
  duplicateCount: z.number().describe(
    "Number of (domain, answer) collisions collapsed during dedupe",
  ),
  builtAt: z.iso.datetime(),
});

const DesiredPublicRecordsSchema = z.object({
  instanceLabel: z.string(),
  hostnames: z.array(z.string()).describe(
    "Fully-qualified hostnames to expose externally, e.g. 'radarr.bos.lol'",
  ),
  builtAt: z.iso.datetime(),
});

/**
 * dns-policy — compose a single source-of-truth list of DNS rewrites from
 * three inputs: manual vhosts (global arg), auto-discovered vhosts (e.g. from
 * `@lint/nginx-proxy-manager.sync`), and hand-listed static rewrites. The
 * deduped result is consumed by an internal-DNS reconciler such as
 * `@lint/adguard.reconcileRewrites`. A second resource lists which subset
 * should also be reachable externally, for a public-DNS reconciler.
 */
export const model = {
  type: "@lint/dns-policy",
  version: "2026.05.22.1",
  reports: [] as string[],
  globalArguments: GlobalArgsSchema,
  resources: {
    "desired_rewrites": {
      description:
        "Desired internal-DNS rewrite list — consumed by @lint/adguard.reconcileRewrites (or any compatible reconciler)",
      schema: DesiredRewritesSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    "desired_public_records": {
      description:
        "Hostnames to expose externally — consumed by a public-DNS reconciler",
      schema: DesiredPublicRecordsSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
  },
  methods: {
    build: {
      description:
        "Compose vhost rewrites + discovered vhosts + static rewrites into a deduped desired list for an internal-DNS reconciler. Discovered vhosts (e.g. from NPM) are merged with the manual vhosts global arg.",
      arguments: z.object({
        discoveredVhosts: z.array(z.string()).default([]).describe(
          "Auto-discovered vhost domain names (already fully qualified, e.g. 'sonarr.bos.lol'). Sourced from NPM or other proxy inventory.",
        ),
      }),
      // deno-lint-ignore no-explicit-any
      execute: async (args: unknown, context: any) => {
        const {
          instanceLabel,
          proxyTargetIp,
          proxySuffix,
          vhosts,
          staticRewrites,
          publicVhosts,
        } = context.globalArgs as {
          instanceLabel: string;
          proxyTargetIp: string;
          proxySuffix: string;
          vhosts: string[];
          staticRewrites: { domain: string; answer: string }[];
          publicVhosts: string[];
        };
        const { discoveredVhosts } = args as { discoveredVhosts: string[] };
        const builtAt = new Date().toISOString();

        const suffix = proxySuffix.replace(/^\./, "");
        const manualEntries = vhosts.map((v) => ({
          domain: `${v}.${suffix}`,
          answer: proxyTargetIp,
        }));
        const discoveredEntries = (discoveredVhosts ?? []).map((d) => ({
          domain: d,
          answer: proxyTargetIp,
        }));
        const staticEntries = staticRewrites ?? [];

        const combined = [
          ...manualEntries,
          ...discoveredEntries,
          ...staticEntries,
        ];
        const seen = new Set<string>();
        const entries: { domain: string; answer: string }[] = [];
        let duplicateCount = 0;
        for (const e of combined) {
          const k = `${e.domain} ${e.answer}`;
          if (seen.has(k)) {
            duplicateCount += 1;
            continue;
          }
          seen.add(k);
          entries.push(e);
        }

        const desired = {
          instanceLabel,
          entries,
          vhostCount: manualEntries.length,
          discoveredVhostCount: discoveredEntries.length,
          staticCount: staticEntries.length,
          duplicateCount,
          builtAt,
        };

        const publicHostnames = Array.from(
          new Set((publicVhosts ?? []).map((v) => `${v}.${suffix}`)),
        );
        const publicRecords = {
          instanceLabel,
          hostnames: publicHostnames,
          builtAt,
        };

        const handle = await context.writeResource(
          "desired_rewrites",
          "desired_rewrites",
          desired,
        );
        const pubHandle = await context.writeResource(
          "desired_public_records",
          "desired_public_records",
          publicRecords,
        );
        return { dataHandles: [handle, pubHandle] };
      },
    },
  },
};
