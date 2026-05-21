/**
 * `@lint/media-curator` — movie keep-score engine.
 *
 * Fuses Radarr (catalog + ratings + tags), Overseerr/Jellyseerr (request
 * provenance), Tautulli (play history), and Plex (library membership) into
 * a per-movie keep score with a reason breakdown. Read-only — emits
 * `scored`, `summary`, `drop_candidates`, and `protected_drops` resources
 * for downstream cleaners to consume.
 *
 * Signals (configurable weights): tenure, play count, review scores with a
 * vote-count threshold (default 50) to discount low-vote outliers, request
 * provenance, tag bonuses/penalties (`keep-forever` is +200), size on disk.
 * Defaults are tuned for a "library-as-collection" philosophy where older
 * titles get a small positive bonus rather than a tenure penalty.
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
// ---------- Schemas (shared with radarr/seerr/tautulli outputs) ----------

const RatingSourceSchema = z.object({
  value: z.number(),
  votes: z.number().optional(),
}).optional();

const RatingsSchema = z.object({
  imdb: RatingSourceSchema,
  tmdb: RatingSourceSchema,
  rottenTomatoes: RatingSourceSchema,
  metacritic: RatingSourceSchema,
  trakt: RatingSourceSchema,
});

const RadarrMovieSchema = z.object({
  id: z.number(),
  tmdbId: z.number().optional(),
  imdbId: z.string().optional(),
  title: z.string(),
  year: z.number().optional(),
  folderName: z.string(),
  path: z.string(),
  sizeOnDisk: z.number(),
  hasFile: z.boolean(),
  monitored: z.boolean().optional(),
  qualityProfileId: z.number().optional(),
  added: z.string().optional(),
  popularity: z.number().optional(),
  runtime: z.number().optional(),
  certification: z.string().optional(),
  genres: z.array(z.string()).optional(),
  studio: z.string().optional(),
  originalLanguage: z.string().optional(),
  audioLanguages: z.string().optional(),
  subtitleLanguages: z.string().optional(),
  fileImdbId: z.string().optional(),
  collectionTitle: z.string().optional(),
  collectionTmdbId: z.number().optional(),
  tagIds: z.array(z.number()).optional(),
  tagNames: z.array(z.string()).optional(),
  ratings: RatingsSchema.optional(),
});

const RadarrInventorySchema = z.object({
  instanceLabel: z.string(),
  baseUrl: z.string(),
  movieCount: z.number(),
  withFileCount: z.number(),
  totalSizeBytes: z.number(),
  movies: z.array(RadarrMovieSchema),
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
});

const SeerrRequestsSchema = z.object({
  totalRequests: z.number(),
  requests: z.array(SeerrRequestSchema.passthrough()),
  fetchedAt: z.string(),
});

const TautulliMovieSchema = z.object({
  sectionId: z.number(),
  ratingKey: z.string(),
  title: z.string(),
  year: z.number().optional(),
  playCount: z.number(),
  lastPlayedUnix: z.number().optional(),
});

const TautulliHistorySchema = z.object({
  totalItems: z.number(),
  withAnyPlay: z.number(),
  withZeroPlays: z.number(),
  movies: z.array(TautulliMovieSchema.passthrough()),
  fetchedAt: z.string(),
});

// ---------- Global args + outputs ----------

const ThresholdsSchema = z.object({
  dropCandidateMaxScore: z.number().default(-5)
    .describe("Movies with score <= this are surfaced as drop candidates"),
  highReviewThreshold: z.number().default(80),
  lowReviewThreshold: z.number().default(50),
  highReviewBonus: z.number().default(20),
  lowReviewPenalty: z.number().default(-15),
  minReviewVotesPerSource: z.number().default(50)
    .describe(
      "Rating sources below this vote count are ignored (no statistical weight)",
    ),
  // Collection weights — boosted so partial collections aren't broken by weak reviews.
  largeCollectionSiblings: z.number().default(5).describe(
    ">= N siblings → large collection",
  ),
  largeCollectionBonus: z.number().default(30),
  mediumCollectionSiblings: z.number().default(3).describe(
    ">= N siblings → medium collection",
  ),
  mediumCollectionBonus: z.number().default(20),
  smallCollectionBonus: z.number().default(10).describe(
    "Bonus for exactly 2 siblings (a pair)",
  ),
  // Watch
  watchPerPlayBonus: z.number().default(30),
  watchMaxBonus: z.number().default(60),
  // Seerr
  manualSeerrBonus: z.number().default(50),
  autoSeerrBonus: z.number().default(10),
  // Tenure — movies are about collection. Long time on disk = vote of confidence, not abandonment.
  // (TV inverts this — see tv-curator.)
  recencyNewBonus: z.number().default(5)
    .describe("Bonus if added <30 days ago — give it time"),
  tenureSoftDays: z.number().default(365)
    .describe("Threshold above which a movie counts as 'kept around'"),
  tenureSoftBonus: z.number().default(5)
    .describe("Bonus if added > tenureSoftDays ago"),
  tenureHardDays: z.number().default(730)
    .describe(
      "Threshold above which a movie counts as a 'long-tenured library piece'",
    ),
  tenureHardBonus: z.number().default(10)
    .describe("Bonus if added > tenureHardDays ago"),
  // Audio language — penalize movies whose file has no track in the preferred language.
  // Treat 'und' (undetermined) and missing tags as unknown — no signal, no penalty.
  // Accept multiple code conventions for the same language (ISO 639-1 "en" AND 639-2 "eng").
  preferredAudioLanguages: z.array(z.string()).default(["eng", "en"])
    .describe(
      "List of audio codes that count as 'preferred'. Default ['eng','en'].",
    ),
  nonPreferredAudioPenalty: z.number().default(-20)
    .describe(
      "Applied when movieFile audio tracks contain none of the preferred languages. Set to a number; strong reviews (+20) will counterbalance.",
    ),
}).default({});

const GlobalArgsSchema = z.object({
  radarrDefault: z.any().describe(
    "Inventory from default Radarr (1080p) via CEL `${{ data.latest('radarr-default', 'inventory').attributes }}`",
  ),
  radarr4k: z.any().describe("Inventory from 4K Radarr via CEL"),
  seerrRequests: z.any().describe("All Seerr requests via CEL"),
  tautulliHistory: z.any().describe("Tautulli watch history via CEL"),
  thresholds: ThresholdsSchema.optional(),
  franchisePrefixes: z.any().describe(
    "Array of substrings to treat as implicit franchises when TMDb collection is null. " +
      "Matched against normalized titles (lowercase, alphanumeric only). " +
      'Pass as JSON array, e.g. \'["starwars","puppetmaster"]\'. Empty by default.',
  ),
  protectionTagSubstrings: z.any().optional().describe(
    "Array of substrings; any Radarr tag containing one of these (case-insensitive) " +
      'protects the movie from drop. Default: ["keep","keep-forever","do-not-delete"].',
  ),
});

const ScoreBreakdownSchema = z.object({
  provenance: z.number(),
  watchHistory: z.number(),
  reviews: z.number(),
  collection: z.number(),
  recency: z.number(),
  monitored: z.number(),
  audioLanguage: z.number(),
  protectionTag: z.number(),
});

const ScoredMovieSchema = z.object({
  instanceLabel: z.string(),
  radarrId: z.number(),
  tmdbId: z.number().optional(),
  imdbId: z.string().optional(),
  fileImdbId: z.string().optional(),
  title: z.string(),
  year: z.number().optional(),
  path: z.string(),
  sizeOnDisk: z.number(),
  added: z.string().optional(),
  monitored: z.boolean().optional(),
  playCount: z.number(),
  lastPlayedUnix: z.number().optional(),
  inSeerr: z.boolean(),
  seerrRequestedBy: z.string().optional(),
  bestReviewScore: z.number().optional(),
  collectionTitle: z.string().optional(),
  collectionSiblingCount: z.number(),
  tagNames: z.array(z.string()).optional(),
  score: z.number(),
  breakdown: ScoreBreakdownSchema,
  reasons: z.array(z.string()),
});

const ScoresSchema = z.object({
  scannedAt: z.string(),
  totalMoviesScored: z.number(),
  movies: z.array(ScoredMovieSchema),
});

const DropCandidatesSchema = z.object({
  scannedAt: z.string(),
  threshold: z.number(),
  count: z.number(),
  totalReclaimBytes: z.number(),
  candidates: z.array(ScoredMovieSchema),
});

const ProtectedDropsSchema = z.object({
  scannedAt: z.string(),
  threshold: z.number(),
  count: z.number(),
  totalShieldedBytes: z.number().describe(
    "Sum of sizes for items the keep-forever tag is currently shielding from deletion",
  ),
  protected: z.array(ScoredMovieSchema),
});

const CuratorSummarySchema = z.object({
  scannedAt: z.string(),
  totalScored: z.number(),
  inSeerrCount: z.number(),
  watchedCount: z.number(),
  neverWatchedCount: z.number(),
  unmonitoredCount: z.number(),
  dropCandidateCount: z.number(),
  dropCandidateBytes: z.number(),
  protectedDropCount: z.number().describe(
    "Items the keep-forever tag is currently shielding from drop",
  ),
  protectedDropBytes: z.number(),
  byScoreBucket: z.object({
    high: z.number().describe(">= 50"),
    mid: z.number().describe("0..49"),
    low: z.number().describe("-1..-19"),
    veryLow: z.number().describe("<= -20"),
  }),
});

// ---------- Helpers ----------

function normalizeTitle(t: string): string {
  let s = t.toLowerCase();
  // ", The"/", A"/", An" suffix → strip
  s = s.replace(/,\s*(the|a|an)$/i, "");
  // "The "/"A "/"An " prefix → strip
  s = s.replace(/^(the|a|an)\s+/i, "");
  // strip non-alphanumeric
  s = s.replace(/[^a-z0-9]+/g, "");
  return s;
}

function dayDiff(
  isoOrUnix: string | number | undefined,
  nowMs: number,
): number | undefined {
  if (!isoOrUnix) return undefined;
  const t = typeof isoOrUnix === "number"
    ? isoOrUnix * 1000
    : Date.parse(isoOrUnix);
  if (Number.isNaN(t)) return undefined;
  return Math.floor((nowMs - t) / 86400000);
}

function bestReview(
  r?: z.infer<typeof RatingsSchema>,
  minVotes = 50,
): number | undefined {
  if (!r) return undefined;
  const candidates: number[] = [];
  // RT and Metacritic don't have user vote counts in Radarr — treat as already aggregated.
  if (r.rottenTomatoes && r.rottenTomatoes.value > 0) {
    candidates.push(r.rottenTomatoes.value);
  }
  if (r.metacritic && r.metacritic.value > 0) {
    candidates.push(r.metacritic.value);
  }
  // IMDb / TMDb / Trakt have user votes — require minVotes to count.
  if (r.imdb && r.imdb.value > 0 && (r.imdb.votes ?? 0) >= minVotes) {
    candidates.push(r.imdb.value * 10);
  }
  if (r.tmdb && r.tmdb.value > 0 && (r.tmdb.votes ?? 0) >= minVotes) {
    candidates.push(r.tmdb.value * 10);
  }
  if (r.trakt && r.trakt.value > 0 && (r.trakt.votes ?? 0) >= minVotes) {
    candidates.push(r.trakt.value * 10);
  }
  if (candidates.length === 0) return undefined;
  return Math.max(...candidates);
}

// ---------- Model ----------

/** Swamp model definition for `@lint/media-curator`. */
export const model: {
  type: string;
  version: string;
  reports: string[];
  resources: Record<string, unknown>;
  globalArguments: unknown;
  methods: Record<string, unknown>;
} = {
  type: "@lint/media-curator",
  version: "2026.05.21.1",
  reports: ["@homelab/media-curator"],
  globalArguments: GlobalArgsSchema,
  resources: {
    "scores": {
      description: "Per-movie keep-score with reasoning breakdown",
      schema: ScoresSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    "drop_candidates": {
      description:
        "Filtered subset: movies below the drop-score threshold, sorted by sizeOnDisk desc",
      schema: DropCandidatesSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    "protected_drops": {
      description:
        "Movies that WOULD be drop candidates by natural score but are shielded by a keep-forever tag. " +
        "Surfaced so the user can review whether protections still make sense.",
      schema: ProtectedDropsSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    "summary": {
      description: "Top-line curator summary",
      schema: CuratorSummarySchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
  },
  methods: {
    score: {
      description:
        "Score every movie on provenance (Seerr) + watch (Tautulli) + reviews + collection + recency; emit scores, drop candidates, and a summary",
      arguments: z.object({}),
      execute: async (_args: ExecuteArgs, context: ExecuteContext) => {
        const radarrDefault = RadarrInventorySchema.parse(
          context.globalArgs.radarrDefault,
        );
        const radarr4k = RadarrInventorySchema.parse(
          context.globalArgs.radarr4k,
        );
        const seerrReqs = SeerrRequestsSchema.parse(
          context.globalArgs.seerrRequests,
        );
        const tautulli = TautulliHistorySchema.parse(
          context.globalArgs.tautulliHistory,
        );
        const thresholds = ThresholdsSchema.parse(
          context.globalArgs.thresholds ?? {},
        );
        const rawFranchises = context.globalArgs.franchisePrefixes;
        const franchiseArray: string[] = Array.isArray(rawFranchises)
          ? rawFranchises
          : typeof rawFranchises === "string" &&
              rawFranchises.trim().startsWith("[")
          ? JSON.parse(rawFranchises)
          : [];
        const franchisePrefixes: string[] = franchiseArray.map(
          (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ""),
        );

        const rawProtection = context.globalArgs.protectionTagSubstrings;
        const protectionArray: string[] = Array.isArray(rawProtection)
          ? rawProtection
          : typeof rawProtection === "string" &&
              rawProtection.trim().startsWith("[")
          ? JSON.parse(rawProtection)
          : ["keep", "keep-forever", "do-not-delete"];
        const protectionSubs: string[] = protectionArray.map((s: string) =>
          s.toLowerCase()
        );

        const scannedAt = new Date().toISOString();
        const nowMs = Date.now();

        // Seerr lookup: tmdbId -> request
        const seerrByTmdb = new Map<
          number,
          z.infer<typeof SeerrRequestSchema>
        >();
        for (const r of seerrReqs.requests) {
          if (r.mediaType === "movie" && typeof r.tmdbId === "number") {
            seerrByTmdb.set(r.tmdbId, r);
          }
        }

        // Tautulli lookup: normalized title+year -> movie stat
        const watchByKey = new Map<
          string,
          z.infer<typeof TautulliMovieSchema>
        >();
        for (const m of tautulli.movies) {
          const key = `${normalizeTitle(m.title)}|${m.year ?? ""}`;
          const existing = watchByKey.get(key);
          if (!existing || existing.playCount < m.playCount) {
            watchByKey.set(key, m);
          }
        }

        // Collection sibling count across both Radarrs (only movies we actually have files for)
        const collectionCounts = new Map<string, number>();
        const allMovies = [...radarrDefault.movies, ...radarr4k.movies].filter((
          m,
        ) => m.hasFile);
        for (const m of allMovies) {
          if (!m.collectionTitle) continue;
          collectionCounts.set(
            m.collectionTitle,
            (collectionCounts.get(m.collectionTitle) ?? 0) + 1,
          );
        }

        // Franchise-prefix sibling counts (fills TMDb's gaps)
        const franchiseCounts = new Map<string, number>();
        for (const prefix of franchisePrefixes) {
          let count = 0;
          for (const m of allMovies) {
            if (normalizeTitle(m.title).includes(prefix)) count++;
          }
          franchiseCounts.set(prefix, count);
        }
        function franchiseMatch(
          title: string,
        ): { prefix: string; count: number } | null {
          const norm = normalizeTitle(title);
          let best: { prefix: string; count: number } | null = null;
          for (const prefix of franchisePrefixes) {
            if (!norm.includes(prefix)) continue;
            const count = franchiseCounts.get(prefix) ?? 0;
            if (!best || count > best.count) best = { prefix, count };
          }
          return best;
        }

        const scored: z.infer<typeof ScoredMovieSchema>[] = [];

        function scoreOne(
          m: z.infer<typeof RadarrMovieSchema>,
          instanceLabel: string,
        ): z.infer<typeof ScoredMovieSchema> | null {
          if (!m.hasFile) return null;
          const breakdown = {
            provenance: 0,
            watchHistory: 0,
            reviews: 0,
            collection: 0,
            recency: 0,
            monitored: 0,
            audioLanguage: 0,
            protectionTag: 0,
          };
          const reasons: string[] = [];

          // Protection tag — explicit user opt-out, applied as a huge bonus so it
          // dominates any other signal. Defense in depth pairs with the cleaner's hard refuse.
          const matchedTag = (m.tagNames ?? []).find((t) =>
            protectionSubs.some((sub) => t.toLowerCase().includes(sub))
          );
          if (matchedTag) {
            breakdown.protectionTag = 200;
            reasons.push(`+200 protected by Radarr tag "${matchedTag}"`);
          }

          // Provenance
          const seerrReq = typeof m.tmdbId === "number"
            ? seerrByTmdb.get(m.tmdbId)
            : undefined;
          if (seerrReq) {
            const v = seerrReq.isAutoRequest
              ? thresholds.autoSeerrBonus
              : thresholds.manualSeerrBonus;
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
          const tKey = `${normalizeTitle(m.title)}|${m.year ?? ""}`;
          const w = watchByKey.get(tKey);
          const playCount = w?.playCount ?? 0;
          if (playCount > 0) {
            const v = Math.min(
              thresholds.watchMaxBonus,
              playCount * thresholds.watchPerPlayBonus,
            );
            breakdown.watchHistory = v;
            reasons.push(`+${v} watched ${playCount}× in Plex`);
          }

          // Reviews
          const best = bestReview(
            m.ratings,
            thresholds.minReviewVotesPerSource,
          );
          if (typeof best === "number") {
            if (best >= thresholds.highReviewThreshold) {
              breakdown.reviews = thresholds.highReviewBonus;
              reasons.push(
                `+${thresholds.highReviewBonus} strong reviews (best score ${
                  best.toFixed(0)
                })`,
              );
            } else if (best <= thresholds.lowReviewThreshold) {
              breakdown.reviews = thresholds.lowReviewPenalty;
              reasons.push(
                `${thresholds.lowReviewPenalty} weak reviews (best score ${
                  best.toFixed(0)
                })`,
              );
            }
          }

          // Collection completeness — protect curated franchises.
          // Use the LARGER of TMDb collection siblings and franchise-prefix siblings.
          const tmdbCount = m.collectionTitle
            ? (collectionCounts.get(m.collectionTitle) ?? 0)
            : 0;
          const fMatch = franchiseMatch(m.title);
          let siblingCount = tmdbCount;
          let collectionLabel = m.collectionTitle ?? "";
          if (fMatch && fMatch.count > siblingCount) {
            siblingCount = fMatch.count;
            collectionLabel = `franchise:${fMatch.prefix}`;
          }
          if (siblingCount >= thresholds.largeCollectionSiblings) {
            breakdown.collection = thresholds.largeCollectionBonus;
            reasons.push(
              `+${thresholds.largeCollectionBonus} large collection "${collectionLabel}" (${siblingCount} entries)`,
            );
          } else if (siblingCount >= thresholds.mediumCollectionSiblings) {
            breakdown.collection = thresholds.mediumCollectionBonus;
            reasons.push(
              `+${thresholds.mediumCollectionBonus} partial collection "${collectionLabel}" (${siblingCount} entries)`,
            );
          } else if (siblingCount === 2) {
            breakdown.collection = thresholds.smallCollectionBonus;
            reasons.push(
              `+${thresholds.smallCollectionBonus} pair-of-two collection "${collectionLabel}"`,
            );
          }

          // Tenure — for movies, surviving on disk is a positive signal regardless of watch.
          // (Watch is rewarded separately above.)
          const ageDays = dayDiff(m.added, nowMs);
          if (typeof ageDays === "number") {
            if (ageDays < 30) {
              breakdown.recency = thresholds.recencyNewBonus;
              reasons.push(
                `+${thresholds.recencyNewBonus} added recently (${ageDays}d ago)`,
              );
            } else if (ageDays > thresholds.tenureHardDays) {
              breakdown.recency = thresholds.tenureHardBonus;
              reasons.push(
                `+${thresholds.tenureHardBonus} long-tenured library piece (${ageDays}d on disk)`,
              );
            } else if (ageDays > thresholds.tenureSoftDays) {
              breakdown.recency = thresholds.tenureSoftBonus;
              reasons.push(
                `+${thresholds.tenureSoftBonus} kept in library for ${ageDays}d`,
              );
            }
          }

          // Monitored flag — most Radarr configs auto-unmonitor after grab, so
          // it's noise rather than signal. Leave it for transparency but weight = 0.
          breakdown.monitored = 0;

          // Audio language — penalize movies whose file has no track in the preferred language.
          // 'und'/'unknown' tracks are treated as unknown, NOT as foreign. A file of only 'und'
          // is no signal at all.
          const audio = m.audioLanguages;
          if (audio && audio.trim().length > 0) {
            const tracks = audio.toLowerCase().split("/").map((t) => t.trim())
              .filter(Boolean);
            const known = tracks.filter((t) => t !== "und" && t !== "unknown");
            const wantSet = new Set(
              (thresholds.preferredAudioLanguages as string[]).map((s) =>
                s.toLowerCase()
              ),
            );
            const hasPreferred = known.some((t) => wantSet.has(t));
            if (known.length > 0 && !hasPreferred) {
              breakdown.audioLanguage = thresholds.nonPreferredAudioPenalty;
              const wantList = Array.from(wantSet).join("/");
              reasons.push(
                `${thresholds.nonPreferredAudioPenalty} no ${wantList} audio track (file has: ${audio})`,
              );
            }
          }

          const score = breakdown.provenance + breakdown.watchHistory +
            breakdown.reviews +
            breakdown.collection + breakdown.recency + breakdown.monitored +
            breakdown.audioLanguage + breakdown.protectionTag;

          return {
            instanceLabel,
            radarrId: m.id,
            tmdbId: m.tmdbId,
            imdbId: m.imdbId,
            fileImdbId: m.fileImdbId,
            title: m.title,
            year: m.year,
            path: m.path,
            sizeOnDisk: m.sizeOnDisk,
            added: m.added,
            monitored: m.monitored,
            playCount,
            lastPlayedUnix: w?.lastPlayedUnix,
            inSeerr: !!seerrReq,
            seerrRequestedBy: seerrReq?.requestedByUsername,
            bestReviewScore: best,
            collectionTitle: m.collectionTitle,
            collectionSiblingCount: siblingCount,
            tagNames: m.tagNames,
            score,
            breakdown,
            reasons,
          };
        }

        for (const m of radarrDefault.movies) {
          const s = scoreOne(m, radarrDefault.instanceLabel);
          if (s) scored.push(s);
        }
        for (const m of radarr4k.movies) {
          const s = scoreOne(m, radarr4k.instanceLabel);
          if (s) scored.push(s);
        }

        // Sort scores by score asc, then size desc (most droppable, biggest first)
        scored.sort((a, b) => {
          if (a.score !== b.score) return a.score - b.score;
          return b.sizeOnDisk - a.sizeOnDisk;
        });

        // Natural score = score without the protection-tag bonus. Used to identify "would be dropped
        // if the keep-forever tag weren't there."
        function natural(s: typeof scored[0]): number {
          return s.score - (s.breakdown?.protectionTag ?? 0);
        }
        const wouldDrop = scored.filter((s) =>
          natural(s) <= thresholds.dropCandidateMaxScore
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

        const inSeerrCount = scored.filter((s) => s.inSeerr).length;
        const watchedCount = scored.filter((s) => s.playCount > 0).length;
        const unmonitoredCount =
          scored.filter((s) => s.monitored === false).length;
        const high = scored.filter((s) => s.score >= 50).length;
        const mid = scored.filter((s) => s.score >= 0 && s.score < 50).length;
        const low = scored.filter((s) => s.score < 0 && s.score > -20).length;
        const veryLow = scored.filter((s) => s.score <= -20).length;

        const scoresRes = {
          scannedAt,
          totalMoviesScored: scored.length,
          movies: scored,
        };
        const dropRes = {
          scannedAt,
          threshold: thresholds.dropCandidateMaxScore,
          count: candidates.length,
          totalReclaimBytes: reclaimBytes,
          candidates,
        };
        const protectedRes = {
          scannedAt,
          threshold: thresholds.dropCandidateMaxScore,
          count: protectedDrops.length,
          totalShieldedBytes: protectedBytes,
          protected: protectedDrops,
        };
        const summaryRes = {
          scannedAt,
          totalScored: scored.length,
          inSeerrCount,
          watchedCount,
          neverWatchedCount: scored.length - watchedCount,
          unmonitoredCount,
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
