/**
 * `@lint/tv-curator` — TV series keep-score engine.
 *
 * Fuses Sonarr (catalog + ratings + tags), Overseerr/Jellyseerr (request
 * provenance), Tautulli (per-show play history), and Plex (library
 * membership) into a per-series keep score. Surfaces low-scoring entries
 * as `drop_candidates` for downstream pruning by `@lint/tv-cleaner`.
 *
 * Key distinguishing signal vs the movie curator: `endedUnwatchedPenalty`
 * (default 0; suggested -30 for aggressive libraries) — completed series
 * that have zero plays in Tautulli are penalized, on the theory that an
 * ended show nobody ever watched is a much stronger delete candidate than
 * an ongoing show that just hasn't been touched yet.
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
// ---------- Input shapes (mirror sonarr / seerr / tautulli) ----------

const SonarrSeriesSchema = z.object({
  id: z.number(),
  tvdbId: z.number().optional(),
  imdbId: z.string().optional(),
  tmdbId: z.number().optional(),
  title: z.string(),
  year: z.number().optional(),
  folderName: z.string(),
  path: z.string(),
  sizeOnDisk: z.number(),
  episodeCount: z.number(),
  episodeFileCount: z.number(),
  percentOfEpisodes: z.number(),
  status: z.string().optional(),
  monitored: z.boolean().optional(),
  added: z.string().optional(),
  network: z.string().optional(),
  runtime: z.number().optional(),
  certification: z.string().optional(),
  genres: z.array(z.string()).optional(),
  rating: z.number().optional(),
  ratingVotes: z.number().optional(),
  tagIds: z.array(z.number()).optional(),
  tagNames: z.array(z.string()).optional(),
});

const SonarrInventorySchema = z.object({
  instanceLabel: z.string(),
  baseUrl: z.string(),
  seriesCount: z.number(),
  totalSizeBytes: z.number(),
  series: z.array(SonarrSeriesSchema),
  fetchedAt: z.string(),
});

const SeerrRequestSchema = z.object({
  id: z.number(),
  mediaType: z.enum(["movie", "tv"]),
  tmdbId: z.number().optional(),
  is4k: z.boolean(),
  isAutoRequest: z.boolean(),
  status: z.number(),
  createdAt: z.string(),
  requestedByUsername: z.string().optional(),
}).passthrough();

const SeerrRequestsSchema = z.object({
  totalRequests: z.number(),
  requests: z.array(SeerrRequestSchema),
  fetchedAt: z.string(),
});

const TautulliShowSchema = z.object({
  sectionId: z.number(),
  ratingKey: z.string(),
  title: z.string(),
  year: z.number().optional(),
  playCount: z.number(),
  lastPlayedUnix: z.number().optional(),
});

const TautulliShowHistorySchema = z.object({
  totalItems: z.number(),
  withAnyPlay: z.number(),
  withZeroPlays: z.number(),
  shows: z.array(TautulliShowSchema),
  fetchedAt: z.string(),
});

// ---------- Tunable thresholds ----------

const ThresholdsSchema = z.object({
  dropCandidateMaxScore: z.number().default(-5),
  highReviewThreshold: z.number().default(80).describe(
    "0-100 scale (TMDb's 0-10 multiplied by 10)",
  ),
  lowReviewThreshold: z.number().default(50),
  highReviewBonus: z.number().default(20),
  lowReviewPenalty: z.number().default(-15),
  watchPerPlayBonus: z.number().default(5).describe(
    "TV play = single-episode play. Stacks up to cap.",
  ),
  watchMaxBonus: z.number().default(60),
  manualSeerrBonus: z.number().default(50),
  autoSeerrBonus: z.number().default(10),
  // Tenure — like movies, treat long time on disk as a collection signal, NOT abandonment.
  recencyNewBonus: z.number().default(5).describe("Bonus if added <30d ago"),
  tenureSoftDays: z.number().default(365),
  tenureSoftBonus: z.number().default(5).describe(
    "Bonus if kept > tenureSoftDays",
  ),
  tenureHardDays: z.number().default(730),
  tenureHardBonus: z.number().default(10).describe(
    "Bonus if kept > tenureHardDays — long-archived series",
  ),
  endedUnwatchedPenalty: z.number().default(0)
    .describe(
      "Disabled by default. 'Ended' is the natural state of most TV; not a curation signal.",
    ),
  protectionTagBonus: z.number().default(200),
}).default({});

const GlobalArgsSchema = z.object({
  sonarrInventory: z.any().describe(
    "Inventory from sonarr via CEL `${{ data.latest('sonarr', 'inventory').attributes }}`",
  ),
  seerrRequests: z.any().describe("Seerr requests via CEL"),
  tautulliShowHistory: z.any().describe("Tautulli show_history via CEL"),
  thresholds: ThresholdsSchema.optional(),
  protectionTagSubstrings: z.any().optional().describe(
    "Array of substrings; any Sonarr tag containing one (case-insensitive) protects the show. " +
      'Default: ["keep","keep-forever","do-not-delete"].',
  ),
});

// ---------- Output shapes ----------

const ScoreBreakdownSchema = z.object({
  provenance: z.number(),
  watchHistory: z.number(),
  reviews: z.number(),
  recency: z.number(),
  endedUnwatched: z.number(),
  protectionTag: z.number(),
});

const ScoredSeriesSchema = z.object({
  sonarrId: z.number(),
  tvdbId: z.number().optional(),
  imdbId: z.string().optional(),
  tmdbId: z.number().optional(),
  title: z.string(),
  year: z.number().optional(),
  path: z.string(),
  sizeOnDisk: z.number(),
  episodeCount: z.number(),
  episodeFileCount: z.number(),
  percentOfEpisodes: z.number(),
  status: z.string().optional(),
  monitored: z.boolean().optional(),
  added: z.string().optional(),
  playCount: z.number(),
  lastPlayedUnix: z.number().optional(),
  inSeerr: z.boolean(),
  seerrRequestedBy: z.string().optional(),
  rating: z.number().optional(),
  tagNames: z.array(z.string()).optional(),
  score: z.number(),
  breakdown: ScoreBreakdownSchema,
  reasons: z.array(z.string()),
});

const ScoresSchema = z.object({
  scannedAt: z.string(),
  totalScored: z.number(),
  series: z.array(ScoredSeriesSchema),
});

const DropCandidatesSchema = z.object({
  scannedAt: z.string(),
  threshold: z.number(),
  count: z.number(),
  totalReclaimBytes: z.number(),
  candidates: z.array(ScoredSeriesSchema),
});

const ProtectedDropsSchema = z.object({
  scannedAt: z.string(),
  threshold: z.number(),
  count: z.number(),
  totalShieldedBytes: z.number(),
  protected: z.array(ScoredSeriesSchema),
});

const SummarySchema = z.object({
  scannedAt: z.string(),
  totalScored: z.number(),
  endedCount: z.number(),
  continuingCount: z.number(),
  inSeerrCount: z.number(),
  watchedCount: z.number(),
  neverWatchedCount: z.number(),
  dropCandidateCount: z.number(),
  dropCandidateBytes: z.number(),
  protectedDropCount: z.number(),
  protectedDropBytes: z.number(),
  byScoreBucket: z.object({
    high: z.number(),
    mid: z.number(),
    low: z.number(),
    veryLow: z.number(),
  }),
});

// ---------- Helpers ----------

function normalizeTitle(t: string): string {
  let s = t.toLowerCase();
  s = s.replace(/,\s*(the|a|an)$/i, "");
  s = s.replace(/^(the|a|an)\s+/i, "");
  s = s.replace(/[^a-z0-9]+/g, "");
  return s;
}

function dayDiff(iso: string | undefined, nowMs: number): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return undefined;
  return Math.floor((nowMs - t) / 86400000);
}

// ---------- Model ----------

/** Swamp model definition for `@lint/tv-curator`. */
export const model: {
  type: string;
  version: string;
  reports: string[];
  resources: Record<string, unknown>;
  globalArguments: unknown;
  methods: Record<string, unknown>;
} = {
  type: "@lint/tv-curator",
  version: "2026.05.22.1",
  reports: ["@homelab/tv-curator"],
  globalArguments: GlobalArgsSchema,
  resources: {
    "scores": {
      description: "Per-series keep-score with breakdown",
      schema: ScoresSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    "drop_candidates": {
      description:
        "Series below the drop-score threshold, sorted by sizeOnDisk desc",
      schema: DropCandidatesSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    "protected_drops": {
      description:
        "Series that WOULD be drop candidates by natural score but are shielded by a keep-forever tag.",
      schema: ProtectedDropsSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    "summary": {
      description: "Top-line curator summary for TV",
      schema: SummarySchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
  },
  methods: {
    score: {
      description:
        "Score every series on provenance + watch + reviews + status + recency + tags",
      arguments: z.object({}),
      execute: async (_args: ExecuteArgs, context: ExecuteContext) => {
        const sonarr = SonarrInventorySchema.parse(
          context.globalArgs.sonarrInventory,
        );
        const seerr = SeerrRequestsSchema.parse(
          context.globalArgs.seerrRequests,
        );
        const tautulli = TautulliShowHistorySchema.parse(
          context.globalArgs.tautulliShowHistory,
        );
        const t = ThresholdsSchema.parse(context.globalArgs.thresholds ?? {});

        const rawProtect = context.globalArgs.protectionTagSubstrings;
        const protectArr: string[] = Array.isArray(rawProtect)
          ? rawProtect
          : typeof rawProtect === "string" && rawProtect.trim().startsWith("[")
          ? JSON.parse(rawProtect)
          : ["keep", "keep-forever", "do-not-delete"];
        const protectSubs = protectArr.map((s) => s.toLowerCase());

        const scannedAt = new Date().toISOString();
        const nowMs = Date.now();

        // Seerr lookup — for TV, requests can also carry tmdbId, but Sonarr keys on tvdbId.
        // Seerr's request schema doesn't always expose tvdbId on the request itself; fall back to tmdbId.
        const seerrByTmdb = new Map<
          number,
          z.infer<typeof SeerrRequestSchema>
        >();
        for (const r of seerr.requests) {
          if (r.mediaType === "tv" && typeof r.tmdbId === "number") {
            seerrByTmdb.set(r.tmdbId, r);
          }
        }

        const watchByKey = new Map<
          string,
          z.infer<typeof TautulliShowSchema>
        >();
        for (const s of tautulli.shows) {
          const key = `${normalizeTitle(s.title)}|${s.year ?? ""}`;
          const existing = watchByKey.get(key);
          if (!existing || existing.playCount < s.playCount) {
            watchByKey.set(key, s);
          }
        }

        const scored: z.infer<typeof ScoredSeriesSchema>[] = [];

        for (const s of sonarr.series) {
          const breakdown = {
            provenance: 0,
            watchHistory: 0,
            reviews: 0,
            recency: 0,
            endedUnwatched: 0,
            protectionTag: 0,
          };
          const reasons: string[] = [];

          // Protection tag
          const matchedTag = (s.tagNames ?? []).find((tag) =>
            protectSubs.some((sub) => tag.toLowerCase().includes(sub))
          );
          if (matchedTag) {
            breakdown.protectionTag = t.protectionTagBonus;
            reasons.push(
              `+${t.protectionTagBonus} protected by Sonarr tag "${matchedTag}"`,
            );
          }

          // Provenance
          const seerrReq = typeof s.tmdbId === "number"
            ? seerrByTmdb.get(s.tmdbId)
            : undefined;
          if (seerrReq) {
            const v = seerrReq.isAutoRequest
              ? t.autoSeerrBonus
              : t.manualSeerrBonus;
            breakdown.provenance = v;
            reasons.push(
              seerrReq.isAutoRequest
                ? `+${v} auto-requested via Seerr`
                : `+${v} manually requested via Seerr${
                  seerrReq.requestedByUsername
                    ? ` by ${seerrReq.requestedByUsername}`
                    : ""
                }`,
            );
          }

          // Watch history
          const tKey = `${normalizeTitle(s.title)}|${s.year ?? ""}`;
          const w = watchByKey.get(tKey);
          const playCount = w?.playCount ?? 0;
          if (playCount > 0) {
            const v = Math.min(
              t.watchMaxBonus,
              playCount * t.watchPerPlayBonus,
            );
            breakdown.watchHistory = v;
            reasons.push(
              `+${v} watched ${playCount} episode play${
                playCount === 1 ? "" : "s"
              } in Plex`,
            );
          }

          // Reviews (Sonarr's 0-10 scaled to 0-100)
          if (typeof s.rating === "number" && s.rating > 0) {
            const scaled = s.rating * 10;
            if (scaled >= t.highReviewThreshold) {
              breakdown.reviews = t.highReviewBonus;
              reasons.push(
                `+${t.highReviewBonus} strong reviews (TMDb ${
                  s.rating.toFixed(1)
                })`,
              );
            } else if (scaled <= t.lowReviewThreshold) {
              breakdown.reviews = t.lowReviewPenalty;
              reasons.push(
                `${t.lowReviewPenalty} weak reviews (TMDb ${
                  s.rating.toFixed(1)
                })`,
              );
            }
          }

          // Tenure — surviving on disk is a positive signal regardless of watch.
          // (Mirrors movie logic: TV libraries are collections too.)
          const ageDays = dayDiff(s.added, nowMs);
          if (typeof ageDays === "number") {
            if (ageDays < 30) {
              breakdown.recency = t.recencyNewBonus;
              reasons.push(
                `+${t.recencyNewBonus} added recently (${ageDays}d ago)`,
              );
            } else if (ageDays > t.tenureHardDays) {
              breakdown.recency = t.tenureHardBonus;
              reasons.push(
                `+${t.tenureHardBonus} long-archived series (${ageDays}d on disk)`,
              );
            } else if (ageDays > t.tenureSoftDays) {
              breakdown.recency = t.tenureSoftBonus;
              reasons.push(
                `+${t.tenureSoftBonus} kept in library for ${ageDays}d`,
              );
            }
          }

          // Ended-unwatched penalty — disabled by default (configurable to re-enable).
          // 'Ended' is the natural state of most TV; not a curation signal.
          if (
            s.status === "ended" && playCount === 0 &&
            t.endedUnwatchedPenalty !== 0
          ) {
            breakdown.endedUnwatched = t.endedUnwatchedPenalty;
            reasons.push(
              `${t.endedUnwatchedPenalty} show is ended and never watched`,
            );
          }

          const score = breakdown.provenance + breakdown.watchHistory +
            breakdown.reviews +
            breakdown.recency + breakdown.endedUnwatched +
            breakdown.protectionTag;

          scored.push({
            sonarrId: s.id,
            tvdbId: s.tvdbId,
            imdbId: s.imdbId,
            tmdbId: s.tmdbId,
            title: s.title,
            year: s.year,
            path: s.path,
            sizeOnDisk: s.sizeOnDisk,
            episodeCount: s.episodeCount,
            episodeFileCount: s.episodeFileCount,
            percentOfEpisodes: s.percentOfEpisodes,
            status: s.status,
            monitored: s.monitored,
            added: s.added,
            playCount,
            lastPlayedUnix: w?.lastPlayedUnix,
            inSeerr: !!seerrReq,
            seerrRequestedBy: seerrReq?.requestedByUsername,
            rating: s.rating,
            tagNames: s.tagNames,
            score,
            breakdown,
            reasons,
          });
        }

        scored.sort((a, b) => {
          if (a.score !== b.score) return a.score - b.score;
          return b.sizeOnDisk - a.sizeOnDisk;
        });

        function natural(s: typeof scored[0]): number {
          return s.score - (s.breakdown?.protectionTag ?? 0);
        }
        const wouldDrop = scored.filter((s) =>
          natural(s) <= t.dropCandidateMaxScore
        );
        const candidates = wouldDrop.filter((s) =>
          (s.breakdown?.protectionTag ?? 0) === 0
        );
        const protectedDrops = wouldDrop.filter((s) =>
          (s.breakdown?.protectionTag ?? 0) > 0
        );
        const sortBySizeDesc = (arr: typeof scored) =>
          arr.sort((a, b) => {
            if (a.score !== b.score) return a.score - b.score;
            return b.sizeOnDisk - a.sizeOnDisk;
          });
        sortBySizeDesc(candidates);
        sortBySizeDesc(protectedDrops);
        const reclaimBytes = candidates.reduce(
          (acc, c) => acc + c.sizeOnDisk,
          0,
        );
        const protectedBytes = protectedDrops.reduce(
          (acc, c) => acc + c.sizeOnDisk,
          0,
        );

        const endedCount = scored.filter((s) => s.status === "ended").length;
        const continuingCount =
          scored.filter((s) => s.status === "continuing").length;
        const inSeerrCount = scored.filter((s) => s.inSeerr).length;
        const watchedCount = scored.filter((s) => s.playCount > 0).length;
        const high = scored.filter((s) => s.score >= 50).length;
        const mid = scored.filter((s) => s.score >= 0 && s.score < 50).length;
        const low = scored.filter((s) => s.score < 0 && s.score > -20).length;
        const veryLow = scored.filter((s) => s.score <= -20).length;

        const scoresRes = {
          scannedAt,
          totalScored: scored.length,
          series: scored,
        };
        const dropRes = {
          scannedAt,
          threshold: t.dropCandidateMaxScore,
          count: candidates.length,
          totalReclaimBytes: reclaimBytes,
          candidates,
        };
        const protectedRes = {
          scannedAt,
          threshold: t.dropCandidateMaxScore,
          count: protectedDrops.length,
          totalShieldedBytes: protectedBytes,
          protected: protectedDrops,
        };
        const summaryRes = {
          scannedAt,
          totalScored: scored.length,
          endedCount,
          continuingCount,
          inSeerrCount,
          watchedCount,
          neverWatchedCount: scored.length - watchedCount,
          dropCandidateCount: candidates.length,
          dropCandidateBytes: reclaimBytes,
          protectedDropCount: protectedDrops.length,
          protectedDropBytes: protectedBytes,
          byScoreBucket: { high, mid, low, veryLow },
        };

        const h1 = await context.writeResource("scores", "scores", scoresRes);
        const h2 = await context.writeResource(
          "drop_candidates",
          "drop_candidates",
          dropRes,
        );
        const h3 = await context.writeResource(
          "protected_drops",
          "protected_drops",
          protectedRes,
        );
        const h4 = await context.writeResource(
          "summary",
          "summary",
          summaryRes,
        );
        return { dataHandles: [h1, h2, h3, h4] };
      },
    },
  },
};
