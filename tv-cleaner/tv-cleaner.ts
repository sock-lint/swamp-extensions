/**
 * `@lint/tv-cleaner` — TV series deletion executor for `@lint/tv-curator`
 * drop candidates.
 *
 * Single method:
 *
 *   - `sweep` — read the latest curator `drop_candidates`, filter by tag
 *     protection (`keep-forever` or configurable) and cooling-period gate
 *     (default 6 days from first appearance), take up to `maxPerRun`, and
 *     for each: call `DELETE /api/v3/series/{id}?deleteFiles=true&
 *     addImportListExclusion=true` against Sonarr. Emits `sweep_log` with
 *     full per-series outcome.
 *
 * Same delete-via-API rationale as `@lint/media-cleaner` — direct file
 * removal leaves a Sonarr catalog stub that re-imports on the next scan.
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
const CandidateSchema = z.object({
  sonarrId: z.number(),
  tvdbId: z.number().optional(),
  imdbId: z.string().optional(),
  tmdbId: z.number().optional(),
  title: z.string(),
  year: z.number().optional(),
  path: z.string(),
  sizeOnDisk: z.number(),
  score: z.number(),
  tagNames: z.array(z.string()).optional(),
}).passthrough();

const DropCandidatesSchema = z.object({
  scannedAt: z.string(),
  threshold: z.number(),
  count: z.number(),
  totalReclaimBytes: z.number(),
  candidates: z.array(CandidateSchema),
});

const GlobalArgsSchema = z.object({
  dropCandidates: z.any().describe(
    "Drop candidates from the TV curator, via CEL: " +
      "`${{ data.latest('tv-curator', 'drop_candidates').attributes }}`",
  ),
  previousHistory: z.any().optional().describe(
    "Previous candidate_history for cooling-period gating, via CEL: " +
      "`${{ data.latest('tv-cleaner', 'candidate_history').attributes }}`. Empty/null on first run.",
  ),
  sonarrUrl: z.string().describe("Sonarr base URL"),
  sonarrApiKey: z.string().describe("Sonarr API key"),
  maxDeletesPerRun: z.number().default(50)
    .describe("Hard cap on deletes per run (safety brake). 0 = no cap."),
  coolingDays: z.number().default(6)
    .describe(
      "Days a candidate must persist before auto-delete fires. 0 disables the gate.",
    ),
  protectionTagSubstrings: z.any().optional().describe(
    "Array of substrings; any Sonarr tag containing one blocks deletion. " +
      'Default: ["keep","keep-forever","do-not-delete"].',
  ),
});

const RemovalActionSchema = z.object({
  sonarrId: z.number(),
  tvdbId: z.number().optional(),
  imdbId: z.string().optional(),
  title: z.string(),
  year: z.number().optional(),
  path: z.string(),
  sizeOnDisk: z.number(),
  score: z.number(),
  decision: z.enum([
    "skipped_by_user",
    "skipped_over_cap",
    "skipped_protected_by_tag",
    "skipped_awaiting_cooling",
    "would_delete",
    "deleted",
    "failed",
  ]),
  firstSeenAt: z.string().optional(),
  ageDays: z.number().optional(),
  httpStatus: z.number().optional(),
  errorMessage: z.string().optional(),
});

const RemovalPlanSchema = z.object({
  ranAt: z.iso.datetime(),
  mode: z.enum(["dry_run", "applied"]),
  candidatesScannedAt: z.string(),
  totalCandidates: z.number(),
  skippedByUserCount: z.number(),
  skippedOverCapCount: z.number(),
  skippedProtectedByTagCount: z.number(),
  skippedAwaitingCoolingCount: z.number(),
  wouldDeleteCount: z.number(),
  deletedCount: z.number(),
  failedCount: z.number(),
  totalReclaimedBytes: z.number(),
  actions: z.array(RemovalActionSchema),
});

async function sonarrDelete(
  baseUrl: string,
  apiKey: string,
  sonarrId: number,
): Promise<{ ok: boolean; status: number; body: string }> {
  const url = `${baseUrl.replace(/\/$/, "")}/api/v3/series/${sonarrId}` +
    `?deleteFiles=true&addImportListExclusion=true`;
  const args = [
    "-sS",
    "-X",
    "DELETE",
    "-H",
    `X-Api-Key: ${apiKey}`,
    "-w",
    "\n__HTTP_STATUS__:%{http_code}",
    url,
  ];
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
  const body = m ? raw.slice(0, m.index) : raw;
  return { ok: status >= 200 && status < 300, status, body };
}

/** Swamp model definition for `@lint/tv-cleaner`. */
export const model: {
  type: string;
  version: string;
  reports: string[];
  resources: Record<string, unknown>;
  globalArguments: unknown;
  methods: Record<string, unknown>;
} = {
  type: "@lint/tv-cleaner",
  version: "2026.05.21.1",
  reports: ["@homelab/tv-cleaner"],
  globalArguments: GlobalArgsSchema,
  resources: {
    "removal_plan": {
      description:
        "Per-run plan with per-series decision (skipped/would_delete/deleted/failed).",
      schema: RemovalPlanSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    "candidate_history": {
      description:
        "When each candidate first appeared. Used for cooling-period gating.",
      schema: z.object({
        updatedAt: z.iso.datetime(),
        entries: z.array(z.object({
          key: z.string(),
          firstSeenAt: z.iso.datetime(),
        })),
      }),
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
  },
  methods: {
    applyDrops: {
      description:
        "Apply (or dry-run) deletion of TV curator-flagged drop candidates against Sonarr.",
      arguments: z.object({
        apply: z.boolean().default(false)
          .describe(
            "If true, actually call Sonarr DELETE. If false (default), dry-run only.",
          ),
        skipIds: z.any().optional().describe(
          "Array of Sonarr series IDs to spare. Pass as JSON: '[123, 456]'.",
        ),
      }),
      // deno-lint-ignore no-explicit-any
      execute: async (args: any, context: any) => {
        const apply: boolean = !!args.apply;
        const rawSkip = args.skipIds;
        const skipArr: number[] = Array.isArray(rawSkip)
          ? rawSkip
          : typeof rawSkip === "string" && rawSkip.trim().startsWith("[")
          ? JSON.parse(rawSkip)
          : [];
        const skipSet = new Set(skipArr);

        const drop = DropCandidatesSchema.parse(
          context.globalArgs.dropCandidates,
        );
        const { sonarrUrl, sonarrApiKey, maxDeletesPerRun, coolingDays } =
          context.globalArgs;

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

        const rawProtect = context.globalArgs.protectionTagSubstrings;
        const protectArr: string[] = Array.isArray(rawProtect)
          ? rawProtect
          : typeof rawProtect === "string" && rawProtect.trim().startsWith("[")
          ? JSON.parse(rawProtect)
          : ["keep", "keep-forever", "do-not-delete"];
        const protectSubs = protectArr.map((s) => s.toLowerCase());

        const ranAt = new Date().toISOString();
        const nowMs = Date.now();
        const newHistoryEntries: { key: string; firstSeenAt: string }[] = [];
        const actions: z.infer<typeof RemovalActionSchema>[] = [];
        let attempts = 0;

        for (const cand of drop.candidates) {
          const key = `sonarr:${cand.sonarrId}`;
          const firstSeenAt = prevSeen.get(key) ?? ranAt;
          newHistoryEntries.push({ key, firstSeenAt });
          const ageDays = Math.floor(
            (nowMs - Date.parse(firstSeenAt)) / 86400000,
          );

          const base = {
            sonarrId: cand.sonarrId,
            tvdbId: cand.tvdbId,
            imdbId: cand.imdbId,
            title: cand.title,
            year: cand.year,
            path: cand.path,
            sizeOnDisk: cand.sizeOnDisk,
            score: cand.score,
            firstSeenAt,
            ageDays,
          };

          if (skipSet.has(cand.sonarrId)) {
            actions.push({ ...base, decision: "skipped_by_user" });
            continue;
          }

          const tagMatch = (cand.tagNames ?? []).find((tag) =>
            protectSubs.some((sub) => tag.toLowerCase().includes(sub))
          );
          if (tagMatch) {
            actions.push({
              ...base,
              decision: "skipped_protected_by_tag",
              errorMessage: `Protected by Sonarr tag "${tagMatch}"`,
            });
            continue;
          }

          if (coolingDays > 0 && ageDays < coolingDays) {
            actions.push({
              ...base,
              decision: "skipped_awaiting_cooling",
              errorMessage:
                `On candidate list ${ageDays}d; cooling requires ${coolingDays}d before auto-delete.`,
            });
            continue;
          }

          if (maxDeletesPerRun > 0 && attempts >= maxDeletesPerRun) {
            actions.push({ ...base, decision: "skipped_over_cap" });
            continue;
          }
          attempts += 1;

          if (!apply) {
            actions.push({ ...base, decision: "would_delete" });
            continue;
          }

          const res = await sonarrDelete(
            sonarrUrl,
            sonarrApiKey,
            cand.sonarrId,
          );
          if (res.ok) {
            actions.push({
              ...base,
              decision: "deleted",
              httpStatus: res.status,
            });
          } else {
            actions.push({
              ...base,
              decision: "failed",
              httpStatus: res.status,
              errorMessage: res.body.slice(0, 400),
            });
          }
        }

        const wouldDeleteCount =
          actions.filter((a) => a.decision === "would_delete").length;
        const deletedCount =
          actions.filter((a) => a.decision === "deleted").length;
        const failedCount =
          actions.filter((a) => a.decision === "failed").length;
        const skippedByUserCount =
          actions.filter((a) => a.decision === "skipped_by_user").length;
        const skippedOverCapCount =
          actions.filter((a) => a.decision === "skipped_over_cap").length;
        const skippedProtectedByTagCount =
          actions.filter((a) => a.decision === "skipped_protected_by_tag")
            .length;
        const skippedAwaitingCoolingCount =
          actions.filter((a) => a.decision === "skipped_awaiting_cooling")
            .length;

        const reclaimSet = apply ? "deleted" : "would_delete";
        const totalReclaimedBytes = actions
          .filter((a) => a.decision === reclaimSet)
          .reduce((acc, a) => acc + a.sizeOnDisk, 0);

        const plan: z.infer<typeof RemovalPlanSchema> = {
          ranAt,
          mode: apply ? "applied" : "dry_run",
          candidatesScannedAt: drop.scannedAt,
          totalCandidates: drop.candidates.length,
          skippedByUserCount,
          skippedOverCapCount,
          skippedProtectedByTagCount,
          skippedAwaitingCoolingCount,
          wouldDeleteCount,
          deletedCount,
          failedCount,
          totalReclaimedBytes,
          actions,
        };

        const handle = await context.writeResource(
          "removal_plan",
          "removal_plan",
          plan,
        );
        const historyHandle = await context.writeResource(
          "candidate_history",
          "candidate_history",
          { updatedAt: ranAt, entries: newHistoryEntries },
        );
        return { dataHandles: [handle, historyHandle] };
      },
    },
  },
};
