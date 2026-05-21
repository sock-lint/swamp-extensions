/**
 * `@lint/pbs` — Proxmox Backup Server snapshot freshness checker.
 *
 * Single method:
 *
 *   - `check` — list `vm/` and `ct/` groups in a PBS datastore, pick the
 *     newest snapshot per guest, and classify each as `fresh` (within
 *     `freshHours`, default 36), `stale`, or `missing`. Emits `summary`
 *     (counts per bucket) and `status` (per-guest details).
 *
 * Auth is a PBS API token (`PBSAPIToken=user@realm!name:secret`). Self-signed
 * certs are tolerated via `-k`, since PBS in homelabs is often behind a
 * locally-trusted CA rather than a public one.
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
  pbsBaseUrl: z.string().describe(
    "PBS base URL, e.g. https://192.168.4.63:8007",
  ),
  pbsTokenId: z.string().describe("PBS API token id, e.g. swamp@pbs!digest"),
  pbsTokenSecret: z.string().describe("PBS API token secret (UUID)"),
  datastore: z.string().describe("PBS datastore name, e.g. synology-backups"),
  pveBaseUrl: z.string().describe(
    "PVE base URL for guest enumeration, e.g. https://192.168.4.31:8006",
  ),
  pveTicket: z.string().describe(
    "PVE auth ticket (wire via CEL from proxmox-1.node)",
  ),
  pveCsrfToken: z.string().describe(
    "PVE CSRF prevention token (wire via CEL from proxmox-1.node)",
  ),
  freshHours: z.number().default(28).describe(
    "Backups older than this are flagged stale",
  ),
  skipTlsVerify: z.boolean().default(true).describe(
    "curl -k for self-signed PBS/PVE certs",
  ),
});

const GuestSummarySchema = z.object({
  vmid: z.number(),
  name: z.string(),
  type: z.enum(["qemu", "lxc"]),
  status: z.string(),
  ageHours: z.number().nullable(),
  backupCount: z.number().nullable(),
  classification: z.enum(["fresh", "stale", "missing"]),
});

const OrphanSchema = z.object({
  backupType: z.string(),
  backupId: z.string(),
  backupCount: z.number(),
  ageHours: z.number(),
});

const SummarySchema = z.object({
  ranAt: z.iso.datetime(),
  datastore: z.string(),
  usedBytes: z.number(),
  totalBytes: z.number(),
  usedPct: z.number(),
  freshCount: z.number(),
  staleCount: z.number(),
  missingCount: z.number(),
  orphanCount: z.number(),
  latestBackupAgeHours: z.number().nullable(),
  freshHoursThreshold: z.number(),
});

const StatusSchema = z.object({
  ranAt: z.iso.datetime(),
  datastore: z.string(),
  guests: z.array(GuestSummarySchema),
  orphans: z.array(OrphanSchema),
});

async function curlGet(
  url: string,
  headers: string[],
  skipTlsVerify: boolean,
): Promise<{ status: number; body: string }> {
  const args = ["-sS", "-X", "GET"];
  if (skipTlsVerify) args.push("-k");
  for (const h of headers) args.push("-H", h);
  args.push("-w", "\n__HTTP_STATUS__:%{http_code}", url);
  const cmd = new Deno.Command("curl", {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  if (code !== 0) {
    throw new Error(`curl exit=${code}: ${new TextDecoder().decode(stderr)}`);
  }
  const out = new TextDecoder().decode(stdout);
  const m = out.match(/__HTTP_STATUS__:(\d+)\s*$/);
  const status = m ? parseInt(m[1], 10) : -1;
  const body = m ? out.slice(0, m.index).trimEnd() : out;
  return { status, body };
}

async function pbsGet(
  baseUrl: string,
  tokenId: string,
  tokenSecret: string,
  path: string,
  skipTlsVerify: boolean,
  // deno-lint-ignore no-explicit-any
): Promise<any> {
  const { status, body } = await curlGet(
    `${baseUrl.replace(/\/$/, "")}${path}`,
    [`Authorization: PBSAPIToken=${tokenId}:${tokenSecret}`],
    skipTlsVerify,
  );
  if (status < 200 || status >= 300) {
    throw new Error(`PBS ${path} failed: ${status} ${body.slice(0, 200)}`);
  }
  return JSON.parse(body).data;
}

async function pveGet(
  baseUrl: string,
  ticket: string,
  csrf: string,
  path: string,
  skipTlsVerify: boolean,
  // deno-lint-ignore no-explicit-any
): Promise<any> {
  const { status, body } = await curlGet(
    `${baseUrl.replace(/\/$/, "")}${path}`,
    [`Cookie: PVEAuthCookie=${ticket}`, `CSRFPreventionToken: ${csrf}`],
    skipTlsVerify,
  );
  if (status < 200 || status >= 300) {
    throw new Error(`PVE ${path} failed: ${status} ${body.slice(0, 200)}`);
  }
  return JSON.parse(body).data;
}

interface PbsGroup {
  "backup-type": string;
  "backup-id": string;
  "backup-count": number;
  "last-backup": number;
  files?: string[];
  owner?: string;
}

interface PbsDsStatus {
  used: number;
  total: number;
  avail?: number;
}

interface PveResource {
  type: string;
  vmid?: number;
  name?: string;
  node?: string;
  status?: string;
}

/** Swamp model definition for `@lint/pbs`. */
export const model: {
  type: string;
  version: string;
  reports: string[];
  resources: Record<string, unknown>;
  globalArguments: unknown;
  methods: Record<string, unknown>;
} = {
  type: "@lint/pbs",
  version: "2026.05.21.1",
  reports: [] as string[],
  globalArguments: GlobalArgsSchema,
  resources: {
    "summary": {
      description: "Compact backup-status counts and datastore usage",
      schema: SummarySchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    "status": {
      description: "Per-guest backup classification + orphan list",
      schema: StatusSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    check: {
      description:
        "Classify each cluster guest as fresh/stale/missing against PBS groups; report datastore usage and orphans",
      arguments: z.object({}),
      execute: async (_args: ExecuteArgs, context: ExecuteContext) => {
        const {
          pbsBaseUrl,
          pbsTokenId,
          pbsTokenSecret,
          datastore,
          pveBaseUrl,
          pveTicket,
          pveCsrfToken,
          freshHours,
          skipTlsVerify,
        } = context.globalArgs;

        const ranAt = new Date().toISOString();
        const nowSec = Math.floor(Date.now() / 1000);

        const groups = (await pbsGet(
          pbsBaseUrl,
          pbsTokenId,
          pbsTokenSecret,
          `/api2/json/admin/datastore/${encodeURIComponent(datastore)}/groups`,
          skipTlsVerify,
        )) as PbsGroup[];

        const dsStatus = (await pbsGet(
          pbsBaseUrl,
          pbsTokenId,
          pbsTokenSecret,
          `/api2/json/admin/datastore/${encodeURIComponent(datastore)}/status`,
          skipTlsVerify,
        )) as PbsDsStatus;

        const resources = (await pveGet(
          pveBaseUrl,
          pveTicket,
          pveCsrfToken,
          `/api2/json/cluster/resources`,
          skipTlsVerify,
        )) as PveResource[];

        const guests = resources.filter((r) =>
          (r.type === "qemu" || r.type === "lxc") && r.vmid != null
        );

        const groupByVmid = new Map<string, PbsGroup>();
        for (const g of groups) groupByVmid.set(String(g["backup-id"]), g);

        const guestByVmid = new Set<string>();
        for (const r of guests) guestByVmid.add(String(r.vmid));

        const guestSummaries: z.infer<typeof GuestSummarySchema>[] = [];
        let freshCount = 0;
        let staleCount = 0;
        let missingCount = 0;

        for (const r of guests) {
          const g = groupByVmid.get(String(r.vmid));
          const type = r.type as "qemu" | "lxc";
          if (!g) {
            missingCount++;
            guestSummaries.push({
              vmid: Number(r.vmid),
              name: String(r.name ?? `vmid-${r.vmid}`),
              type,
              status: String(r.status ?? "unknown"),
              ageHours: null,
              backupCount: null,
              classification: "missing",
            });
            continue;
          }
          const ageH = Math.round((nowSec - g["last-backup"]) / 3600);
          const classification: "fresh" | "stale" = ageH > freshHours
            ? "stale"
            : "fresh";
          if (classification === "fresh") freshCount++;
          else staleCount++;
          guestSummaries.push({
            vmid: Number(r.vmid),
            name: String(r.name ?? `vmid-${r.vmid}`),
            type,
            status: String(r.status ?? "unknown"),
            ageHours: ageH,
            backupCount: g["backup-count"],
            classification,
          });
        }

        const orphans: z.infer<typeof OrphanSchema>[] = [];
        for (const g of groups) {
          if (!guestByVmid.has(String(g["backup-id"]))) {
            orphans.push({
              backupType: g["backup-type"],
              backupId: String(g["backup-id"]),
              backupCount: g["backup-count"],
              ageHours: Math.round((nowSec - g["last-backup"]) / 3600),
            });
          }
        }

        const latestBackup = groups.reduce<number | null>(
          (acc, g) =>
            (acc == null || g["last-backup"] > acc) ? g["last-backup"] : acc,
          null,
        );
        const latestBackupAgeHours = latestBackup == null
          ? null
          : Math.round((nowSec - latestBackup) / 3600);

        const usedBytes = Number(dsStatus.used ?? 0);
        const totalBytes = Number(dsStatus.total ?? 0);
        const usedPct = totalBytes > 0
          ? Math.round((usedBytes / totalBytes) * 10000) / 100
          : 0;

        const summary: z.infer<typeof SummarySchema> = {
          ranAt,
          datastore,
          usedBytes,
          totalBytes,
          usedPct,
          freshCount,
          staleCount,
          missingCount,
          orphanCount: orphans.length,
          latestBackupAgeHours,
          freshHoursThreshold: freshHours,
        };

        const status: z.infer<typeof StatusSchema> = {
          ranAt,
          datastore,
          guests: guestSummaries.sort((a, b) => a.vmid - b.vmid),
          orphans: orphans.sort((a, b) =>
            Number(a.backupId) - Number(b.backupId)
          ),
        };

        const sumH = await context.writeResource("summary", "summary", summary);
        const statH = await context.writeResource("status", "status", status);
        return { dataHandles: [sumH, statH] };
      },
    },
  },
};
