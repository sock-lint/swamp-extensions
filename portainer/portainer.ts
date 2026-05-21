/**
 * `@lint/portainer` — Portainer REST-API wrapper for swamp.
 *
 * Three methods:
 *
 *   - `sync` — fetch `/api/endpoints`, then for every online endpoint pull
 *     `/api/endpoints/{id}/docker/containers/json?all=true` and `/api/stacks`.
 *     Emits a full `inventory` (every container's image/state/labels/ports
 *     across every endpoint Portainer can see) and a compact `summary`
 *     (per-endpoint container counts + total stack count).
 *   - `containerAction` — start / stop / restart / kill / pause / unpause a
 *     docker container on any Portainer-managed endpoint. Emits an
 *     `action_result` resource carrying HTTP status + response body, and is
 *     non-throwing on HTTP failure so batched calls survive a single 404.
 *   - `pullImage` — pull a docker image on a Portainer endpoint
 *     (`POST /api/endpoints/{id}/docker/images/create?fromImage=…`). Also
 *     records its outcome in `action_result`.
 *
 * Auth is a Portainer API key sent via the `X-API-Key` header. Endpoints with
 * `status != 1` (offline / agent unreachable) are still listed in `summary`
 * but their container set is left empty so a single dead host doesn't poison
 * the whole snapshot.
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
    "Portainer base URL, e.g. http://192.168.4.66:9000",
  ),
  apiKey: z.string().describe(
    "Portainer API key (User settings → Access tokens)",
  ),
  instanceLabel: z.string().describe(
    "Human label for this Portainer install, e.g. 'homelab'",
  ),
});

const EndpointSchema = z.object({
  id: z.number().describe("Portainer endpoint id (docker host)"),
  name: z.string(),
  type: z.number().describe(
    "Portainer endpoint type code: 1=docker, 2=agent, etc.",
  ),
  url: z.string().optional(),
  status: z.number().describe("1=up, 2=down"),
  publicURL: z.string().optional(),
  groupId: z.number().optional(),
});

const ContainerSchema = z.object({
  endpointId: z.number(),
  endpointName: z.string(),
  id: z.string().describe("Full docker container id"),
  name: z.string().describe("Primary container name (leading slash stripped)"),
  image: z.string().describe(
    "Image reference as seen by docker (may be tag or digest form)",
  ),
  imageId: z.string().describe("Local docker image id (sha256:...)"),
  repoDigest: z.string().optional().describe(
    "First RepoDigest from image inspect — what we compare against registry",
  ),
  state: z.string().describe("running, exited, paused, etc."),
  status: z.string().describe("Human status string from docker"),
  created: z.number().describe("Unix epoch seconds"),
  stackName: z.string().optional().describe(
    "compose project label if part of a stack",
  ),
  stackId: z.number().optional().describe(
    "Portainer stack id if managed by Portainer",
  ),
});

const StackSchema = z.object({
  id: z.number(),
  name: z.string(),
  endpointId: z.number(),
  endpointName: z.string(),
  type: z.number().describe("1=swarm, 2=compose"),
  status: z.number().describe("1=active, 2=inactive"),
  creationDate: z.number().optional(),
  updateDate: z.number().optional(),
});

const InventorySchema = z.object({
  instanceLabel: z.string(),
  baseUrl: z.string(),
  endpoints: z.array(EndpointSchema),
  containers: z.array(ContainerSchema),
  stacks: z.array(StackSchema),
  fetchedAt: z.iso.datetime(),
});

const SummarySchema = z.object({
  instanceLabel: z.string(),
  endpointCount: z.number(),
  endpointsUp: z.number(),
  containerCount: z.number(),
  containersRunning: z.number(),
  stackCount: z.number(),
  stacksActive: z.number(),
  uniqueImageCount: z.number(),
  fetchedAt: z.iso.datetime(),
});

const ActionResultSchema = z.object({
  instanceLabel: z.string(),
  baseUrl: z.string(),
  endpointId: z.number(),
  action: z.string().describe(
    "Action invoked: start/stop/restart/kill/pause/unpause/pullImage",
  ),
  target: z.string().describe(
    "Container id (for containerAction) or image reference (for pullImage)",
  ),
  httpStatus: z.number(),
  ok: z.boolean(),
  body: z.string().describe("Response body (truncated to 400 chars)"),
  performedAt: z.iso.datetime(),
});

async function portainerRequest(
  baseUrl: string,
  apiKey: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const url = `${baseUrl.replace(/\/$/, "")}${path}`;
  const args = [
    "-sS",
    "-X",
    method,
    "-H",
    `X-API-Key: ${apiKey}`,
    "-H",
    "Accept: application/json",
    "-w",
    "\n__HTTP_STATUS__:%{http_code}",
  ];
  if (body !== undefined) {
    args.push(
      "-H",
      "Content-Type: application/json",
      "-d",
      JSON.stringify(body),
    );
  }
  args.push(url);
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
  const text = m ? raw.slice(0, m.index) : raw;
  if (status < 200 || status >= 300) {
    throw new Error(
      `${method} ${path} -> HTTP ${status}: ${text.slice(0, 400)}`,
    );
  }
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Non-throwing twin of `portainerRequest`. Returns `{ ok, status, body }` so
 * action methods can record outcomes in a resource instead of crashing a
 * batch of calls on a single failure (e.g. a 404 for an already-removed
 * container).
 */
async function portainerCall(
  baseUrl: string,
  apiKey: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; body: string }> {
  const url = `${baseUrl.replace(/\/$/, "")}${path}`;
  const args = [
    "-sS",
    "-X",
    method,
    "-H",
    `X-API-Key: ${apiKey}`,
    "-H",
    "Accept: application/json",
    "-w",
    "\n__HTTP_STATUS__:%{http_code}",
  ];
  if (body !== undefined) {
    args.push(
      "-H",
      "Content-Type: application/json",
      "-d",
      JSON.stringify(body),
    );
  }
  args.push(url);
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
  const text = m ? raw.slice(0, m.index) : raw;
  return { ok: status >= 200 && status < 300, status, body: text };
}

/** Swamp model definition for `@lint/portainer`. */
export const model: {
  type: string;
  version: string;
  reports: string[];
  resources: Record<string, unknown>;
  globalArguments: unknown;
  methods: Record<string, unknown>;
} = {
  type: "@lint/portainer",
  version: "2026.05.21.2",
  reports: [] as string[],
  globalArguments: GlobalArgsSchema,
  resources: {
    "inventory": {
      description:
        "All Portainer endpoints, containers, and stacks — single snapshot",
      schema: InventorySchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    "summary": {
      description: "Compact counts across the Portainer install",
      schema: SummarySchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    "action_result": {
      description:
        "Outcome of the most recent containerAction / pullImage call: endpointId, action, target, HTTP status, response body",
      schema: ActionResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  methods: {
    sync: {
      description:
        "Fetch endpoints, containers, stacks across all docker hosts Portainer manages",
      arguments: z.object({}),
      execute: async (_args: ExecuteArgs, context: ExecuteContext) => {
        const { baseUrl, apiKey, instanceLabel } = context.globalArgs;
        const fetchedAt = new Date().toISOString();

        const endpointsRaw = await portainerRequest(
          baseUrl,
          apiKey,
          "GET",
          "/api/endpoints",
          // deno-lint-ignore no-explicit-any
        ) as any[];

        const endpoints = endpointsRaw.map((e) => ({
          id: e.Id,
          name: e.Name,
          type: e.Type,
          url: e.URL,
          status: e.Status,
          publicURL: e.PublicURL,
          groupId: e.GroupId,
        }));

        const stacksRaw = await portainerRequest(
          baseUrl,
          apiKey,
          "GET",
          "/api/stacks",
          // deno-lint-ignore no-explicit-any
        ) as any[];

        const stacks = stacksRaw.map((s) => ({
          id: s.Id,
          name: s.Name,
          endpointId: s.EndpointId,
          endpointName: endpoints.find((e) => e.id === s.EndpointId)?.name ??
            "",
          type: s.Type,
          status: s.Status,
          creationDate: s.CreationDate,
          updateDate: s.UpdateDate,
        }));

        const stackById = new Map<number, typeof stacks[number]>();
        for (const s of stacks) stackById.set(s.id, s);

        const containers: z.infer<typeof ContainerSchema>[] = [];
        const inspectCache = new Map<string, { repoDigest?: string }>();

        for (const ep of endpoints) {
          if (ep.status !== 1) continue;
          // deno-lint-ignore no-explicit-any
          let list: any[];
          try {
            list = await portainerRequest(
              baseUrl,
              apiKey,
              "GET",
              `/api/endpoints/${ep.id}/docker/containers/json?all=true`,
              // deno-lint-ignore no-explicit-any
            ) as any[];
          } catch (err) {
            console.log(
              `endpoint ${ep.id} ${ep.name} container list failed: ${err}`,
            );
            continue;
          }

          for (const c of list) {
            const labels = c.Labels ?? {};
            const composeProject: string | undefined =
              labels["com.docker.compose.project"];
            const stackName = composeProject;
            const matchedStack = stacks.find(
              (s) => s.endpointId === ep.id && s.name === composeProject,
            );

            const cacheKey = `${ep.id}:${c.ImageID}`;
            let inspect = inspectCache.get(cacheKey);
            if (!inspect) {
              try {
                const insp = await portainerRequest(
                  baseUrl,
                  apiKey,
                  "GET",
                  `/api/endpoints/${ep.id}/docker/images/${
                    encodeURIComponent(c.ImageID)
                  }/json`,
                  // deno-lint-ignore no-explicit-any
                ) as any;
                const digests: string[] = insp?.RepoDigests ?? [];
                inspect = { repoDigest: digests[0] };
              } catch {
                inspect = {};
              }
              inspectCache.set(cacheKey, inspect);
            }

            containers.push({
              endpointId: ep.id,
              endpointName: ep.name,
              id: c.Id,
              name: (c.Names?.[0] ?? "").replace(/^\//, ""),
              image: c.Image,
              imageId: c.ImageID,
              repoDigest: inspect.repoDigest,
              state: c.State,
              status: c.Status,
              created: c.Created,
              stackName,
              stackId: matchedStack?.id,
            });
          }
        }

        const uniqueImages = new Set(containers.map((c) => c.image));

        const inventory = {
          instanceLabel,
          baseUrl,
          endpoints,
          containers,
          stacks,
          fetchedAt,
        };

        const summary = {
          instanceLabel,
          endpointCount: endpoints.length,
          endpointsUp: endpoints.filter((e) => e.status === 1).length,
          containerCount: containers.length,
          containersRunning:
            containers.filter((c) => c.state === "running").length,
          stackCount: stacks.length,
          stacksActive: stacks.filter((s) => s.status === 1).length,
          uniqueImageCount: uniqueImages.size,
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
    containerAction: {
      description:
        "Perform a docker action on a container via Portainer (start/stop/restart/kill/pause/unpause). Non-throwing on HTTP error — outcome lands in the action_result resource so batched calls survive single failures.",
      arguments: z.object({
        endpointId: z.number().describe(
          "Portainer endpoint id (the numeric `id` from /api/endpoints — also surfaced in the `inventory.endpoints` resource)",
        ),
        containerId: z.string().describe(
          "Docker container id (full or short hex). Available on every container in the `inventory.containers` resource.",
        ),
        action: z.enum([
          "start",
          "stop",
          "restart",
          "kill",
          "pause",
          "unpause",
        ]).describe(
          "Container action to invoke; maps 1:1 to POST /containers/{id}/{action}",
        ),
      }),
      execute: async (args: ExecuteArgs, context: ExecuteContext) => {
        const { baseUrl, apiKey, instanceLabel } = context.globalArgs;
        const { endpointId, containerId, action } = args as {
          endpointId: number;
          containerId: string;
          action: string;
        };
        const performedAt = new Date().toISOString();

        const result = await portainerCall(
          baseUrl,
          apiKey,
          "POST",
          `/api/endpoints/${endpointId}/docker/containers/${
            encodeURIComponent(containerId)
          }/${action}`,
        );

        const handle = await context.writeResource(
          "action_result",
          "action_result",
          {
            instanceLabel,
            baseUrl,
            endpointId,
            action,
            target: containerId,
            httpStatus: result.status,
            ok: result.ok,
            body: result.body.slice(0, 400),
            performedAt,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    pullImage: {
      description:
        "Pull a docker image on a Portainer endpoint via POST /api/endpoints/{id}/docker/images/create?fromImage=<image>. Portainer streams the docker response; the final body lands in action_result for diagnostics.",
      arguments: z.object({
        endpointId: z.number().describe(
          "Portainer endpoint id (the numeric `id` from /api/endpoints)",
        ),
        image: z.string().describe(
          "Image reference, e.g. 'ghcr.io/user/foo:latest' or 'nginx:1.27'",
        ),
      }),
      execute: async (args: ExecuteArgs, context: ExecuteContext) => {
        const { baseUrl, apiKey, instanceLabel } = context.globalArgs;
        const { endpointId, image } = args as {
          endpointId: number;
          image: string;
        };
        const performedAt = new Date().toISOString();

        const result = await portainerCall(
          baseUrl,
          apiKey,
          "POST",
          `/api/endpoints/${endpointId}/docker/images/create?fromImage=${
            encodeURIComponent(image)
          }`,
        );

        const handle = await context.writeResource(
          "action_result",
          "action_result",
          {
            instanceLabel,
            baseUrl,
            endpointId,
            action: "pullImage",
            target: image,
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
