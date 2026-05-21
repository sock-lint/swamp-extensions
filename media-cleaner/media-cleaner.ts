/**
 * `@lint/media-cleaner` — movie deletion executor for `@lint/media-curator`
 * drop candidates.
 *
 * Single method:
 *
 *   - `sweep` — read the latest curator `drop_candidates`, filter by tag
 *     protection (`keep-forever` or configurable) and cooling-period gate
 *     (default 6 days from first appearance), take up to `maxPerRun`, and
 *     for each: call `DELETE /api/v3/movie/{id}?deleteFiles=true&
 *     addImportListExclusion=true` against the originating Radarr instance.
 *     Emits `sweep_log` with full per-movie outcome.
 *
 * Why the Radarr API instead of `rm`? Direct file removal leaves a Radarr
 * catalog stub that re-imports on the next scan — the API delete plus
 * `addImportListExclusion=true` is the only way to remove a title and keep
 * it removed.
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
// Subset of the curator's ScoredMovie shape that we need to act.
const CandidateSchema = z.object({
  instanceLabel: z.string(),
  radarrId: z.number(),
  tmdbId: z.number().optional(),
  title: z.string(),
  year: z.number().optional(),
  path: z.string(),
  sizeOnDisk: z.number(),
  score: z.number(),
  // Optional safety fields. When present and disagree, cleaner refuses to delete.
  imdbId: z.string().optional(),
  fileImdbId: z.string().optional(),
  // Optional protection signal — any tag matching protectionTagSubstrings refuses delete.
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
    "Drop candidates from the curator, wired via CEL: " +
      "`${{ data.latest('media-curator', 'drop_candidates').attributes }}`",
  ),
  previousHistory: z.any().optional().describe(
    "Previous candidate_history (for cooling-period gating), via CEL: " +
      "`${{ data.latest('media-cleaner', 'candidate_history').attributes }}`. " +
      "Empty/null on first run.",
  ),
  radarrDefaultUrl: z.string().describe("Base URL of the 1080p Radarr"),
  radarrDefaultApiKey: z.string().describe("API key for the 1080p Radarr"),
  radarr4kUrl: z.string().describe("Base URL of the 4K Radarr"),
  radarr4kApiKey: z.string().describe("API key for the 4K Radarr"),
  defaultInstanceLabel: z.string().default("1080p")
    .describe("Instance label that maps to the default (non-4K) Radarr"),
  fourKInstanceLabel: z.string().default("4K")
    .describe("Instance label that maps to the 4K Radarr"),
  maxDeletesPerRun: z.number().default(100)
    .describe(
      "Hard cap on deletes per applyDrops call (safety brake). Set 0 to disable cap.",
    ),
  coolingDays: z.number().default(6)
    .describe(
      "Days a candidate must persist before auto-delete fires. 0 disables the gate.",
    ),
  protectionTagSubstrings: z.any().optional().describe(
    "Array of substrings; any Radarr tag containing one (case-insensitive) blocks deletion. " +
      'Default: ["keep","keep-forever","do-not-delete"].',
  ),
});

const RemovalActionSchema = z.object({
  instanceLabel: z.string(),
  radarrId: z.number(),
  tmdbId: z.number().optional(),
  imdbId: z.string().optional(),
  fileImdbId: z.string().optional(),
  title: z.string(),
  year: z.number().optional(),
  path: z.string(),
  sizeOnDisk: z.number(),
  score: z.number(),
  decision: z.enum([
    "skipped_by_user",
    "skipped_unknown_instance",
    "skipped_over_cap",
    "skipped_metadata_mismatch",
    "skipped_protected_by_tag",
    "skipped_awaiting_cooling",
    "would_delete",
    "deleted",
    "failed",
  ]),
  firstSeenAt: z.string().optional().describe(
    "When this candidate first appeared on the drop list. Used for cooling-period gating.",
  ),
  ageDays: z.number().optional().describe("Days since firstSeenAt"),
  httpStatus: z.number().optional(),
  errorMessage: z.string().optional(),
});

const HistoryEntrySchema = z.object({
  key: z.string().describe('"<instanceLabel>:<radarrId>"'),
  firstSeenAt: z.iso.datetime(),
});

const CandidateHistorySchema = z.object({
  updatedAt: z.iso.datetime(),
  entries: z.array(HistoryEntrySchema),
});

const RemovalPlanSchema = z.object({
  ranAt: z.iso.datetime(),
  mode: z.enum(["dry_run", "applied"]),
  candidatesScannedAt: z.string(),
  totalCandidates: z.number(),
  skippedByUserCount: z.number(),
  skippedOverCapCount: z.number(),
  skippedUnknownInstanceCount: z.number(),
  skippedMetadataMismatchCount: z.number(),
  skippedProtectedByTagCount: z.number(),
  skippedAwaitingCoolingCount: z.number(),
  wouldDeleteCount: z.number(),
  deletedCount: z.number(),
  failedCount: z.number(),
  totalReclaimedBytes: z.number().describe(
    "Sum of sizes for items deleted (apply mode) or that would be deleted (dry-run)",
  ),
  actions: z.array(RemovalActionSchema),
});

async function radarrDelete(
  baseUrl: string,
  apiKey: string,
  radarrId: number,
): Promise<{ ok: boolean; status: number; body: string }> {
  const url = `${baseUrl.replace(/\/$/, "")}/api/v3/movie/${radarrId}` +
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

/** Swamp model definition for `@lint/media-cleaner`. */
export const model: {
  type: string;
  version: string;
  reports: string[];
  resources: Record<string, unknown>;
  globalArguments: unknown;
  methods: Record<string, unknown>;
} = {
  type: "@lint/media-cleaner",
  version: "2026.05.21.1",
  reports: ["@homelab/media-cleaner"],
  globalArguments: GlobalArgsSchema,
  resources: {
    "removal_plan": {
      description:
        "Per-run plan: every candidate's decision (skipped / would_delete / deleted / failed) " +
        "plus the totals. New version on every applyDrops invocation.",
      schema: RemovalPlanSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    "candidate_history": {
      description:
        "Track when each candidate first appeared on the drop list. Used to enforce a " +
        "cooling period before auto-delete fires. Read by next run via CEL.",
      schema: CandidateHistorySchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
  },
  methods: {
    applyDrops: {
      description:
        "Apply (or dry-run) deletion of curator-flagged drop candidates against their owning Radarr instance.",
      arguments: z.object({
        apply: z.boolean().default(false)
          .describe(
            "If true, actually call Radarr DELETE. If false (default), dry-run only.",
          ),
        skipKeys: z.any().optional().describe(
          'Optional. Array of composite keys of the form "instanceLabel:radarrId" to spare. ' +
            'Pass as JSON: \'["1080p:1234","4K:7"]\'.',
        ),
      }),
      // deno-lint-ignore no-explicit-any
      execute: async (args: any, context: any) => {
        const apply: boolean = !!args.apply;
        const rawSkip = args.skipKeys;
        const skipArr: string[] = Array.isArray(rawSkip)
          ? rawSkip
          : typeof rawSkip === "string" && rawSkip.trim().startsWith("[")
          ? JSON.parse(rawSkip)
          : [];
        const skipKeys = new Set(skipArr.map((s) => s.trim()));

        const drop = DropCandidatesSchema.parse(
          context.globalArgs.dropCandidates,
        );
        const {
          radarrDefaultUrl,
          radarrDefaultApiKey,
          radarr4kUrl,
          radarr4kApiKey,
          defaultInstanceLabel,
          fourKInstanceLabel,
          maxDeletesPerRun,
          coolingDays,
        } = context.globalArgs;

        // Read previous candidate history for cooling-period gating.
        const prevHistory = context.globalArgs.previousHistory;
        const prevSeen = new Map<string, string>(); // key -> firstSeenAt
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
        const protectArray: string[] = Array.isArray(rawProtect)
          ? rawProtect
          : typeof rawProtect === "string" && rawProtect.trim().startsWith("[")
          ? JSON.parse(rawProtect)
          : ["keep", "keep-forever", "do-not-delete"];
        const protectSubs = protectArray.map((s) => s.toLowerCase());

        const ranAt = new Date().toISOString();
        const nowMs = Date.now();
        const newHistoryEntries: z.infer<typeof HistoryEntrySchema>[] = [];
        const actions: z.infer<typeof RemovalActionSchema>[] = [];
        let deleteAttempts = 0;

        for (const cand of drop.candidates) {
          const key = `${cand.instanceLabel}:${cand.radarrId}`;
          const firstSeenAt = prevSeen.get(key) ?? ranAt;
          newHistoryEntries.push({ key, firstSeenAt });
          const ageDays = Math.floor(
            (nowMs - Date.parse(firstSeenAt)) / 86400000,
          );

          const base = {
            instanceLabel: cand.instanceLabel,
            radarrId: cand.radarrId,
            tmdbId: cand.tmdbId,
            imdbId: cand.imdbId,
            fileImdbId: cand.fileImdbId,
            title: cand.title,
            year: cand.year,
            path: cand.path,
            sizeOnDisk: cand.sizeOnDisk,
            score: cand.score,
            firstSeenAt,
            ageDays,
          };

          if (skipKeys.has(key)) {
            actions.push({ ...base, decision: "skipped_by_user" });
            continue;
          }

          // Persistent protection — if the movie carries any tag matching protectionTagSubstrings,
          // refuse to delete. The "I want to keep this forever" decision lives in Radarr where
          // it's visible in the UI and survives swamp model rebuilds.
          const tagMatch = (cand.tagNames ?? []).find((t) =>
            protectSubs.some((sub) => t.toLowerCase().includes(sub))
          );
          if (tagMatch) {
            actions.push({
              ...base,
              decision: "skipped_protected_by_tag",
              errorMessage: `Protected by Radarr tag "${tagMatch}"`,
            });
            continue;
          }

          // Cooling-period gate: defer auto-delete until the candidate has persisted long
          // enough to give the user time to add a keep-forever tag.
          if (coolingDays > 0 && ageDays < coolingDays) {
            actions.push({
              ...base,
              decision: "skipped_awaiting_cooling",
              errorMessage:
                `On candidate list ${ageDays}d; cooling requires ${coolingDays}d before auto-delete.`,
            });
            continue;
          }

          // Safety brake: refuse to delete when Radarr metadata doesn't match the file on disk.
          // This catches mis-imported movies (e.g., Radarr tagged "Halloween Nightmare 2" but the file
          // is actually The Hallow). Without this, applyDrops could destroy good titles.
          if (
            cand.fileImdbId &&
            cand.imdbId &&
            cand.fileImdbId.toLowerCase() !== cand.imdbId.toLowerCase()
          ) {
            actions.push({
              ...base,
              decision: "skipped_metadata_mismatch",
              errorMessage:
                `Radarr imdbId ${cand.imdbId} but file says ${cand.fileImdbId}. ` +
                `Fix Radarr metadata before deleting.`,
            });
            continue;
          }
          // Also refuse if file has an imdb tag but Radarr's imdbId is null — same risk class.
          if (cand.fileImdbId && !cand.imdbId) {
            actions.push({
              ...base,
              decision: "skipped_metadata_mismatch",
              errorMessage:
                `File has imdb ${cand.fileImdbId} but Radarr has no imdbId. ` +
                `Re-match in Radarr before deleting.`,
            });
            continue;
          }

          // Resolve which Radarr to call
          let url: string;
          let apiKey: string;
          if (cand.instanceLabel === defaultInstanceLabel) {
            url = radarrDefaultUrl;
            apiKey = radarrDefaultApiKey;
          } else if (cand.instanceLabel === fourKInstanceLabel) {
            url = radarr4kUrl;
            apiKey = radarr4kApiKey;
          } else {
            actions.push({
              ...base,
              decision: "skipped_unknown_instance",
              errorMessage:
                `instanceLabel "${cand.instanceLabel}" matches neither defaultInstanceLabel ` +
                `"${defaultInstanceLabel}" nor fourKInstanceLabel "${fourKInstanceLabel}"`,
            });
            continue;
          }

          // Cap check
          if (maxDeletesPerRun > 0 && deleteAttempts >= maxDeletesPerRun) {
            actions.push({ ...base, decision: "skipped_over_cap" });
            continue;
          }
          deleteAttempts += 1;

          if (!apply) {
            actions.push({ ...base, decision: "would_delete" });
            continue;
          }

          // Live delete
          const res = await radarrDelete(url, apiKey, cand.radarrId);
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
        const skippedUnknownInstanceCount =
          actions.filter((a) => a.decision === "skipped_unknown_instance")
            .length;
        const skippedMetadataMismatchCount =
          actions.filter((a) => a.decision === "skipped_metadata_mismatch")
            .length;
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
          skippedUnknownInstanceCount,
          skippedMetadataMismatchCount,
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
