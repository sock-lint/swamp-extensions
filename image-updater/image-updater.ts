/**
 * `@lint/image-updater` — auto-applier for docker image updates discovered
 * by `@lint/image-updates`.
 *
 * Single method:
 *
 *   - `apply` — read the latest `image-updates.inventory`, filter to
 *     containers in compose stacks (standalone containers are out of
 *     scope), skip anything matching `denyList`, skip anything updated
 *     within `coolingDays`, take up to `maxPerRun`, and for each: ssh to
 *     the PVE node, `pct exec` `docker compose pull && docker compose
 *     up -d` for the relevant compose project. Emits `update_log` with
 *     full per-container outcome.
 *
 * Default `denyList` is intentionally aggressive — DBs, auth servers,
 * media servers, reverse proxies, security tooling — categories where
 * surprise updates commonly break things. `apply: false` writes the log
 * without touching anything, for policy review.
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
  imageUpdates: z.any().describe(
    "Inventory from @homelab/image-updates.check, via CEL: " +
      "`${{ data.latest('image-updates', 'inventory').attributes }}`",
  ),
  previousHistory: z.any().optional().describe(
    "Previous update_history for cooling-period gating, via CEL: " +
      "`${{ data.latest('image-updater', 'update_history').attributes }}`. Empty on first run.",
  ),
  nodeIpMap: z.any().describe("PVE node name → IP, JSON map"),
  sshUser: z.string().default("root"),
  identityFile: z.string().default("/root/.ssh/id_ed25519"),
  coolingDays: z.number().default(3)
    .describe(
      "Days an image must be on the update list before auto-update fires",
    ),
  denyImagePatterns: z.any().optional().describe(
    "Substrings: if any matches the image name, skip auto-update. " +
      "Default covers stateful/critical: " +
      '["postgres","postgresql","mariadb","mysql","mssql","redis","vaultwarden","bitwarden","authentik","plex","crowdsec","nginx"]. ' +
      "Pass as JSON array to override.",
  ),
  allowOnlyComposeManaged: z.boolean().default(true)
    .describe(
      "Skip standalone (non-compose) containers — we don't know how to recreate them safely",
    ),
  maxUpdatesPerRun: z.number().default(5)
    .describe("Hard cap on updates per run. Safety brake."),
  healthCheckTimeoutSec: z.number().default(60)
    .describe(
      "How long to wait for container to be running after recreate before flagging unhealthy",
    ),
});

const HistoryEntrySchema = z.object({
  key: z.string().describe('"<hostName>:<image>" — first-seen tracking key'),
  firstSeenAt: z.iso.datetime(),
});

const UpdateHistorySchema = z.object({
  updatedAt: z.iso.datetime(),
  entries: z.array(HistoryEntrySchema),
});

const UpdateActionSchema = z.object({
  hostName: z.string(),
  hostVmid: z.number(),
  hostNode: z.string(),
  image: z.string(),
  containerNames: z.array(z.string()),
  composeProject: z.string().optional(),
  composeService: z.string().optional(),
  composeWorkingDir: z.string().optional(),
  firstSeenAt: z.string().optional(),
  ageDays: z.number().optional(),
  decision: z.enum([
    "skipped_by_user",
    "skipped_by_denylist",
    "skipped_not_compose_managed",
    "skipped_awaiting_cooling",
    "skipped_over_cap",
    "would_update",
    "updated",
    "failed_pull",
    "failed_recreate",
    "unhealthy_after",
    "error",
  ]),
  errorMessage: z.string().optional(),
  pullDurationMs: z.number().optional(),
  recreateDurationMs: z.number().optional(),
});

const UpdateLogSchema = z.object({
  ranAt: z.iso.datetime(),
  mode: z.enum(["dry_run", "applied"]),
  imageUpdatesCheckedAt: z.string(),
  totalCandidates: z.number(),
  skippedByUserCount: z.number(),
  skippedByDenylistCount: z.number(),
  skippedNotComposeManagedCount: z.number(),
  skippedAwaitingCoolingCount: z.number(),
  skippedOverCapCount: z.number(),
  wouldUpdateCount: z.number(),
  updatedCount: z.number(),
  failedCount: z.number(),
  unhealthyCount: z.number(),
  actions: z.array(UpdateActionSchema),
});

const DEFAULT_DENY = [
  "postgres",
  "postgresql",
  "mariadb",
  "mysql",
  "mssql",
  "redis",
  "vaultwarden",
  "bitwarden",
  "authentik",
  "plex",
  "crowdsec",
  "nginx",
];

async function pveSshExec(
  nodeIp: string,
  sshUser: string,
  identityFile: string,
  vmid: number,
  innerCmd: string,
  timeoutSec = 120,
): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number }> {
  const args = [
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${timeoutSec}`,
    "-i",
    identityFile,
    `${sshUser}@${nodeIp}`,
    `pct exec ${vmid} -- sh -c ${JSON.stringify(innerCmd)}`,
  ];
  const cmd = new Deno.Command("ssh", {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  return {
    ok: code === 0,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
    exitCode: code,
  };
}

/** Swamp model definition for `@lint/image-updater`. */
export const model: {
  type: string;
  version: string;
  reports: string[];
  resources: Record<string, unknown>;
  globalArguments: unknown;
  methods: Record<string, unknown>;
} = {
  type: "@lint/image-updater",
  version: "2026.05.21.1",
  reports: ["@homelab/image-updater"],
  globalArguments: GlobalArgsSchema,
  resources: {
    "update_log": {
      description: "Per-run log of update actions (dry-run or applied)",
      schema: UpdateLogSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    "update_history": {
      description:
        "When each candidate first appeared on the update list — for cooling-period gating",
      schema: UpdateHistorySchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
  },
  methods: {
    apply: {
      description:
        "Auto-update container images (dry-run by default). Cooling-period gate. Deny-list-aware. Compose-managed only.",
      arguments: z.object({
        apply: z.boolean().default(false)
          .describe(
            "If true, actually pull + recreate. If false (default), dry-run.",
          ),
        skipImages: z.any().optional().describe(
          'Optional. Array of image strings to spare this run. JSON: \'["dozzle:latest","homepage:latest"]\'.',
        ),
      }),
      // deno-lint-ignore no-explicit-any
      execute: async (args: any, context: any) => {
        const apply: boolean = !!args.apply;
        const rawSkip = args.skipImages;
        const skipArr: string[] = Array.isArray(rawSkip)
          ? rawSkip
          : typeof rawSkip === "string" && rawSkip.trim().startsWith("[")
          ? JSON.parse(rawSkip)
          : [];
        const skipSet = new Set(skipArr);

        const inv = context.globalArgs.imageUpdates;
        if (!inv || !Array.isArray(inv.images)) {
          throw new Error("imageUpdates missing or malformed");
        }
        const checkedAt = inv.checkedAt ?? "";

        const {
          sshUser,
          identityFile,
          coolingDays,
          allowOnlyComposeManaged,
          maxUpdatesPerRun,
          healthCheckTimeoutSec,
        } = context.globalArgs;

        const rawMap = context.globalArgs.nodeIpMap;
        const nodeIpMap: Record<string, string> = typeof rawMap === "string"
          ? JSON.parse(rawMap)
          : (rawMap as Record<string, string>);

        const rawDeny = context.globalArgs.denyImagePatterns;
        const denyPatterns: string[] = Array.isArray(rawDeny)
          ? rawDeny
          : typeof rawDeny === "string" && rawDeny.trim().startsWith("[")
          ? JSON.parse(rawDeny)
          : DEFAULT_DENY;
        const denyLower = denyPatterns.map((p) => p.toLowerCase());

        const prevHistory = context.globalArgs.previousHistory;
        const prevSeen = new Map<string, string>();
        if (prevHistory && Array.isArray(prevHistory.entries)) {
          for (const e of prevHistory.entries) {
            if (
              typeof e.key === "string" && typeof e.firstSeenAt === "string"
            ) {
              prevSeen.set(e.key, e.firstSeenAt);
            }
          }
        }

        const ranAt = new Date().toISOString();
        const nowMs = Date.now();
        const newHistoryEntries: z.infer<typeof HistoryEntrySchema>[] = [];
        const actions: z.infer<typeof UpdateActionSchema>[] = [];
        let updateAttempts = 0;

        // deno-lint-ignore no-explicit-any
        const candidates = inv.images.filter((i: any) =>
          i.status === "update-available"
        );

        for (const cand of candidates) {
          const key = `${cand.hostName}:${cand.image}`;
          const firstSeenAt = prevSeen.get(key) ?? ranAt;
          newHistoryEntries.push({ key, firstSeenAt });
          const ageDays = Math.floor(
            (nowMs - Date.parse(firstSeenAt)) / 86400000,
          );

          const base = {
            hostName: cand.hostName,
            hostVmid: cand.hostVmid,
            hostNode: cand.hostNode,
            image: cand.image,
            containerNames: cand.containerNames ?? [],
            firstSeenAt,
            ageDays,
          };

          if (skipSet.has(cand.image)) {
            actions.push({ ...base, decision: "skipped_by_user" });
            continue;
          }

          const lower = cand.image.toLowerCase();
          const denyHit = denyLower.find((p) => lower.includes(p));
          if (denyHit) {
            actions.push({
              ...base,
              decision: "skipped_by_denylist",
              errorMessage: `Matches deny pattern "${denyHit}"`,
            });
            continue;
          }

          if (coolingDays > 0 && ageDays < coolingDays) {
            actions.push({
              ...base,
              decision: "skipped_awaiting_cooling",
              errorMessage:
                `On update list ${ageDays}d; cooling requires ${coolingDays}d.`,
            });
            continue;
          }

          // Look up compose metadata from the container's labels on the host.
          const nodeIp = nodeIpMap[cand.hostNode];
          if (!nodeIp) {
            actions.push({
              ...base,
              decision: "error",
              errorMessage: `no IP for node ${cand.hostNode}`,
            });
            continue;
          }

          const containerName = (cand.containerNames ?? [])[0];
          if (!containerName) {
            actions.push({
              ...base,
              decision: "error",
              errorMessage: "no container name in inventory",
            });
            continue;
          }

          const metaCmd =
            `docker container inspect ${JSON.stringify(containerName)} ` +
            `--format '{{index .Config.Labels "com.docker.compose.project"}}|` +
            `{{index .Config.Labels "com.docker.compose.service"}}|` +
            `{{index .Config.Labels "com.docker.compose.project.working_dir"}}' 2>/dev/null`;
          const meta = await pveSshExec(
            nodeIp,
            sshUser,
            identityFile,
            cand.hostVmid,
            metaCmd,
          );
          let composeProject = "";
          let composeService = "";
          let composeWorkingDir = "";
          if (meta.ok) {
            const parts = meta.stdout.trim().split("|");
            composeProject = parts[0] ?? "";
            composeService = parts[1] ?? "";
            composeWorkingDir = parts[2] ?? "";
          }

          const compoundBase = {
            ...base,
            composeProject: composeProject || undefined,
            composeService: composeService || undefined,
            composeWorkingDir: composeWorkingDir || undefined,
          };

          if (
            allowOnlyComposeManaged &&
            (!composeProject || !composeService || !composeWorkingDir)
          ) {
            actions.push({
              ...compoundBase,
              decision: "skipped_not_compose_managed",
              errorMessage:
                "Missing one or more of: compose project, service, working_dir labels.",
            });
            continue;
          }

          if (maxUpdatesPerRun > 0 && updateAttempts >= maxUpdatesPerRun) {
            actions.push({ ...compoundBase, decision: "skipped_over_cap" });
            continue;
          }
          updateAttempts += 1;

          if (!apply) {
            actions.push({ ...compoundBase, decision: "would_update" });
            continue;
          }

          // Live update: pull, recreate, wait for healthy.
          const pullStart = Date.now();
          const pullCmd = `cd ${
            JSON.stringify(composeWorkingDir)
          } && docker compose pull ${JSON.stringify(composeService)} 2>&1`;
          const pull = await pveSshExec(
            nodeIp,
            sshUser,
            identityFile,
            cand.hostVmid,
            pullCmd,
            300,
          );
          const pullMs = Date.now() - pullStart;
          if (!pull.ok) {
            actions.push({
              ...compoundBase,
              decision: "failed_pull",
              errorMessage: (pull.stderr || pull.stdout).slice(0, 400),
              pullDurationMs: pullMs,
            });
            continue;
          }

          const recreateStart = Date.now();
          const recreateCmd = `cd ${JSON.stringify(composeWorkingDir)} && ` +
            `docker compose up -d --force-recreate ${
              JSON.stringify(composeService)
            } 2>&1`;
          const recreate = await pveSshExec(
            nodeIp,
            sshUser,
            identityFile,
            cand.hostVmid,
            recreateCmd,
            300,
          );
          const recreateMs = Date.now() - recreateStart;
          if (!recreate.ok) {
            actions.push({
              ...compoundBase,
              decision: "failed_recreate",
              errorMessage: (recreate.stderr || recreate.stdout).slice(0, 400),
              pullDurationMs: pullMs,
              recreateDurationMs: recreateMs,
            });
            continue;
          }

          // Health check loop.
          const healthCmd =
            `for i in $(seq 1 ${
              Math.max(1, Math.floor(healthCheckTimeoutSec / 2))
            }); do ` +
            `state=$(docker container inspect ${
              JSON.stringify(containerName)
            } ` +
            `--format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' ` +
            `2>/dev/null); ` +
            `case "$state" in ` +
            `running\\|healthy|running\\|none|running\\|starting) ;; ` +
            `esac; ` +
            `if [ "$state" = "running|healthy" ] || [ "$state" = "running|none" ]; then ` +
            `echo OK; exit 0; ` +
            `fi; ` +
            `sleep 2; ` +
            `done; ` +
            `echo "UNHEALTHY:$state"; exit 1`;
          const health = await pveSshExec(
            nodeIp,
            sshUser,
            identityFile,
            cand.hostVmid,
            healthCmd,
          );
          if (!health.ok) {
            actions.push({
              ...compoundBase,
              decision: "unhealthy_after",
              errorMessage: health.stdout.trim().slice(0, 400),
              pullDurationMs: pullMs,
              recreateDurationMs: recreateMs,
            });
            continue;
          }

          actions.push({
            ...compoundBase,
            decision: "updated",
            pullDurationMs: pullMs,
            recreateDurationMs: recreateMs,
          });
        }

        const log: z.infer<typeof UpdateLogSchema> = {
          ranAt,
          mode: apply ? "applied" : "dry_run",
          imageUpdatesCheckedAt: checkedAt,
          totalCandidates: candidates.length,
          skippedByUserCount:
            actions.filter((a) => a.decision === "skipped_by_user").length,
          skippedByDenylistCount:
            actions.filter((a) => a.decision === "skipped_by_denylist").length,
          skippedNotComposeManagedCount:
            actions.filter((a) => a.decision === "skipped_not_compose_managed")
              .length,
          skippedAwaitingCoolingCount:
            actions.filter((a) => a.decision === "skipped_awaiting_cooling")
              .length,
          skippedOverCapCount:
            actions.filter((a) => a.decision === "skipped_over_cap").length,
          wouldUpdateCount:
            actions.filter((a) => a.decision === "would_update").length,
          updatedCount: actions.filter((a) => a.decision === "updated").length,
          failedCount:
            actions.filter((a) =>
              ["failed_pull", "failed_recreate", "error"].includes(a.decision)
            ).length,
          unhealthyCount:
            actions.filter((a) => a.decision === "unhealthy_after").length,
          actions,
        };

        const h1 = await context.writeResource("update_log", "update_log", log);
        const h2 = await context.writeResource(
          "update_history",
          "update_history",
          { updatedAt: ranAt, entries: newHistoryEntries },
        );
        return { dataHandles: [h1, h2] };
      },
    },
  },
};
