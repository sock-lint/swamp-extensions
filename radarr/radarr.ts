/**
 * `@lint/radarr` — Radarr v3 inventory wrapper for swamp.
 *
 * One `sync` method snapshots a Radarr instance via `/api/v3/movie`, joins it
 * with `/api/v3/rootfolder` (for free-space) and `/api/v3/tag` (so tag IDs come
 * back as labels), and writes two resources:
 *
 *   - `inventory` — every movie with the fields you actually use:
 *     IDs (tmdb, imdb, plus `fileImdbId` parsed from the on-disk path),
 *     size, ratings, tag names, original/audio languages, collection info.
 *   - `summary`   — counts + root folders, cheap to read for dashboards.
 *
 * Auth is the standard Radarr `X-Api-Key` header (Settings → General →
 * Security → API Key). Transport is `curl` via `Deno.Command`, so any
 * failing call can be reproduced as a one-liner with the same baseUrl
 * and apiKey.
 *
 * The model is built to be the data source for downstream curator/cleaner
 * workflows: resources carry the metadata needed to detect Radarr drift
 * (`fileImdbId` vs `imdbId`) and respect tag-based protection (`tagNames`)
 * without anyone having to re-fetch from the API.
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
    "Radarr base URL, e.g. http://192.168.4.50:7878",
  ),
  apiKey: z.string().describe(
    "Radarr X-Api-Key (Settings → General → Security → API Key)",
  ),
  instanceLabel: z.string().describe(
    "Human label for this Radarr instance, e.g. '1080p' or '4K'",
  ),
});

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

const MovieSchema = z.object({
  id: z.number(),
  tmdbId: z.number().optional(),
  imdbId: z.string().optional(),
  title: z.string(),
  year: z.number().optional(),
  folderName: z.string().describe(
    "Basename of the folder; useful for cross-instance dup matching",
  ),
  path: z.string().describe("Radarr-reported full path (container view)"),
  sizeOnDisk: z.number(),
  hasFile: z.boolean(),
  monitored: z.boolean().optional(),
  qualityProfileId: z.number().optional(),
  added: z.string().optional().describe(
    "ISO timestamp Radarr first added the movie",
  ),
  popularity: z.number().optional(),
  runtime: z.number().optional(),
  certification: z.string().optional(),
  genres: z.array(z.string()).optional(),
  studio: z.string().optional(),
  originalLanguage: z.string().optional().describe(
    "Production language, e.g. 'English', 'Korean'",
  ),
  audioLanguages: z.string().optional().describe(
    "Slash-delimited language codes from the file's audio tracks, e.g. 'eng/eng'",
  ),
  subtitleLanguages: z.string().optional(),
  fileImdbId: z.string().optional().describe(
    "IMDb tt-id parsed from the file path (e.g. 'tt0084787' from '[imdb-tt0084787]'). " +
      "Mismatch with `imdbId` flags a Radarr metadata error — the catalog entry points at " +
      "a different movie than the bytes on disk.",
  ),
  collectionTitle: z.string().optional(),
  collectionTmdbId: z.number().optional(),
  tagIds: z.array(z.number()).optional(),
  tagNames: z.array(z.string()).optional().describe(
    "Resolved tag labels for tagIds, joined from /api/v3/tag",
  ),
  ratings: RatingsSchema.optional(),
});

const RootFolderSchema = z.object({
  path: z.string(),
  freeSpace: z.number().optional(),
});

const InventorySchema = z.object({
  instanceLabel: z.string(),
  baseUrl: z.string(),
  movieCount: z.number(),
  withFileCount: z.number(),
  totalSizeBytes: z.number(),
  movies: z.array(MovieSchema),
  fetchedAt: z.iso.datetime(),
});

const SummarySchema = z.object({
  instanceLabel: z.string(),
  baseUrl: z.string(),
  movieCount: z.number(),
  withFileCount: z.number(),
  missingFileCount: z.number(),
  totalSizeBytes: z.number(),
  rootFolders: z.array(RootFolderSchema),
  fetchedAt: z.iso.datetime(),
});

interface RadarrTag {
  id?: number;
  label?: string;
}

interface RadarrRatingSource {
  value?: number;
  votes?: number;
}

interface RadarrRatings {
  imdb?: RadarrRatingSource;
  tmdb?: RadarrRatingSource;
  rottenTomatoes?: RadarrRatingSource;
  metacritic?: RadarrRatingSource;
  trakt?: RadarrRatingSource;
}

interface RadarrMovieFile {
  relativePath?: string;
  path?: string;
  sceneName?: string;
  originalFilePath?: string;
  mediaInfo?: {
    audioLanguages?: string;
    subtitles?: string;
  };
}

interface RadarrCollection {
  title?: string;
  tmdbId?: number;
}

interface RadarrLanguage {
  name?: string;
}

interface RadarrMovie {
  id: number;
  tmdbId?: number;
  imdbId?: string;
  title: string;
  year?: number;
  folderName?: string;
  path?: string;
  sizeOnDisk?: number;
  hasFile?: boolean;
  monitored?: boolean;
  qualityProfileId?: number;
  added?: string;
  popularity?: number;
  runtime?: number;
  certification?: string;
  genres?: string[];
  studio?: string;
  originalLanguage?: RadarrLanguage;
  movieFile?: RadarrMovieFile;
  collection?: RadarrCollection;
  tags?: number[];
  ratings?: RadarrRatings;
}

interface RadarrRootFolder {
  path: string;
  freeSpace?: number;
}

/**
 * Issue a Radarr GET via curl with the X-Api-Key header. Returns the parsed
 * JSON body as the caller-supplied type. Non-2xx responses throw with the
 * body (truncated to 400 chars) included for diagnosis.
 */
async function radarrGet<T>(
  baseUrl: string,
  apiKey: string,
  path: string,
): Promise<T> {
  const url = `${baseUrl.replace(/\/$/, "")}${path}`;
  const args = [
    "-sS",
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
    throw new Error(`curl exit ${code}: ${new TextDecoder().decode(stderr)}`);
  }
  const raw = new TextDecoder().decode(stdout);
  const m = raw.match(/\n__HTTP_STATUS__:(\d+)$/);
  const status = m ? parseInt(m[1], 10) : 0;
  const body = m && typeof m.index === "number" ? raw.slice(0, m.index) : raw;
  if (status < 200 || status >= 300) {
    throw new Error(`GET ${path} -> HTTP ${status}: ${body.slice(0, 400)}`);
  }
  return JSON.parse(body) as T;
}

/**
 * Extract the IMDb tt-id from a movie file's on-disk path (e.g. `tt0084787`
 * from `Movie Title [imdb-tt0084787].mkv`). Returns undefined when no
 * `imdb-tt#######` token is present anywhere in the candidate fields.
 */
function parseFileImdbId(m: RadarrMovieFile | undefined): string | undefined {
  if (!m) return undefined;
  const cand = [m.relativePath, m.path, m.sceneName, m.originalFilePath].find(
    (s) => typeof s === "string" && /imdb-tt\d+/i.test(s),
  );
  const match = typeof cand === "string" ? cand.match(/imdb-(tt\d+)/i) : null;
  return match ? match[1] : undefined;
}

function mapRating(
  s: RadarrRatingSource | undefined,
): { value: number; votes?: number } | undefined {
  return s && typeof s.value === "number"
    ? { value: s.value, votes: s.votes }
    : undefined;
}

/** Swamp model definition for `@lint/radarr`. */
export const model: {
  type: string;
  version: string;
  reports: string[];
  resources: Record<string, unknown>;
  globalArguments: unknown;
  methods: Record<string, unknown>;
} = {
  type: "@lint/radarr",
  version: "2026.05.21.1",
  reports: [],
  globalArguments: GlobalArgsSchema,
  resources: {
    "inventory": {
      description: "Full movie inventory snapshot from this Radarr instance",
      schema: InventorySchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    "summary": {
      description:
        "Compact instance summary (counts + root folders) — cheap to read",
      schema: SummarySchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
  },
  methods: {
    sync: {
      description:
        "Fetch all movies, root folders, and tags from Radarr; write inventory + summary resources",
      arguments: z.object({}),
      execute: async (_args: ExecuteArgs, context: ExecuteContext) => {
        const { baseUrl, apiKey, instanceLabel } = context.globalArgs;
        const fetchedAt = new Date().toISOString();

        const [moviesRaw, rootRaw, tagsRaw] = await Promise.all([
          radarrGet<RadarrMovie[]>(baseUrl, apiKey, "/api/v3/movie"),
          radarrGet<RadarrRootFolder[]>(baseUrl, apiKey, "/api/v3/rootfolder"),
          radarrGet<RadarrTag[]>(baseUrl, apiKey, "/api/v3/tag"),
        ]);

        const tagMap = new Map<number, string>();
        for (const t of tagsRaw) {
          if (typeof t?.id === "number" && typeof t?.label === "string") {
            tagMap.set(t.id, t.label);
          }
        }

        const movies = moviesRaw.map((m) => {
          const fn = m.folderName ?? "";
          const basename = fn.includes("/")
            ? fn.slice(fn.lastIndexOf("/") + 1)
            : fn;
          const r = m.ratings ?? {};
          return {
            id: m.id,
            tmdbId: m.tmdbId,
            imdbId: m.imdbId,
            title: m.title,
            year: m.year,
            folderName: basename,
            path: m.path ?? m.folderName ?? "",
            sizeOnDisk: m.sizeOnDisk ?? 0,
            hasFile: !!m.hasFile,
            monitored: m.monitored,
            qualityProfileId: m.qualityProfileId,
            added: m.added,
            popularity: m.popularity,
            runtime: m.runtime,
            certification: m.certification,
            genres: m.genres,
            studio: m.studio,
            originalLanguage: m.originalLanguage?.name,
            audioLanguages: m.movieFile?.mediaInfo?.audioLanguages,
            subtitleLanguages: m.movieFile?.mediaInfo?.subtitles,
            fileImdbId: parseFileImdbId(m.movieFile),
            collectionTitle: m.collection?.title,
            collectionTmdbId: m.collection?.tmdbId,
            tagIds: m.tags,
            tagNames: Array.isArray(m.tags)
              ? m.tags
                .map((id) => tagMap.get(id))
                .filter((s): s is string => !!s)
              : [],
            ratings: {
              imdb: mapRating(r.imdb),
              tmdb: mapRating(r.tmdb),
              rottenTomatoes: mapRating(r.rottenTomatoes),
              metacritic: mapRating(r.metacritic),
              trakt: mapRating(r.trakt),
            },
          };
        });

        const withFile = movies.filter((m) => m.hasFile);
        const totalSize = withFile.reduce(
          (acc, m) => acc + (m.sizeOnDisk ?? 0),
          0,
        );
        const rootFolders = rootRaw.map((r) => ({
          path: r.path,
          freeSpace: typeof r.freeSpace === "number" ? r.freeSpace : undefined,
        }));

        const inventory = {
          instanceLabel,
          baseUrl,
          movieCount: movies.length,
          withFileCount: withFile.length,
          totalSizeBytes: totalSize,
          movies,
          fetchedAt,
        };

        const summary = {
          instanceLabel,
          baseUrl,
          movieCount: movies.length,
          withFileCount: withFile.length,
          missingFileCount: movies.length - withFile.length,
          totalSizeBytes: totalSize,
          rootFolders,
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
