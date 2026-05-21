/**
 * `@lint/plex` — Plex Media Server library-refresh helper for swamp.
 *
 * Triggers Plex to rescan one or more library sections via the
 * `/library/sections/{id}/refresh` endpoint. Useful as the tail end of a
 * media-management pipeline — after Radarr/Sonarr removes a file on disk,
 * or after a curator/cleaner job reclaims space, run this model so the
 * Plex catalog stops advertising entries that no longer exist.
 *
 * If `sectionIds` is omitted, the model fetches `/library/sections` and
 * refreshes every section of type `movie` or `show`. Other section types
 * (music, photo) are skipped by default — pass an explicit `sectionIds`
 * list to include them.
 *
 * Auth uses the standard `X-Plex-Token` query parameter. Get a token from
 * the Plex Web app: https://support.plex.tv/articles/204059436
 *
 * Transport is `curl` via `Deno.Command`, so any failing call can be
 * reproduced as a one-liner from a shell with the same baseUrl + token.
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
    "Plex Media Server base URL, e.g. http://192.168.4.61:32400",
  ),
  token: z.string().describe(
    "X-Plex-Token; see https://support.plex.tv/articles/204059436",
  ),
  instanceLabel: z.string().describe(
    "Human label for this Plex server, e.g. 'living-room-plex'",
  ),
  sectionIds: z.any().optional().describe(
    "Optional list of section IDs to refresh. If omitted, refreshes every " +
      "movie/show section returned by /library/sections. Accepts either a " +
      "native array or a JSON-encoded string (useful when wired via CEL): '[1, 3]'.",
  ),
});

const SectionRefreshSchema = z.object({
  sectionId: z.number(),
  httpStatus: z.number(),
  ok: z.boolean(),
});

const RefreshResultSchema = z.object({
  instanceLabel: z.string(),
  baseUrl: z.string(),
  refreshedAt: z.iso.datetime(),
  sectionsRefreshed: z.array(SectionRefreshSchema),
});

/**
 * Issue a request to Plex via curl, appending `X-Plex-Token` to the query
 * string. Returns the HTTP status and response body verbatim — callers
 * decide how to parse / surface errors.
 */
async function plexRequest(
  baseUrl: string,
  token: string,
  path: string,
): Promise<{ status: number; body: string }> {
  const sep = path.includes("?") ? "&" : "?";
  const url = `${baseUrl.replace(/\/$/, "")}${path}${sep}X-Plex-Token=${token}`;
  const args = [
    "-sS",
    "-H",
    "Accept: application/json",
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
  return { status, body };
}

/**
 * Resolve the section-ID list. Accepts a native array, a JSON-encoded
 * string (CEL pass-through), or nothing (auto-discover movie/show sections).
 */
async function resolveSectionIds(
  baseUrl: string,
  token: string,
  raw: unknown,
): Promise<number[]> {
  let configured: number[] = [];
  if (Array.isArray(raw)) {
    configured = raw.map((n) => Number(n)).filter((n) => Number.isFinite(n));
  } else if (typeof raw === "string" && raw.trim().startsWith("[")) {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      configured = parsed.map((n) => Number(n)).filter((n) =>
        Number.isFinite(n)
      );
    }
  }
  if (configured.length > 0) return configured;

  const { status, body } = await plexRequest(
    baseUrl,
    token,
    "/library/sections",
  );
  if (status < 200 || status >= 300) {
    throw new Error(
      `GET /library/sections -> HTTP ${status}: ${body.slice(0, 400)}`,
    );
  }
  const parsed = JSON.parse(body) as {
    MediaContainer?: { Directory?: Array<{ type?: string; key?: string }> };
  };
  const dirs = parsed?.MediaContainer?.Directory ?? [];
  return dirs
    .filter((d) => d.type === "movie" || d.type === "show")
    .map((d) => Number(d.key))
    .filter((n) => Number.isFinite(n));
}

/** Swamp model definition for `@lint/plex`. */
export const model: {
  type: string;
  version: string;
  reports: string[];
  resources: Record<string, unknown>;
  globalArguments: unknown;
  methods: Record<string, unknown>;
} = {
  type: "@lint/plex",
  version: "2026.05.21.1",
  reports: [],
  globalArguments: GlobalArgsSchema,
  resources: {
    "refresh_result": {
      description:
        "Per-section refresh outcomes from the most recent refreshLibraries run",
      schema: RefreshResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    refreshLibraries: {
      description:
        "Trigger Plex to rescan the given library sections (or all movie/show sections if sectionIds is unspecified)",
      arguments: z.object({}),
      execute: async (_args: ExecuteArgs, context: ExecuteContext) => {
        const { baseUrl, token, instanceLabel } = context.globalArgs;
        const refreshedAt = new Date().toISOString();

        const sectionIds = await resolveSectionIds(
          baseUrl,
          token,
          context.globalArgs.sectionIds,
        );

        const sectionsRefreshed: Array<{
          sectionId: number;
          httpStatus: number;
          ok: boolean;
        }> = [];
        for (const id of sectionIds) {
          const { status } = await plexRequest(
            baseUrl,
            token,
            `/library/sections/${id}/refresh`,
          );
          sectionsRefreshed.push({
            sectionId: id,
            httpStatus: status,
            ok: status >= 200 && status < 300,
          });
        }

        const handle = await context.writeResource(
          "refresh_result",
          "refresh_result",
          {
            instanceLabel,
            baseUrl,
            refreshedAt,
            sectionsRefreshed,
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
