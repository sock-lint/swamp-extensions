/**
 * `@lint/image-updates` — docker image update tracker.
 *
 * Single method:
 *
 *   - `check` — read a docker host inventory (typically from
 *     `@lint/docker-host`), dedupe by `image:tag`, query each unique
 *     image's registry manifest, compare against the locally-inspected
 *     digest, and emit an `inventory` resource flagging which containers
 *     have updates available.
 *
 * Read-only by design — pair with `@lint/image-updater` to actually pull
 * and restart, but only after a human has reviewed the report.
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
  dockerHostInventory: z.any().describe(
    "Container inventory from @homelab/docker-host, via CEL: " +
      "`${{ data.latest('docker-hosts', 'inventory').attributes }}`",
  ),
  nodeIpMap: z.any().describe("PVE node name → IP, JSON map"),
  sshUser: z.string().default("root"),
  identityFile: z.string().default("/root/.ssh/id_ed25519"),
  skipImagePrefixes: z.any().optional().describe(
    "Image name prefixes to skip (e.g., local builds without registry). " +
      'Pass as JSON: \'["my-local/","local-build/"]\'.',
  ),
});

const ImageStatusSchema = z.object({
  image: z.string().describe("image:tag as seen by docker"),
  hostName: z.string(),
  hostVmid: z.number(),
  hostNode: z.string(),
  containerNames: z.array(z.string()),
  localDigest: z.string().optional().describe(
    "RepoDigest of locally pulled image",
  ),
  remoteDigest: z.string().optional().describe(
    "Current digest on the registry for the same tag",
  ),
  status: z.enum([
    "up-to-date",
    "update-available",
    "no-local-digest",
    "remote-unavailable",
    "skipped",
    "error",
  ]),
  errorMessage: z.string().optional(),
});

const InventorySchema = z.object({
  checkedAt: z.iso.datetime(),
  images: z.array(ImageStatusSchema),
});

const SummarySchema = z.object({
  checkedAt: z.iso.datetime(),
  totalImages: z.number(),
  upToDate: z.number(),
  updateAvailable: z.number(),
  noLocalDigest: z.number(),
  remoteUnavailable: z.number(),
  errors: z.number(),
  skipped: z.number(),
  updatesByHost: z.array(z.object({
    host: z.string(),
    count: z.number(),
  })),
});

async function pveSshExec(
  nodeIp: string,
  sshUser: string,
  identityFile: string,
  vmid: number,
  innerCmd: string,
  timeoutSec = 30,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const args = [
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${timeoutSec}`,
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

function parseRepoDigest(d: string): string | undefined {
  // "vaultwarden/server@sha256:abc..." -> "sha256:abc..."
  const at = d.lastIndexOf("@");
  if (at < 0) return undefined;
  return d.slice(at + 1);
}

/** Swamp model definition for `@lint/image-updates`. */
export const model: {
  type: string;
  version: string;
  reports: string[];
  resources: Record<string, unknown>;
  globalArguments: unknown;
  methods: Record<string, unknown>;
} = {
  type: "@lint/image-updates",
  version: "2026.05.21.1",
  reports: ["@homelab/image-updates"],
  globalArguments: GlobalArgsSchema,
  resources: {
    "inventory": {
      description: "Per-image update status across all docker LXCs",
      schema: InventorySchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    "summary": {
      description: "Counts grouped by status",
      schema: SummarySchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
  },
  methods: {
    check: {
      description:
        "Compare local RepoDigest vs registry manifest digest for each unique image",
      arguments: z.object({}),
      execute: async (_args: ExecuteArgs, context: ExecuteContext) => {
        const { sshUser, identityFile } = context.globalArgs;
        const checkedAt = new Date().toISOString();

        const rawMap = context.globalArgs.nodeIpMap;
        const nodeIpMap: Record<string, string> = typeof rawMap === "string"
          ? JSON.parse(rawMap)
          : (rawMap as Record<string, string>);

        const inv = context.globalArgs.dockerHostInventory;
        if (!inv || !Array.isArray(inv.containers)) {
          throw new Error("dockerHostInventory missing or malformed");
        }

        const rawSkip = context.globalArgs.skipImagePrefixes;
        const skipPrefixes: string[] = Array.isArray(rawSkip)
          ? rawSkip
          : typeof rawSkip === "string" && rawSkip.trim().startsWith("[")
          ? JSON.parse(rawSkip)
          : [];

        // Dedupe: group containers by (hostVmid, image). One image on one host = one check.
        // If the same image runs on multiple hosts, check each separately (might be different
        // pulls / digests).
        type Key = string;
        const groups = new Map<Key, {
          image: string;
          hostName: string;
          hostVmid: number;
          hostNode: string;
          containerNames: string[];
        }>();
        for (const c of inv.containers) {
          if (c.state !== "running") continue;
          const key = `${c.hostVmid}:${c.image}`;
          const cur = groups.get(key);
          if (cur) {
            cur.containerNames.push(c.name);
          } else {
            groups.set(key, {
              image: c.image,
              hostName: c.hostName,
              hostVmid: c.hostVmid,
              hostNode: c.hostNode,
              containerNames: [c.name],
            });
          }
        }

        const images: z.infer<typeof ImageStatusSchema>[] = [];

        for (const g of groups.values()) {
          const skipped = skipPrefixes.some((p) => g.image.startsWith(p));
          if (skipped) {
            images.push({ ...g, status: "skipped" });
            continue;
          }

          const nodeIp = nodeIpMap[g.hostNode];
          if (!nodeIp) {
            images.push({
              ...g,
              status: "error",
              errorMessage: `no IP for node ${g.hostNode}`,
            });
            continue;
          }

          // Step 1: local digest — get the full JSON inspect, parse RepoDigests on our side.
          const localCmd = `docker image inspect ${
            JSON.stringify(g.image)
          } 2>/dev/null`;
          const local = await pveSshExec(
            nodeIp,
            sshUser,
            identityFile,
            g.hostVmid,
            localCmd,
          );
          let localDigest: string | undefined;
          if (local.ok && local.stdout.trim()) {
            try {
              const arr = JSON.parse(local.stdout);
              const repoDigests: string[] = arr?.[0]?.RepoDigests ?? [];
              for (const rd of repoDigests) {
                const d = parseRepoDigest(rd);
                if (d) {
                  localDigest = d;
                  break;
                }
              }
            } catch { /* malformed json — ignore */ }
          }

          // Step 2: remote manifest digest via buildx imagetools — capture raw output, parse here.
          const remoteCmd = `docker buildx imagetools inspect ${
            JSON.stringify(g.image)
          } 2>&1`;
          const remote = await pveSshExec(
            nodeIp,
            sshUser,
            identityFile,
            g.hostVmid,
            remoteCmd,
          );
          let remoteDigest = "";
          if (remote.ok) {
            const m = remote.stdout.match(/^Digest:\s+(sha256:[a-f0-9]+)/m);
            if (m) remoteDigest = m[1];
          }

          if (!localDigest) {
            images.push({
              ...g,
              localDigest: undefined,
              remoteDigest: remoteDigest || undefined,
              status: "no-local-digest",
            });
            continue;
          }
          if (!remoteDigest) {
            images.push({
              ...g,
              localDigest,
              status: "remote-unavailable",
              errorMessage: (remote.stderr || "").slice(0, 200),
            });
            continue;
          }

          images.push({
            ...g,
            localDigest,
            remoteDigest,
            status: localDigest === remoteDigest
              ? "up-to-date"
              : "update-available",
          });
        }

        const inventory = { checkedAt, images };
        const updatesByHost = new Map<string, number>();
        for (const img of images) {
          if (img.status === "update-available") {
            updatesByHost.set(
              img.hostName,
              (updatesByHost.get(img.hostName) ?? 0) + 1,
            );
          }
        }
        const summary = {
          checkedAt,
          totalImages: images.length,
          upToDate: images.filter((i) => i.status === "up-to-date").length,
          updateAvailable:
            images.filter((i) => i.status === "update-available").length,
          noLocalDigest:
            images.filter((i) => i.status === "no-local-digest").length,
          remoteUnavailable:
            images.filter((i) => i.status === "remote-unavailable").length,
          errors: images.filter((i) => i.status === "error").length,
          skipped: images.filter((i) => i.status === "skipped").length,
          updatesByHost: Array.from(updatesByHost.entries())
            .map(([host, count]) => ({ host, count }))
            .sort((a, b) => b.count - a.count),
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
