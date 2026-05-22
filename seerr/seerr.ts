/**
 * `@lint/seerr` — Overseerr / Jellyseerr request wrapper.
 *
 * Three methods:
 *
 *   - `sync` — page through `/api/v1/request?take=N&skip=N&filter=all` until
 *     the result set ends, flatten each request into `{requestId, mediaId,
 *     mediaType, status, requestedBy, createdAt, ...}`, emit a `requests`
 *     resource (full list) and `summary` (per-status / per-mediaType counts).
 *   - `approveRequest` — `POST /api/v1/request/{id}/approve`. Records the
 *     outcome in `action_result`. Non-throwing on HTTP error.
 *   - `declineRequest` — `POST /api/v1/request/{id}/decline`. Records the
 *     outcome in `action_result`. Non-throwing on HTTP error.
 *
 * Auth is the Overseerr/Jellyseerr API key sent via `X-Api-Key`. Both
 * products share the same REST surface, so this model works against either.
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
  baseUrl: z.string().describe("Seerr base URL, e.g. http://192.168.4.50:5055"),
  apiKey: z.string().describe("Seerr API key (Settings → General → API Key)"),
});

const RequestSchema = z.object({
  id: z.number(),
  mediaType: z.enum(["movie", "tv"]),
  tmdbId: z.number().optional(),
  imdbId: z.string().optional(),
  is4k: z.boolean(),
  isAutoRequest: z.boolean(),
  status: z.number().describe(
    "Seerr request status: 1=pending, 2=approved, 3=declined, etc.",
  ),
  mediaStatus: z.number().describe(
    "Underlying media status: 5=available, 3=processing, etc.",
  ),
  createdAt: z.iso.datetime(),
  requestedByUserId: z.number().optional(),
  requestedByUsername: z.string().optional(),
});

const RequestsSchema = z.object({
  totalRequests: z.number(),
  requests: z.array(RequestSchema),
  fetchedAt: z.iso.datetime(),
});

const SummarySchema = z.object({
  totalRequests: z.number(),
  movieRequests: z.number(),
  tvRequests: z.number(),
  autoRequests: z.number(),
  manualRequests: z.number(),
  distinctMovieTmdbIds: z.number(),
  fetchedAt: z.iso.datetime(),
});

const ActionResultSchema = z.object({
  baseUrl: z.string(),
  requestId: z.number(),
  action: z.enum(["approve", "decline"]),
  httpStatus: z.number(),
  ok: z.boolean(),
  body: z.string().describe("Response body (truncated to 400 chars)"),
  performedAt: z.iso.datetime(),
});

async function seerrGet(
  baseUrl: string,
  apiKey: string,
  path: string,
  // deno-lint-ignore no-explicit-any
): Promise<any> {
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
 * Non-throwing twin of `seerrGet` for POST/DELETE actions. Returns
 * `{ ok, status, body }` so the caller can record outcomes in a resource
 * instead of crashing a batch on a single failure (e.g. a 404 for an
 * already-resolved request).
 */
async function seerrCall(
  baseUrl: string,
  apiKey: string,
  method: string,
  path: string,
): Promise<{ ok: boolean; status: number; body: string }> {
  const url = `${baseUrl.replace(/\/$/, "")}${path}`;
  const args = [
    "-sS",
    "-X",
    method,
    "-H",
    `X-Api-Key: ${apiKey}`,
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

/** Swamp model definition for `@lint/seerr`. */
export const model: {
  type: string;
  version: string;
  reports: string[];
  resources: Record<string, unknown>;
  globalArguments: unknown;
  methods: Record<string, unknown>;
} = {
  type: "@lint/seerr",
  version: "2026.05.21.3",
  reports: [] as string[],
  globalArguments: GlobalArgsSchema,
  resources: {
    "requests": {
      description:
        "All requests known to Seerr — provenance source for the curator",
      schema: RequestsSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    "summary": {
      description: "Top-line request counts",
      schema: SummarySchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    "action_result": {
      description:
        "Outcome of the most recent approveRequest / declineRequest call: requestId, action, HTTP status, response body",
      schema: ActionResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  methods: {
    sync: {
      description:
        "Page through all Seerr requests and write a flattened inventory",
      arguments: z.object({}),
      execute: async (_args: ExecuteArgs, context: ExecuteContext) => {
        const { baseUrl, apiKey } = context.globalArgs;
        const fetchedAt = new Date().toISOString();
        const pageSize = 50;
        const requests: z.infer<typeof RequestSchema>[] = [];
        let page = 1;
        let totalPages = 1;

        while (page <= totalPages) {
          const skip = (page - 1) * pageSize;
          const body = await seerrGet(
            baseUrl,
            apiKey,
            `/api/v1/request?take=${pageSize}&skip=${skip}&filter=all`,
          );
          if (page === 1) {
            totalPages = body.pageInfo?.pages ?? 1;
          }
          for (const r of body.results ?? []) {
            const media = r.media ?? {};
            requests.push({
              id: r.id,
              mediaType: media.mediaType ?? r.type ?? "movie",
              tmdbId: media.tmdbId,
              imdbId: media.imdbId,
              is4k: !!r.is4k,
              isAutoRequest: !!r.isAutoRequest,
              status: r.status,
              mediaStatus: media.status,
              createdAt: r.createdAt,
              requestedByUserId: r.requestedBy?.id,
              requestedByUsername: r.requestedBy?.plexUsername ??
                r.requestedBy?.jellyfinUsername ??
                r.requestedBy?.displayName ?? r.requestedBy?.username,
            });
          }
          page += 1;
        }

        const movies = requests.filter((r) => r.mediaType === "movie");
        const tv = requests.filter((r) => r.mediaType === "tv");
        const auto = requests.filter((r) => r.isAutoRequest);
        const manual = requests.filter((r) => !r.isAutoRequest);
        const distinctMovieTmdb = new Set(
          movies.map((r) => r.tmdbId).filter((v): v is number =>
            typeof v === "number"
          ),
        );

        const inv = { totalRequests: requests.length, requests, fetchedAt };
        const summary = {
          totalRequests: requests.length,
          movieRequests: movies.length,
          tvRequests: tv.length,
          autoRequests: auto.length,
          manualRequests: manual.length,
          distinctMovieTmdbIds: distinctMovieTmdb.size,
          fetchedAt,
        };

        const h1 = await context.writeResource("requests", "requests", inv);
        const h2 = await context.writeResource("summary", "summary", summary);
        return { dataHandles: [h1, h2] };
      },
    },
    approveRequest: {
      description:
        "Approve a pending request via POST /api/v1/request/{id}/approve. Non-throwing on HTTP error — outcome lands in action_result.",
      arguments: z.object({
        id: z.number().describe(
          "Seerr request id (the numeric `id` from /api/v1/request, surfaced as `requests.requests[].id`)",
        ),
      }),
      execute: async (args: ExecuteArgs, context: ExecuteContext) => {
        const { baseUrl, apiKey } = context.globalArgs;
        const { id } = args as { id: number };
        const performedAt = new Date().toISOString();

        const result = await seerrCall(
          baseUrl,
          apiKey,
          "POST",
          `/api/v1/request/${id}/approve`,
        );

        const handle = await context.writeResource(
          "action_result",
          "action_result",
          {
            baseUrl,
            requestId: id,
            action: "approve",
            httpStatus: result.status,
            ok: result.ok,
            body: result.body.slice(0, 400),
            performedAt,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    declineRequest: {
      description:
        "Decline a pending request via POST /api/v1/request/{id}/decline. Non-throwing on HTTP error — outcome lands in action_result.",
      arguments: z.object({
        id: z.number().describe(
          "Seerr request id (the numeric `id` from /api/v1/request, surfaced as `requests.requests[].id`)",
        ),
      }),
      execute: async (args: ExecuteArgs, context: ExecuteContext) => {
        const { baseUrl, apiKey } = context.globalArgs;
        const { id } = args as { id: number };
        const performedAt = new Date().toISOString();

        const result = await seerrCall(
          baseUrl,
          apiKey,
          "POST",
          `/api/v1/request/${id}/decline`,
        );

        const handle = await context.writeResource(
          "action_result",
          "action_result",
          {
            baseUrl,
            requestId: id,
            action: "decline",
            httpStatus: result.status,
            ok: result.ok,
            body: result.body.slice(0, 400),
            performedAt,
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
