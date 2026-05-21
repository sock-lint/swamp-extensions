/**
 * `@lint/media-diagnostic` — cross-instance Radarr storage waste scanner.
 *
 * Single method:
 *
 *   - `scan` — compare a default (1080p) Radarr inventory against a 4K
 *     Radarr inventory and surface three kinds of waste: duplicates (same
 *     `folderName` in both instances), missing files (Radarr entries with
 *     `hasFile: false`), and oversized files (above `oversizedThresholdBytes`,
 *     default 60 GiB). Emits `findings` (per-entry detail) and `summary`
 *     (counts + reclaim totals across three reclaim strategies).
 *
 * Read-only — pair with `@lint/media-cleaner` to act on the findings.
 * Duplicate matching uses `folderName` (basename), which catches the
 * canonical "same movie, two copies" case without needing TMDb-id lookup.
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
const MovieSchema = z.object({
  id: z.number(),
  title: z.string(),
  year: z.number().optional(),
  folderName: z.string(),
  path: z.string(),
  sizeOnDisk: z.number(),
  hasFile: z.boolean(),
  qualityProfileId: z.number().optional(),
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

const GlobalArgsSchema = z.object({
  defaultInventory: z.any().describe(
    "Inventory from the default (1080p) Radarr; wire via CEL `${{ data.latest('<name>', 'inventory').attributes }}`",
  ),
  fourKInventory: z.any().describe(
    "Inventory from the 4K Radarr; wire via CEL",
  ),
  oversizedThresholdBytes: z.number().default(60 * 1024 * 1024 * 1024)
    .describe("File size above which we flag as oversized (default 60 GiB)"),
});

const DuplicateSchema = z.object({
  folderName: z.string(),
  defaultId: z.number(),
  defaultPath: z.string(),
  defaultSizeBytes: z.number(),
  fourKId: z.number(),
  fourKPath: z.string(),
  fourKSizeBytes: z.number(),
  smallerCopyBytes: z.number(),
  reclaimIfDropSmaller: z.number(),
});

const MissingFileSchema = z.object({
  instanceLabel: z.string(),
  id: z.number(),
  title: z.string(),
  year: z.number().optional(),
  path: z.string(),
});

const OversizedSchema = z.object({
  instanceLabel: z.string(),
  id: z.number(),
  title: z.string(),
  year: z.number().optional(),
  path: z.string(),
  sizeBytes: z.number(),
});

const FindingsSchema = z.object({
  scannedAt: z.iso.datetime(),
  duplicates: z.array(DuplicateSchema),
  missingFiles: z.array(MissingFileSchema),
  oversized: z.array(OversizedSchema),
});

const SummarySchema = z.object({
  scannedAt: z.iso.datetime(),
  defaultMovieCount: z.number(),
  fourKMovieCount: z.number(),
  duplicateCount: z.number(),
  missingFileCount: z.number(),
  oversizedCount: z.number(),
  reclaimDropSmallerBytes: z.number().describe(
    "Total bytes reclaimed if smaller copy of each duplicate is dropped",
  ),
  reclaimDropAll1080pDupsBytes: z.number(),
  reclaimDropAll4KDupsBytes: z.number(),
});

/** Swamp model definition for `@lint/media-diagnostic`. */
export const model: {
  type: string;
  version: string;
  reports: string[];
  resources: Record<string, unknown>;
  globalArguments: unknown;
  methods: Record<string, unknown>;
} = {
  type: "@lint/media-diagnostic",
  version: "2026.05.21.1",
  reports: ["@homelab/media-diagnostic"],
  globalArguments: GlobalArgsSchema,
  resources: {
    "findings": {
      description: "All detected issues across the media fleet",
      schema: FindingsSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    "summary": {
      description: "Top-line counts and reclaim totals",
      schema: SummarySchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
  },
  methods: {
    scan: {
      description:
        "Cross-reference Radarr inventories, surface duplicates, orphans, and oversized files",
      arguments: z.object({}),
      execute: async (_args: ExecuteArgs, context: ExecuteContext) => {
        const { oversizedThresholdBytes } = context.globalArgs;
        const defaultInventory = InventorySchema.parse(
          context.globalArgs.defaultInventory,
        );
        const fourKInventory = InventorySchema.parse(
          context.globalArgs.fourKInventory,
        );
        const scannedAt = new Date().toISOString();

        const byFolder4K = new Map<string, typeof fourKInventory.movies[0]>();
        for (const m of fourKInventory.movies) {
          byFolder4K.set(m.folderName, m);
        }

        const duplicates: z.infer<typeof DuplicateSchema>[] = [];
        for (const def of defaultInventory.movies) {
          const k4 = byFolder4K.get(def.folderName);
          if (!k4) continue;
          if (!def.hasFile || !k4.hasFile) continue;
          const smaller = Math.min(def.sizeOnDisk, k4.sizeOnDisk);
          duplicates.push({
            folderName: def.folderName,
            defaultId: def.id,
            defaultPath: def.path,
            defaultSizeBytes: def.sizeOnDisk,
            fourKId: k4.id,
            fourKPath: k4.path,
            fourKSizeBytes: k4.sizeOnDisk,
            smallerCopyBytes: smaller,
            reclaimIfDropSmaller: smaller,
          });
        }

        const missingFiles: z.infer<typeof MissingFileSchema>[] = [];
        for (const inv of [defaultInventory, fourKInventory]) {
          for (const m of inv.movies) {
            if (!m.hasFile) {
              missingFiles.push({
                instanceLabel: inv.instanceLabel,
                id: m.id,
                title: m.title,
                year: m.year,
                path: m.path,
              });
            }
          }
        }

        const oversized: z.infer<typeof OversizedSchema>[] = [];
        for (const inv of [defaultInventory, fourKInventory]) {
          for (const m of inv.movies) {
            if (m.hasFile && m.sizeOnDisk > oversizedThresholdBytes) {
              oversized.push({
                instanceLabel: inv.instanceLabel,
                id: m.id,
                title: m.title,
                year: m.year,
                path: m.path,
                sizeBytes: m.sizeOnDisk,
              });
            }
          }
        }
        oversized.sort((a, b) => b.sizeBytes - a.sizeBytes);

        const reclaimDropSmaller = duplicates.reduce(
          (a, d) => a + d.reclaimIfDropSmaller,
          0,
        );
        const reclaimDrop1080 = duplicates.reduce(
          (a, d) => a + d.defaultSizeBytes,
          0,
        );
        const reclaimDrop4K = duplicates.reduce(
          (a, d) => a + d.fourKSizeBytes,
          0,
        );

        const findings = { scannedAt, duplicates, missingFiles, oversized };
        const summary = {
          scannedAt,
          defaultMovieCount: defaultInventory.movieCount,
          fourKMovieCount: fourKInventory.movieCount,
          duplicateCount: duplicates.length,
          missingFileCount: missingFiles.length,
          oversizedCount: oversized.length,
          reclaimDropSmallerBytes: reclaimDropSmaller,
          reclaimDropAll1080pDupsBytes: reclaimDrop1080,
          reclaimDropAll4KDupsBytes: reclaimDrop4K,
        };

        const findingsHandle = await context.writeResource(
          "findings",
          "findings",
          findings,
        );
        const summaryHandle = await context.writeResource(
          "summary",
          "summary",
          summary,
        );
        return { dataHandles: [findingsHandle, summaryHandle] };
      },
    },
  },
};
