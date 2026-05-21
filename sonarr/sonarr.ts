/**
 * `@lint/sonarr` — swamp model wrapper.
 *
 * One `sync` method snapshots a Sonarr v3 instance via /api/v3/series,
 * joins it with /api/v3/rootfolder + /api/v3/tag, and writes two resources:
 *
 *   - `inventory` — every series with flat statistics (sizeOnDisk,
 *     episodeCount, episodeFileCount, percentOfEpisodes), status,
 *     network/genres, tag names (resolved from tag IDs).
 *   - `summary`   — counts by status (ended/continuing/upcoming), total
 *     episode files, root folder free-space — cheap to read for dashboards.
 *
 * Auth: standard Sonarr X-Api-Key header (Settings → General → Security →
 * API Key). Transport: curl via Deno.Command so any failing call can be
 * replayed as a one-liner.
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
    "Sonarr base URL, e.g. http://192.168.4.50:8989",
  ),
  apiKey: z.string().describe(
    "Sonarr API key (Settings → General → Security → API Key)",
  ),
  instanceLabel: z.string().default("sonarr").describe(
    "Human label for this Sonarr instance",
  ),
});

const SeriesSchema = z.object({
  id: z.number(),
  tvdbId: z.number().optional(),
  imdbId: z.string().optional(),
  tmdbId: z.number().optional(),
  title: z.string(),
  titleSlug: z.string().optional(),
  year: z.number().optional(),
  folderName: z.string().describe("basename of the series path"),
  path: z.string(),
  sizeOnDisk: z.number(),
  episodeCount: z.number(),
  episodeFileCount: z.number(),
  percentOfEpisodes: z.number().describe(
    "0–100% of monitored episodes present on disk",
  ),
  status: z.enum(["ended", "continuing", "upcoming", "deleted"]).optional(),
  monitored: z.boolean().optional(),
  added: z.string().optional(),
  network: z.string().optional(),
  runtime: z.number().optional(),
  certification: z.string().optional(),
  genres: z.array(z.string()).optional(),
  rating: z.number().optional().describe(
    "0–10 single rating from Sonarr (TMDb-derived)",
  ),
  ratingVotes: z.number().optional(),
  tagIds: z.array(z.number()).optional(),
  tagNames: z.array(z.string()).optional().describe(
    "Resolved tag labels for tagIds",
  ),
});

const InventorySchema = z.object({
  instanceLabel: z.string(),
  baseUrl: z.string(),
  seriesCount: z.number(),
  totalSizeBytes: z.number(),
  series: z.array(SeriesSchema),
  fetchedAt: z.iso.datetime(),
});

const SummarySchema = z.object({
  instanceLabel: z.string(),
  baseUrl: z.string(),
  seriesCount: z.number(),
  endedCount: z.number(),
  continuingCount: z.number(),
  upcomingCount: z.number(),
  totalEpisodeFiles: z.number(),
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
  seriesId: z.number(),
  deleteFiles: z.boolean(),
  addImportListExclusion: z.boolean(),
  httpStatus: z.number(),
  ok: z.boolean(),
  body: z.string().describe("Response body (truncated to 400 chars)"),
  deletedAt: z.iso.datetime(),
});

async function sonarrGet(
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
 * DELETE /api/v3/series/{id} via curl. Returns a non-throwing result so the
 * caller can record HTTP failures in a `delete_result` resource instead of
 * crashing a batch of deletes on the first 404.
 */
async function sonarrDelete(
  baseUrl: string,
  apiKey: string,
  seriesId: number,
  opts: { deleteFiles: boolean; addImportListExclusion: boolean },
): Promise<{ ok: boolean; status: number; body: string }> {
  const qs = `?deleteFiles=${opts.deleteFiles}` +
    `&addImportListExclusion=${opts.addImportListExclusion}`;
  const url = `${baseUrl.replace(/\/$/, "")}/api/v3/series/${seriesId}${qs}`;
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

/** Swamp model definition for `@lint/sonarr`. */
export const model: {
  type: string;
  version: string;
  reports: string[];
  resources: Record<string, unknown>;
  globalArguments: unknown;
  methods: Record<string, unknown>;
} = {
  type: "@lint/sonarr",
  version: "2026.05.21.2",
  reports: [] as string[],
  globalArguments: GlobalArgsSchema,
  resources: {
    "inventory": {
      description: "Full series inventory snapshot from this Sonarr instance",
      schema: InventorySchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    "summary": {
      description: "Compact instance summary (counts by status + root folders)",
      schema: SummarySchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    "delete_result": {
      description:
        "Outcome of the most recent delete call (seriesId, flags, HTTP status, response body)",
      schema: DeleteResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  methods: {
    sync: {
      description:
        "Fetch all series, root folders, and tags from Sonarr; write inventory + summary",
      arguments: z.object({}),
      execute: async (_args: ExecuteArgs, context: ExecuteContext) => {
        const { baseUrl, apiKey, instanceLabel } = context.globalArgs;
        const fetchedAt = new Date().toISOString();

        const seriesRaw = await sonarrGet(
          baseUrl,
          apiKey,
          "/api/v3/series",
        ) as unknown[];
        const tagsRaw = await sonarrGet(
          baseUrl,
          apiKey,
          "/api/v3/tag",
        ) as unknown[];
        const rootRaw = await sonarrGet(
          baseUrl,
          apiKey,
          "/api/v3/rootfolder",
        ) as unknown[];

        const tagMap = new Map<number, string>();
        // deno-lint-ignore no-explicit-any
        for (const t of (tagsRaw as any[])) {
          if (typeof t?.id === "number" && typeof t?.label === "string") {
            tagMap.set(t.id, t.label);
          }
        }

        // deno-lint-ignore no-explicit-any
        const series = (seriesRaw as any[]).map((s: any) => {
          const p: string = s.path ?? "";
          const basename = p.includes("/")
            ? p.slice(p.lastIndexOf("/") + 1)
            : p;
          return {
            id: s.id,
            tvdbId: s.tvdbId,
            imdbId: s.imdbId,
            tmdbId: s.tmdbId,
            title: s.title,
            titleSlug: s.titleSlug,
            year: s.year,
            folderName: basename,
            path: p,
            sizeOnDisk: s.statistics?.sizeOnDisk ?? 0,
            episodeCount: s.statistics?.episodeCount ?? 0,
            episodeFileCount: s.statistics?.episodeFileCount ?? 0,
            percentOfEpisodes: s.statistics?.percentOfEpisodes ?? 0,
            status: s.status,
            monitored: s.monitored,
            added: s.added,
            network: s.network,
            runtime: s.runtime,
            certification: s.certification,
            genres: s.genres,
            rating: s.ratings?.value,
            ratingVotes: s.ratings?.votes,
            tagIds: s.tags,
            tagNames: Array.isArray(s.tags)
              ? s.tags.map((id: number) => tagMap.get(id)).filter((
                x: string | undefined,
              ): x is string => !!x)
              : [],
          };
        });

        const totalSize = series.reduce(
          (acc, s) => acc + (s.sizeOnDisk ?? 0),
          0,
        );
        const totalFiles = series.reduce(
          (acc, s) => acc + (s.episodeFileCount ?? 0),
          0,
        );
        const endedCount = series.filter((s) => s.status === "ended").length;
        const continuingCount =
          series.filter((s) => s.status === "continuing").length;
        const upcomingCount =
          series.filter((s) => s.status === "upcoming").length;
        // deno-lint-ignore no-explicit-any
        const rootFolders = (rootRaw as any[]).map((r) => ({
          path: r.path,
          freeSpace: typeof r.freeSpace === "number" ? r.freeSpace : undefined,
        }));

        const inventory = {
          instanceLabel,
          baseUrl,
          seriesCount: series.length,
          totalSizeBytes: totalSize,
          series,
          fetchedAt,
        };
        const summary = {
          instanceLabel,
          baseUrl,
          seriesCount: series.length,
          endedCount,
          continuingCount,
          upcomingCount,
          totalEpisodeFiles: totalFiles,
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
        "Delete a series from Sonarr via DELETE /api/v3/series/{id}. By default also removes on-disk files and adds an import-list exclusion so automatic imports do not re-add the series.",
      arguments: z.object({
        id: z.number().describe(
          "Sonarr series ID — the numeric `id` from /api/v3/series, not tvdbId/imdbId/tmdbId",
        ),
        deleteFiles: z.boolean().default(true).describe(
          "Remove the on-disk files. Set false to remove only the catalog entry.",
        ),
        addImportListExclusion: z.boolean().default(true).describe(
          "Add an import-list exclusion so automatic imports won't re-add this series",
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

        const result = await sonarrDelete(baseUrl, apiKey, id, {
          deleteFiles,
          addImportListExclusion,
        });

        const handle = await context.writeResource(
          "delete_result",
          "delete_result",
          {
            instanceLabel,
            baseUrl,
            seriesId: id,
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
