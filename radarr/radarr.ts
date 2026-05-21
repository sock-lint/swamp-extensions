/**
 * `@lint/radarr` — Radarr v3 inventory wrapper for swamp.
 *
 * Single method:
 *
 *   - `sync` — fetch `/api/v3/movie`, `/api/v3/rootfolder`, and `/api/v3/tag`,
 *     join tag IDs to labels, parse the IMDb tt-id from each file's basename,
 *     and emit `inventory` (full per-movie payload) + `summary` (counts +
 *     root-folder free space).
 *
 * Auth is the standard Radarr `X-Api-Key` header. The on-disk `fileImdbId`
 * field is what enables drift detection — when it disagrees with the
 * catalog's `imdbId`, Radarr's metadata no longer matches the bytes on disk
 * and destructive ops should refuse until a human re-matches the entry.
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
  apiKey: z.string().describe("Radarr API key"),
  instanceLabel: z.string().describe("Human label, e.g. '1080p' or '4K'"),
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
    "basename of folder, used for cross-instance dup matching",
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
    "Film's production language, e.g. 'English', 'Korean'",
  ),
  audioLanguages: z.string().optional()
    .describe(
      "Slash-delimited language codes in the file's audio tracks, e.g. 'eng/eng' or 'kor/eng' or 'jpn'",
    ),
  subtitleLanguages: z.string().optional(),
  fileImdbId: z.string().optional()
    .describe(
      "IMDb tt-id parsed from the file path (e.g. tt0084787 from `[imdb-tt0084787]`). Mismatch with `imdbId` flags a Radarr metadata error.",
    ),
  collectionTitle: z.string().optional(),
  collectionTmdbId: z.number().optional(),
  tagIds: z.array(z.number()).optional(),
  tagNames: z.array(z.string()).optional().describe(
    "Resolved tag labels for tagIds",
  ),
  ratings: RatingsSchema.optional(),
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
  rootFolders: z.array(z.object({
    path: z.string(),
    freeSpace: z.number().optional(),
  })),
  fetchedAt: z.iso.datetime(),
});

const DeleteResultSchema = z.object({
  instanceLabel: z.string(),
  baseUrl: z.string(),
  movieId: z.number(),
  deleteFiles: z.boolean(),
  addImportListExclusion: z.boolean(),
  httpStatus: z.number(),
  ok: z.boolean(),
  body: z.string().describe("Response body (truncated to 400 chars)"),
  deletedAt: z.iso.datetime(),
});

async function radarrGet(
  baseUrl: string,
  apiKey: string,
  path: string,
): Promise<unknown> {
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
  const body = m ? raw.slice(0, m.index) : raw;
  if (status < 200 || status >= 300) {
    throw new Error(`GET ${path} -> HTTP ${status}: ${body.slice(0, 400)}`);
  }
  return JSON.parse(body);
}

/**
 * DELETE /api/v3/movie/{id} via curl. Returns a non-throwing result so the
 * caller can record HTTP failures in a `delete_result` resource instead of
 * crashing a batch of deletes on the first 404.
 */
async function radarrDelete(
  baseUrl: string,
  apiKey: string,
  movieId: number,
  opts: { deleteFiles: boolean; addImportListExclusion: boolean },
): Promise<{ ok: boolean; status: number; body: string }> {
  const qs = `?deleteFiles=${opts.deleteFiles}` +
    `&addImportListExclusion=${opts.addImportListExclusion}`;
  const url = `${baseUrl.replace(/\/$/, "")}/api/v3/movie/${movieId}${qs}`;
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
  version: "2026.05.21.2",
  reports: [] as string[],
  globalArguments: GlobalArgsSchema,
  resources: {
    "inventory": {
      description: "Full movie inventory for this Radarr instance",
      schema: InventorySchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    "summary": {
      description:
        "Compact instance summary (counts + root folders) — cheap to read",
      schema: SummarySchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    "delete_result": {
      description:
        "Outcome of the most recent delete call (movieId, flags, HTTP status, response body)",
      schema: DeleteResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  methods: {
    sync: {
      description:
        "Fetch all movies and root folders from Radarr; write inventory + summary",
      arguments: z.object({}),
      execute: async (_args: ExecuteArgs, context: ExecuteContext) => {
        const { baseUrl, apiKey, instanceLabel } = context.globalArgs;
        const fetchedAt = new Date().toISOString();

        const moviesRaw = await radarrGet(
          baseUrl,
          apiKey,
          "/api/v3/movie",
        ) as unknown[];
        const rootRaw = await radarrGet(
          baseUrl,
          apiKey,
          "/api/v3/rootfolder",
        ) as unknown[];
        const tagsRaw = await radarrGet(
          baseUrl,
          apiKey,
          "/api/v3/tag",
        ) as unknown[];
        const tagMap = new Map<number, string>();
        // deno-lint-ignore no-explicit-any
        for (const t of (tagsRaw as any[])) {
          if (typeof t?.id === "number" && typeof t?.label === "string") {
            tagMap.set(t.id, t.label);
          }
        }

        // deno-lint-ignore no-explicit-any
        const movies = moviesRaw.map((m: any) => {
          const fn: string = m.folderName ?? "";
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
            fileImdbId: (() => {
              const cand = [
                m.movieFile?.relativePath,
                m.movieFile?.path,
                m.movieFile?.sceneName,
                m.movieFile?.originalFilePath,
              ].find((s) => typeof s === "string" && /imdb-tt\d+/i.test(s));
              const match = typeof cand === "string"
                ? cand.match(/imdb-(tt\d+)/i)
                : null;
              return match ? match[1] : undefined;
            })(),
            collectionTitle: m.collection?.title,
            collectionTmdbId: m.collection?.tmdbId,
            tagIds: m.tags,
            tagNames: Array.isArray(m.tags)
              ? m.tags.map((id: number) => tagMap.get(id)).filter((
                s: string | undefined,
              ): s is string => !!s)
              : [],
            ratings: {
              imdb: r.imdb
                ? { value: r.imdb.value, votes: r.imdb.votes }
                : undefined,
              tmdb: r.tmdb
                ? { value: r.tmdb.value, votes: r.tmdb.votes }
                : undefined,
              rottenTomatoes: r.rottenTomatoes
                ? {
                  value: r.rottenTomatoes.value,
                  votes: r.rottenTomatoes.votes,
                }
                : undefined,
              metacritic: r.metacritic
                ? { value: r.metacritic.value, votes: r.metacritic.votes }
                : undefined,
              trakt: r.trakt
                ? { value: r.trakt.value, votes: r.trakt.votes }
                : undefined,
            },
          };
        });

        const withFile = movies.filter((m) => m.hasFile);
        const totalSize = withFile.reduce(
          (acc, m) => acc + (m.sizeOnDisk ?? 0),
          0,
        );
        // deno-lint-ignore no-explicit-any
        const rootFolders = (rootRaw as any[]).map((r) => ({
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
    delete: {
      description:
        "Delete a movie from Radarr via DELETE /api/v3/movie/{id}. By default also removes on-disk files and adds an import-list exclusion so automatic imports do not re-grab the movie.",
      arguments: z.object({
        id: z.number().describe(
          "Radarr movie ID — the numeric `id` from /api/v3/movie, not tmdbId/imdbId",
        ),
        deleteFiles: z.boolean().default(true).describe(
          "Remove the on-disk files. Set false to remove only the catalog entry.",
        ),
        addImportListExclusion: z.boolean().default(true).describe(
          "Add an import-list exclusion so automatic imports won't re-add this movie",
        ),
      }),
      execute: async (args: ExecuteArgs, context: ExecuteContext) => {
        const { baseUrl, apiKey, instanceLabel } = context.globalArgs;
        const { id, deleteFiles, addImportListExclusion } = args as {
          id: number;
          deleteFiles: boolean;
          addImportListExclusion: boolean;
        };
        const deletedAt = new Date().toISOString();

        const result = await radarrDelete(baseUrl, apiKey, id, {
          deleteFiles,
          addImportListExclusion,
        });

        const handle = await context.writeResource(
          "delete_result",
          "delete_result",
          {
            instanceLabel,
            baseUrl,
            movieId: id,
            deleteFiles,
            addImportListExclusion,
            httpStatus: result.status,
            ok: result.ok,
            body: result.body.slice(0, 400),
            deletedAt,
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
