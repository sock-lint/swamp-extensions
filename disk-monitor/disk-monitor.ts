/**
 * `@lint/disk-monitor` — SSH-based filesystem free-space monitor.
 *
 * Single method:
 *
 *   - `check` — ssh into the target host, run `df -P`, parse, and classify
 *     every mount as `ok`, `warn`, or `crit` against per-mount thresholds
 *     (with global defaults for unconfigured mounts). Emits a `disk_usage`
 *     resource with full per-mount detail plus `anyWarning` / `anyCritical`
 *     booleans for cheap downstream gating.
 *
 * Auth is SSH key — set up `authorized_keys` on the target host before
 * pointing this model at it.
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
  sshHost: z.string().describe(
    "Hostname/IP of the box to query, e.g. 192.168.4.52",
  ),
  sshUser: z.string().default("root").describe("SSH user"),
  identityFile: z.string().default("/root/.ssh/id_ed25519").describe(
    "Path to SSH private key on this host",
  ),
  paths: z.any().optional()
    .describe(
      'Mountpoints to check. Pass as JSON: \'["/volume1","/volume2"]\'. Defaults to /volume1+/volume2.',
    ),
  warnPercent: z.number().default(80)
    .describe("Usage % at which a volume is considered 'warning'"),
  criticalPercent: z.number().default(90)
    .describe("Usage % at which a volume is considered 'critical'"),
});

const VolumeUsageSchema = z.object({
  path: z.string(),
  totalBytes: z.number(),
  usedBytes: z.number(),
  availBytes: z.number(),
  usePercent: z.number(),
  status: z.enum(["ok", "warning", "critical"]),
});

const DiskUsageSchema = z.object({
  checkedAt: z.iso.datetime(),
  host: z.string(),
  volumes: z.array(VolumeUsageSchema),
  anyWarning: z.boolean(),
  anyCritical: z.boolean(),
});

function parseDfHumanLine(
  line: string,
): {
  totalBytes: number;
  usedBytes: number;
  availBytes: number;
  usePercent: number;
} | null {
  // df --output=size,used,avail,pcent,target -B1 emits:
  // <size> <used> <avail> <pcent> <target>
  const parts = line.trim().split(/\s+/);
  if (parts.length < 5) return null;
  const totalBytes = Number(parts[0]);
  const usedBytes = Number(parts[1]);
  const availBytes = Number(parts[2]);
  const usePercent = Number(parts[3].replace("%", ""));
  if (Number.isNaN(totalBytes) || Number.isNaN(usePercent)) return null;
  return { totalBytes, usedBytes, availBytes, usePercent };
}

/** Swamp model definition for `@lint/disk-monitor`. */
export const model: {
  type: string;
  version: string;
  reports: string[];
  resources: Record<string, unknown>;
  globalArguments: unknown;
  methods: Record<string, unknown>;
} = {
  type: "@lint/disk-monitor",
  version: "2026.05.21.1",
  reports: [] as string[],
  globalArguments: GlobalArgsSchema,
  resources: {
    "disk_usage": {
      description: "Per-volume usage snapshot with warning/critical flags",
      schema: DiskUsageSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    check: {
      description:
        "SSH to the target host, run df, compute usage %, flag warnings",
      arguments: z.object({}),
      execute: async (_args: ExecuteArgs, context: ExecuteContext) => {
        const { sshHost, sshUser, identityFile, warnPercent, criticalPercent } =
          context.globalArgs;
        const checkedAt = new Date().toISOString();

        const rawPaths = context.globalArgs.paths;
        const paths: string[] = Array.isArray(rawPaths)
          ? rawPaths
          : (typeof rawPaths === "string" && rawPaths.trim().startsWith("[")
            ? JSON.parse(rawPaths)
            : ["/volume1", "/volume2"]);
        const pathList = paths.join(" ");
        const cmd = `df --output=size,used,avail,pcent,target -B1 ${pathList}`;
        const args = [
          "-o",
          "BatchMode=yes",
          "-o",
          "StrictHostKeyChecking=accept-new",
          "-o",
          "ConnectTimeout=10",
          "-i",
          identityFile,
          `${sshUser}@${sshHost}`,
          cmd,
        ];
        const sshCmd = new Deno.Command("ssh", {
          args,
          stdout: "piped",
          stderr: "piped",
        });
        const { code, stdout, stderr } = await sshCmd.output();
        if (code !== 0) {
          throw new Error(`ssh failed: ${new TextDecoder().decode(stderr)}`);
        }
        const out = new TextDecoder().decode(stdout);
        const lines = out.trim().split("\n").slice(1); // drop header

        const volumes: z.infer<typeof VolumeUsageSchema>[] = [];
        for (const line of lines) {
          const parsed = parseDfHumanLine(line);
          if (!parsed) continue;
          const target = line.trim().split(/\s+/).slice(4).join(" ");
          let status: "ok" | "warning" | "critical" = "ok";
          if (parsed.usePercent >= criticalPercent) status = "critical";
          else if (parsed.usePercent >= warnPercent) status = "warning";
          volumes.push({
            path: target,
            totalBytes: parsed.totalBytes,
            usedBytes: parsed.usedBytes,
            availBytes: parsed.availBytes,
            usePercent: parsed.usePercent,
            status,
          });
        }

        const anyWarning = volumes.some((v) => v.status === "warning");
        const anyCritical = volumes.some((v) => v.status === "critical");

        const handle = await context.writeResource("disk_usage", "disk_usage", {
          checkedAt,
          host: sshHost,
          volumes,
          anyWarning,
          anyCritical,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
