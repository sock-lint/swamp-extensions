/**
 * `@lint/docker-host` — agentless docker container discovery across LXCs on
 * a Proxmox cluster.
 *
 * Single method:
 *
 *   - `sync` — read a cluster snapshot (typically from `@keeb/proxmox`),
 *     iterate every LXC marked with the `docker` tag, ssh to its hosting
 *     PVE node, and run `pct exec <vmid> -- docker ps --format json` plus
 *     `docker inspect` to enumerate each container. Emits `inventory`
 *     (per-container details) and `summary` (counts per host + total).
 *
 * Auth is SSH key to each PVE node — distribute your public key once and
 * the model reaches every docker-LXC through `pct exec` without needing
 * a separate channel into each guest.
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
  nodeIpMap: z.any().describe(
    "Map of PVE node name → IP. Pass as JSON: " +
      '\'{"proxmox-1":"192.168.4.31","proxmox-2":"192.168.4.32","proxmox-3":"192.168.4.33","proxmox-4":"192.168.4.34","proxmox-5":"192.168.4.35"}\'.',
  ),
  sshUser: z.string().default("root"),
  identityFile: z.string().default("/root/.ssh/id_ed25519"),
  clusterModelName: z.string().default("cluster")
    .describe(
      "Cluster model to read guest tags from; we filter to LXCs tagged 'docker'.",
    ),
  filterTag: z.string().default("docker")
    .describe("Cluster guest tag to consider as docker hosts"),
});

const ContainerSchema = z.object({
  hostName: z.string().describe("The LXC's name, e.g. 'media-docker'"),
  hostVmid: z.number(),
  hostNode: z.string(),
  containerId: z.string(),
  name: z.string(),
  image: z.string(),
  state: z.string(),
  status: z.string(),
  composeProject: z.string().optional(),
  composeService: z.string().optional(),
  ports: z.string().optional(),
  created: z.string().optional(),
});

const HostSummarySchema = z.object({
  name: z.string(),
  vmid: z.number(),
  node: z.string(),
  reachable: z.boolean(),
  containerCount: z.number(),
  runningCount: z.number(),
  error: z.string().optional(),
});

const InventorySchema = z.object({
  fetchedAt: z.iso.datetime(),
  hosts: z.array(HostSummarySchema),
  containers: z.array(ContainerSchema),
});

const SummarySchema = z.object({
  fetchedAt: z.iso.datetime(),
  hostsScanned: z.number(),
  hostsReachable: z.number(),
  totalContainers: z.number(),
  runningContainers: z.number(),
  byHost: z.array(z.object({
    host: z.string(),
    running: z.number(),
    total: z.number(),
  })),
});

async function pveExec(
  nodeIp: string,
  sshUser: string,
  identityFile: string,
  vmid: number,
  innerCmd: string,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const args = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-i",
    identityFile,
    `${sshUser}@${nodeIp}`,
    `pct exec ${vmid} -- sh -c ${JSON.stringify(innerCmd)}`,
  ];
  const cmd = new Deno.Command("ssh", {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  return {
    ok: code === 0,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

async function listDockerGuestsFromCluster(
  modelName: string,
  filterTag: string,
) {
  // Use the swamp CLI to enumerate cluster data, then filter to LXCs with the filterTag.
  const list = await new Deno.Command("swamp", {
    args: ["data", "list", modelName, "--json"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const data = JSON.parse(new TextDecoder().decode(list.stdout));
  const names: string[] = (data.groups ?? [])
    // deno-lint-ignore no-explicit-any
    .flatMap((g: any) => g.items ?? [])
    // deno-lint-ignore no-explicit-any
    .map((i: any) => i.name as string)
    .filter((n: string) => /^lxc-/.test(n));
  const guests: {
    name: string;
    vmid: number;
    node: string;
    status: string;
    tags: string;
  }[] = [];
  for (const n of names) {
    const r = await new Deno.Command("swamp", {
      args: ["data", "get", modelName, n, "--json"],
      stdout: "piped",
      stderr: "piped",
    }).output();
    const c = JSON.parse(new TextDecoder().decode(r.stdout))?.content;
    if (!c) continue;
    const tags: string = c.tags ?? "";
    if (!tags.split(";").map((t: string) => t.trim()).includes(filterTag)) {
      continue;
    }
    if (c.status !== "running") continue;
    guests.push({
      name: c.name,
      vmid: c.vmid,
      node: c.node,
      status: c.status,
      tags,
    });
  }
  return guests;
}

/** Swamp model definition for `@lint/docker-host`. */
export const model: {
  type: string;
  version: string;
  reports: string[];
  resources: Record<string, unknown>;
  globalArguments: unknown;
  methods: Record<string, unknown>;
} = {
  type: "@lint/docker-host",
  version: "2026.05.21.1",
  reports: [] as string[],
  globalArguments: GlobalArgsSchema,
  resources: {
    "inventory": {
      description:
        "All docker containers across docker-tagged LXCs (via PVE pct exec)",
      schema: InventorySchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    "summary": {
      description: "Counts grouped by docker host LXC",
      schema: SummarySchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
  },
  methods: {
    sync: {
      description:
        "For each docker-tagged LXC, SSH to its PVE node and pct exec docker ps",
      arguments: z.object({}),
      execute: async (_args: ExecuteArgs, context: ExecuteContext) => {
        const { sshUser, identityFile, clusterModelName, filterTag } =
          context.globalArgs;
        const fetchedAt = new Date().toISOString();

        const rawMap = context.globalArgs.nodeIpMap;
        const nodeIpMap: Record<string, string> = typeof rawMap === "string"
          ? JSON.parse(rawMap)
          : (rawMap as Record<string, string>);

        const guests = await listDockerGuestsFromCluster(
          clusterModelName,
          filterTag,
        );

        const hosts: z.infer<typeof HostSummarySchema>[] = [];
        const containers: z.infer<typeof ContainerSchema>[] = [];

        for (const g of guests) {
          const nodeIp = nodeIpMap[g.node];
          if (!nodeIp) {
            hosts.push({
              name: g.name,
              vmid: g.vmid,
              node: g.node,
              reachable: false,
              containerCount: 0,
              runningCount: 0,
              error: `no IP in nodeIpMap for ${g.node}`,
            });
            continue;
          }

          const cmd =
            "docker ps -a --no-trunc --format '{{json .}}' 2>/dev/null || echo __DOCKER_MISSING__";
          const { ok, stdout, stderr } = await pveExec(
            nodeIp,
            sshUser,
            identityFile,
            g.vmid,
            cmd,
          );
          if (!ok) {
            hosts.push({
              name: g.name,
              vmid: g.vmid,
              node: g.node,
              reachable: false,
              containerCount: 0,
              runningCount: 0,
              error: stderr.slice(0, 300),
            });
            continue;
          }
          if (stdout.includes("__DOCKER_MISSING__")) {
            hosts.push({
              name: g.name,
              vmid: g.vmid,
              node: g.node,
              reachable: true,
              containerCount: 0,
              runningCount: 0,
              error: "docker not installed or socket unreachable",
            });
            continue;
          }

          const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
          let running = 0;
          for (const line of lines) {
            try {
              const c = JSON.parse(line);
              const labels: Record<string, string> = {};
              // docker ps --format json gives a "Labels" field as comma-separated key=value string
              if (typeof c.Labels === "string") {
                for (const pair of c.Labels.split(",")) {
                  const eq = pair.indexOf("=");
                  if (eq > 0) labels[pair.slice(0, eq)] = pair.slice(eq + 1);
                }
              }
              const state = c.State ??
                (String(c.Status ?? "").startsWith("Up")
                  ? "running"
                  : "exited");
              if (state === "running") running += 1;
              containers.push({
                hostName: g.name,
                hostVmid: g.vmid,
                hostNode: g.node,
                containerId: c.ID,
                name: c.Names,
                image: c.Image,
                state,
                status: c.Status,
                composeProject: labels["com.docker.compose.project"],
                composeService: labels["com.docker.compose.service"],
                ports: c.Ports,
                created: c.CreatedAt,
              });
            } catch (_e) { /* skip malformed line */ }
          }

          hosts.push({
            name: g.name,
            vmid: g.vmid,
            node: g.node,
            reachable: true,
            containerCount: lines.length,
            runningCount: running,
          });
        }

        const inventory = { fetchedAt, hosts, containers };
        const summary = {
          fetchedAt,
          hostsScanned: hosts.length,
          hostsReachable: hosts.filter((h) => h.reachable).length,
          totalContainers: containers.length,
          runningContainers:
            containers.filter((c) => c.state === "running").length,
          byHost: hosts.map((h) => ({
            host: h.name,
            running: h.runningCount,
            total: h.containerCount,
          })),
        };

        const h1 = await context.writeResource(
          "inventory",
          "inventory",
          inventory,
        );
        const h2 = await context.writeResource("summary", "summary", summary);
        return { dataHandles: [h1, h2] };
      },
    },
  },
};
