/**
 * `@lint/tautulli` — swamp model wrapper.
 *
 * TODO: hand-edit this header with method summary, auth model, and links.
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
  baseUrl: z.string().describe("Tautulli base URL, e.g. http://192.168.4.50:8181"),
  apiKey: z.string().describe("Tautulli API key (Settings → Web Interface → API)"),
  movieSectionIds: z.array(z.number()).optional()
    .describe("Plex section IDs to include (movies only). Omit to auto-detect all section_type=movie."),
  showSectionIds: z.array(z.number()).optional()
    .describe("Plex section IDs to include (shows only). Omit to auto-detect all section_type=show."),
});

const MovieStatSchema = z.object({
  sectionId: z.number(),
  ratingKey: z.string(),
  title: z.string(),
  year: z.number().optional(),
  playCount: z.number(),
  lastPlayedUnix: z.number().optional(),
  fileSize: z.number().optional(),
});

const ShowStatSchema = z.object({
  sectionId: z.number(),
  ratingKey: z.string(),
  title: z.string(),
  year: z.number().optional(),
  playCount: z.number().describe("Aggregated play count across all episodes of the series"),
  lastPlayedUnix: z.number().optional(),
});

const HistorySchema = z.object({
  totalItems: z.number(),
  withAnyPlay: z.number(),
  withZeroPlays: z.number(),
  movies: z.array(MovieStatSchema),
  fetchedAt: z.iso.datetime(),
});

const ShowHistorySchema = z.object({
  totalItems: z.number(),
  withAnyPlay: z.number(),
  withZeroPlays: z.number(),
  shows: z.array(ShowStatSchema),
  fetchedAt: z.iso.datetime(),
});

const SummarySchema = z.object({
  totalMovies: z.number(),
  watchedAtLeastOnce: z.number(),
  neverWatched: z.number(),
  totalPlays: z.number(),
  sections: z.array(z.object({
    sectionId: z.number(),
    sectionName: z.string(),
    count: z.number(),
  })),
  fetchedAt: z.iso.datetime(),
});

async function tautulliCall(
  baseUrl: string,
  apiKey: string,
  cmd: string,
  extra: Record<string, string> = {},
// deno-lint-ignore no-explicit-any
): Promise<any> {
  const params = new URLSearchParams({ apikey: apiKey, cmd, ...extra });
  const url = `${baseUrl.replace(/\/$/, "")}/api/v2?${params.toString()}`;
  const args = ["-sS", "-w", "\n__HTTP_STATUS__:%{http_code}", url];
  const command = new Deno.Command("curl", { args, stdout: "piped", stderr: "piped" });
  const { code, stdout, stderr } = await command.output();
  if (code !== 0) {
    throw new Error(`curl exit ${code}: ${new TextDecoder().decode(stderr)}`);
  }
  const raw = new TextDecoder().decode(stdout);
  const m = raw.match(/\n__HTTP_STATUS__:(\d+)$/);
  const status = m ? parseInt(m[1], 10) : 0;
  const body = m ? raw.slice(0, m.index) : raw;
  if (status < 200 || status >= 300) {
    throw new Error(`Tautulli ${cmd} -> HTTP ${status}: ${body.slice(0, 400)}`);
  }
  const parsed = JSON.parse(body);
  if (parsed.response?.result !== "success") {
    throw new Error(`Tautulli ${cmd} reported failure: ${JSON.stringify(parsed.response).slice(0, 400)}`);
  }
  return parsed.response.data;
}

/** Swamp model definition for `@lint/tautulli`. */
export const model: {
  type: string;
  version: string;
  reports: string[];
  resources: Record<string, unknown>;
  globalArguments: unknown;
  methods: Record<string, unknown>;
} = {
  type: "@lint/tautulli",
  version: "2026.05.21.1",
  reports: [] as string[],
  globalArguments: GlobalArgsSchema,
  resources: {
    "history": {
      description: "Per-movie watch history (play_count, last_played) for selected sections",
      schema: HistorySchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    "show_history": {
      description: "Per-series aggregated watch history for selected show sections",
      schema: ShowHistorySchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    "summary": {
      description: "Top-line watch counts",
      schema: SummarySchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
  },
  methods: {
    sync: {
      description: "Fetch per-movie play_count + last_played from Tautulli for movie sections",
      arguments: z.object({}),
      execute: async (_args: ExecuteArgs, context: ExecuteContext) => {
        const { baseUrl, apiKey, movieSectionIds } = context.globalArgs;
        const fetchedAt = new Date().toISOString();

        const libs = await tautulliCall(baseUrl, apiKey, "get_libraries");
        // deno-lint-ignore no-explicit-any
        const allMovieSections = (libs as any[])
          .filter((l) => l.section_type === "movie")
          .map((l) => ({
            sectionId: Number(l.section_id),
            sectionName: l.section_name as string,
            count: Number(l.count ?? 0),
          }));
        const wanted: number[] = (movieSectionIds && movieSectionIds.length > 0)
          ? movieSectionIds
          : allMovieSections.map((s) => s.sectionId);
        const sectionsUsed = allMovieSections.filter((s) => wanted.includes(s.sectionId));

        const movies: z.infer<typeof MovieStatSchema>[] = [];
        for (const sec of sectionsUsed) {
          // pull in batches of 1000
          const batchSize = 1000;
          let start = 0;
          while (true) {
            const data = await tautulliCall(baseUrl, apiKey, "get_library_media_info", {
              section_id: String(sec.sectionId),
              length: String(batchSize),
              start: String(start),
              order_column: "title",
              order_dir: "asc",
            });
            // deno-lint-ignore no-explicit-any
            const rows: any[] = data.data ?? [];
            for (const r of rows) {
              movies.push({
                sectionId: sec.sectionId,
                ratingKey: String(r.rating_key),
                title: r.title,
                year: r.year ? Number(r.year) : undefined,
                playCount: Number(r.play_count ?? 0),
                lastPlayedUnix: r.last_played ? Number(r.last_played) : undefined,
                fileSize: r.file_size ? Number(r.file_size) : undefined,
              });
            }
            if (rows.length < batchSize) break;
            start += batchSize;
          }
        }

        const totalPlays = movies.reduce((a, m) => a + m.playCount, 0);
        const watchedOnce = movies.filter((m) => m.playCount > 0).length;
        const neverWatched = movies.length - watchedOnce;

        const history = {
          totalItems: movies.length,
          withAnyPlay: watchedOnce,
          withZeroPlays: neverWatched,
          movies,
          fetchedAt,
        };
        const summary = {
          totalMovies: movies.length,
          watchedAtLeastOnce: watchedOnce,
          neverWatched,
          totalPlays,
          sections: sectionsUsed,
          fetchedAt,
        };

        const h1 = await context.writeResource("history", "history", history);
        const h2 = await context.writeResource("summary", "summary", summary);
        return { dataHandles: [h1, h2] };
      },
    },
    syncShows: {
      description: "Fetch per-series play counts from Tautulli for show sections",
      arguments: z.object({}),
      execute: async (_args: ExecuteArgs, context: ExecuteContext) => {
        const { baseUrl, apiKey, showSectionIds } = context.globalArgs;
        const fetchedAt = new Date().toISOString();

        const libs = await tautulliCall(baseUrl, apiKey, "get_libraries");
        // deno-lint-ignore no-explicit-any
        const allShowSections = (libs as any[])
          .filter((l) => l.section_type === "show")
          .map((l) => ({
            sectionId: Number(l.section_id),
            sectionName: l.section_name as string,
            count: Number(l.count ?? 0),
          }));
        const wanted: number[] = (showSectionIds && showSectionIds.length > 0)
          ? showSectionIds
          : allShowSections.map((s) => s.sectionId);
        const sectionsUsed = allShowSections.filter((s) => wanted.includes(s.sectionId));

        const shows: z.infer<typeof ShowStatSchema>[] = [];
        for (const sec of sectionsUsed) {
          const batchSize = 1000;
          let start = 0;
          while (true) {
            const data = await tautulliCall(baseUrl, apiKey, "get_library_media_info", {
              section_id: String(sec.sectionId),
              length: String(batchSize),
              start: String(start),
              order_column: "title",
              order_dir: "asc",
            });
            // deno-lint-ignore no-explicit-any
            const rows: any[] = data.data ?? [];
            for (const r of rows) {
              shows.push({
                sectionId: sec.sectionId,
                ratingKey: String(r.rating_key),
                title: r.title,
                year: r.year ? Number(r.year) : undefined,
                playCount: Number(r.play_count ?? 0),
                lastPlayedUnix: r.last_played ? Number(r.last_played) : undefined,
              });
            }
            if (rows.length < batchSize) break;
            start += batchSize;
          }
        }

        const watchedOnce = shows.filter((s) => s.playCount > 0).length;
        const history = {
          totalItems: shows.length,
          withAnyPlay: watchedOnce,
          withZeroPlays: shows.length - watchedOnce,
          shows,
          fetchedAt,
        };

        const handle = await context.writeResource("show_history", "show_history", history);
        return { dataHandles: [handle] };
      },
    },
  },
};
