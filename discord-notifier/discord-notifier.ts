/**
 * `@lint/discord-notifier` — opinionated weekly Discord report poster.
 *
 * Composes a multi-embed Discord webhook payload from the outputs of the
 * curator + ops stack:
 *
 *   - `@lint/media-curator` (movieSummary, movieDropCandidates,
 *     movieProtectedDrops)
 *   - `@lint/tv-curator` (tvSummary, tvDropCandidates, tvProtectedDrops)
 *   - `@lint/disk-monitor` disk usage (optional)
 *   - `@lint/image-updates` inventory (optional)
 *
 * Single method:
 *
 *   - `notify` — render the embeds, attach top-N drops as CSV files, POST to
 *     the configured webhook. Emits a `notification_log` resource per call.
 *
 * Inputs are wired via CEL on `data.latest(...)` from each upstream model.
 * This is intentionally a "bring your own stack" model — the embeds are
 * shaped for the keep-forever / drop-candidate vocabulary that those four
 * extensions emit. Use as a pattern to copy if you want a different shape.
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
// ---------- Input shapes (subset of curator outputs) ----------

const ScoredItemSchema = z.object({
  title: z.string(),
  year: z.number().optional(),
  score: z.number(),
  sizeOnDisk: z.number(),
  reasons: z.array(z.string()).optional(),
  tagNames: z.array(z.string()).optional(),
}).passthrough();

const DropPayloadSchema = z.object({
  scannedAt: z.string(),
  threshold: z.number(),
  count: z.number(),
  totalReclaimBytes: z.number().optional(),
  totalShieldedBytes: z.number().optional(),
  candidates: z.array(ScoredItemSchema).optional(),
  protected: z.array(ScoredItemSchema).optional(),
});

const SummarySchema = z.object({
  scannedAt: z.string(),
  totalScored: z.number(),
  dropCandidateCount: z.number(),
  dropCandidateBytes: z.number(),
  protectedDropCount: z.number().optional(),
  protectedDropBytes: z.number().optional(),
}).passthrough();

const GlobalArgsSchema = z.object({
  webhookUrl: z.string().describe("Discord webhook URL"),
  username: z.string().default("Curator Bot"),
  topN: z.number().default(15).describe("Top-N items to list per section"),
  // Curator outputs wired via CEL
  movieSummary: z.any().describe("media-curator summary via CEL"),
  movieDropCandidates: z.any().describe(
    "media-curator drop_candidates via CEL",
  ),
  movieProtectedDrops: z.any().optional().describe(
    "media-curator protected_drops via CEL",
  ),
  tvSummary: z.any().describe("tv-curator summary via CEL"),
  tvDropCandidates: z.any().describe("tv-curator drop_candidates via CEL"),
  tvProtectedDrops: z.any().optional().describe(
    "tv-curator protected_drops via CEL",
  ),
  // Optional disk usage snapshot
  diskUsage: z.any().optional().describe(
    "disk-monitor disk_usage via CEL (optional)",
  ),
  // Optional image-updates inventory
  imageUpdates: z.any().optional().describe(
    "image-updates inventory via CEL (optional)",
  ),
  // Optional updater log
  updaterLog: z.any().optional().describe(
    "image-updater update_log via CEL (optional)",
  ),
  // Optional PBS backup status
  pbsSummary: z.any().optional().describe("pbs summary via CEL (optional)"),
  pbsStatus: z.any().optional().describe("pbs status via CEL (optional)"),
});

const NotificationLogSchema = z.object({
  sentAt: z.iso.datetime(),
  httpStatus: z.number(),
  ok: z.boolean(),
  embedCount: z.number(),
  attachmentCount: z.number(),
  movieDropCount: z.number(),
  tvDropCount: z.number(),
  movieProtectedCount: z.number(),
  tvProtectedCount: z.number(),
});

// ---------- Helpers ----------

function fmtBytes(n: number): string {
  if (!n || n <= 0) return "0";
  if (n >= 1024 ** 4) return (n / 1024 ** 4).toFixed(2) + " TiB";
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(1) + " GiB";
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + " MiB";
  return `${n} B`;
}

function fmtItemLine(item: z.infer<typeof ScoredItemSchema>): string {
  const titleStr = item.year ? `${item.title} (${item.year})` : item.title;
  return `\`${String(item.score).padStart(4)}\` · ${
    fmtBytes(item.sizeOnDisk)
  } · ${titleStr}`;
}

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function itemsToCsv(
  items: z.infer<typeof ScoredItemSchema>[],
  extraCols: string[] = [],
): string {
  const baseCols = ["score", "size_gib", "title", "year", "reasons"];
  const cols = [...baseCols, ...extraCols];
  const header = cols.join(",");
  // deno-lint-ignore no-explicit-any
  const rows = items.map((it: any) => {
    const sizeGib = (it.sizeOnDisk / 1024 / 1024 / 1024).toFixed(2);
    const reasons = (it.reasons ?? []).join(" | ");
    const row: Record<string, unknown> = {
      score: it.score,
      size_gib: sizeGib,
      title: it.title,
      year: it.year ?? "",
      reasons,
      status: it.status ?? "",
      rating: it.rating ?? it.bestReviewScore ?? "",
      tags: (it.tagNames ?? []).join("|"),
      path: it.path ?? "",
      radarr_id: it.radarrId ?? "",
      sonarr_id: it.sonarrId ?? "",
      tmdb_id: it.tmdbId ?? "",
      imdb_id: it.imdbId ?? "",
      play_count: it.playCount ?? "",
    };
    return cols.map((c) => csvEscape(row[c])).join(",");
  });
  return [header, ...rows].join("\n");
}

function _chunkLines(lines: string[], maxChars = 4000): string[] {
  const chunks: string[] = [];
  let buf = "";
  for (const l of lines) {
    if (buf.length + l.length + 1 > maxChars) {
      if (buf) chunks.push(buf);
      buf = l;
    } else {
      buf = buf ? buf + "\n" + l : l;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

// ---------- Model ----------

/** Swamp model definition for `@lint/discord-notifier`. */
export const model: {
  type: string;
  version: string;
  reports: string[];
  resources: Record<string, unknown>;
  globalArguments: unknown;
  methods: Record<string, unknown>;
} = {
  type: "@lint/discord-notifier",
  version: "2026.05.21.1",
  reports: [] as string[],
  globalArguments: GlobalArgsSchema,
  resources: {
    "notification_log": {
      description: "Per-send audit log of Discord delivery",
      schema: NotificationLogSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  methods: {
    notify: {
      description:
        "Format the curator's drop + protected lists and post to Discord webhook",
      arguments: z.object({}),
      execute: async (_args: ExecuteArgs, context: ExecuteContext) => {
        const { webhookUrl, username, topN } = context.globalArgs;
        const movieSummary = SummarySchema.parse(
          context.globalArgs.movieSummary,
        );
        const movieDrops = DropPayloadSchema.parse(
          context.globalArgs.movieDropCandidates,
        );
        const movieProt = context.globalArgs.movieProtectedDrops
          ? DropPayloadSchema.parse(context.globalArgs.movieProtectedDrops)
          : {
            candidates: [],
            protected: [],
            count: 0,
            scannedAt: "",
            threshold: 0,
          };
        const tvSummary = SummarySchema.parse(context.globalArgs.tvSummary);
        const tvDrops = DropPayloadSchema.parse(
          context.globalArgs.tvDropCandidates,
        );
        const tvProt = context.globalArgs.tvProtectedDrops
          ? DropPayloadSchema.parse(context.globalArgs.tvProtectedDrops)
          : {
            candidates: [],
            protected: [],
            count: 0,
            scannedAt: "",
            threshold: 0,
          };

        const movieCandidates = movieDrops.candidates ?? [];
        const tvCandidates = tvDrops.candidates ?? [];
        const movieProtected = movieProt.protected ?? [];
        const tvProtected = tvProt.protected ?? [];

        const totalDrops = movieCandidates.length + tvCandidates.length;
        const totalProtected = movieProtected.length + tvProtected.length;

        // deno-lint-ignore no-explicit-any
        const embeds: any[] = [];

        // Header embed
        const totalReclaim = (movieSummary.dropCandidateBytes ?? 0) +
          (tvSummary.dropCandidateBytes ?? 0);
        const totalShielded = (movieSummary.protectedDropBytes ?? 0) +
          (tvSummary.protectedDropBytes ?? 0);
        embeds.push({
          title: "📋 Weekly Curator Report",
          description: [
            `Scanned **${movieSummary.totalScored}** movies and **${tvSummary.totalScored}** series.`,
            "",
            `🎬 Movie drop candidates: **${movieCandidates.length}** — ${
              fmtBytes(movieSummary.dropCandidateBytes ?? 0)
            }`,
            `📺 TV drop candidates: **${tvCandidates.length}** — ${
              fmtBytes(tvSummary.dropCandidateBytes ?? 0)
            }`,
            `🛡️ Tag-shielded (would drop if untagged): **${totalProtected}** — ${
              fmtBytes(totalShielded)
            }`,
            "",
            `Total potentially reclaimable: **${fmtBytes(totalReclaim)}**`,
          ].join("\n"),
          color: totalDrops > 0 ? 0xe67e22 : 0x2ecc71, // orange if action, green if clean
          footer: {
            text:
              `Threshold: movies ≤ ${movieDrops.threshold}, TV ≤ ${tvDrops.threshold}`,
          },
          timestamp: new Date().toISOString(),
        });

        // Image-updates embed (only if data wired)
        const imageUpdates = context.globalArgs.imageUpdates;
        if (imageUpdates && Array.isArray(imageUpdates.images)) {
          // deno-lint-ignore no-explicit-any
          const updates = imageUpdates.images.filter((i: any) =>
            i.status === "update-available"
          );
          if (updates.length > 0) {
            // deno-lint-ignore no-explicit-any
            const lines = updates.slice(0, 20).map((u: any) =>
              `${u.hostName} · \`${u.image}\``
            );
            const more = updates.length > 20
              ? `\n_…and ${updates.length - 20} more_`
              : "";
            embeds.push({
              title: `🔄 Container Image Updates (${updates.length})`,
              description: lines.join("\n") + more,
              color: 0x3498db,
            });
          }
        }

        // Auto-update outcome embed (if updater ran)
        const updaterLog = context.globalArgs.updaterLog;
        if (updaterLog && Array.isArray(updaterLog.actions)) {
          // deno-lint-ignore no-explicit-any
          const updated = updaterLog.actions.filter((a: any) =>
            a.decision === "updated"
          );
          // deno-lint-ignore no-explicit-any
          const failed = updaterLog.actions.filter((a: any) =>
            ["failed_pull", "failed_recreate", "error", "unhealthy_after"]
              .includes(a.decision)
          );
          const lines: string[] = [];
          if (updated.length > 0) {
            lines.push(`**✅ Auto-updated (${updated.length}):**`);
            for (const u of updated.slice(0, 15)) {
              lines.push(`• ${u.hostName} · \`${u.image}\``);
            }
          }
          if (failed.length > 0) {
            if (lines.length) lines.push("");
            lines.push(`**⚠️ Update failures (${failed.length}):**`);
            for (const f of failed.slice(0, 10)) {
              lines.push(
                `• ${f.hostName} · \`${f.image}\` — ${
                  f.decision.replace(/_/g, " ")
                }`,
              );
            }
          }
          if (lines.length > 0) {
            embeds.push({
              title: `🛠️ Container Auto-Updates (this run)`,
              description: lines.join("\n"),
              color: failed.length > 0 ? 0xe67e22 : 0x2ecc71,
            });
          }
        }

        // PBS backup status embed (only if data wired)
        const pbsSummary = context.globalArgs.pbsSummary;
        const pbsStatus = context.globalArgs.pbsStatus;
        if (pbsSummary && pbsStatus) {
          const usedTib = (pbsSummary.usedBytes / 1024 ** 4).toFixed(2);
          const totalTib = (pbsSummary.totalBytes / 1024 ** 4).toFixed(2);
          const pct = pbsSummary.usedPct;
          const dsIcon = pct >= 90 ? "🔴" : (pct >= 80 ? "🟠" : "🟢");
          const latestAge = pbsSummary.latestBackupAgeHours == null
            ? "—"
            : `${pbsSummary.latestBackupAgeHours}h ago`;

          const lines: string[] = [];
          lines.push(
            `${dsIcon} **${pbsSummary.datastore}** — ${usedTib} / ${totalTib} TiB (${pct}%)`,
          );
          lines.push(
            `📦 ${pbsSummary.freshCount} fresh · ${pbsSummary.staleCount} stale · ` +
              `${pbsSummary.missingCount} missing · ${pbsSummary.orphanCount} orphan · ` +
              `latest ${latestAge}`,
          );

          // deno-lint-ignore no-explicit-any
          const stale = (pbsStatus.guests ?? []).filter((g: any) =>
            g.classification === "stale"
          );
          // deno-lint-ignore no-explicit-any
          const missing = (pbsStatus.guests ?? []).filter((g: any) =>
            g.classification === "missing"
          );
          const orphans = pbsStatus.orphans ?? [];

          if (stale.length > 0) {
            lines.push("");
            lines.push("**⚠️ Stale (last backup > threshold):**");
            for (const g of stale.slice(0, 10)) {
              const stoppedTag = g.status === "stopped" ? " _(stopped)_" : "";
              lines.push(
                `• \`${g.type}/${g.vmid}\` ${g.name} — ${g.ageHours}h ago${stoppedTag}`,
              );
            }
            if (stale.length > 10) {
              lines.push(`_…and ${stale.length - 10} more stale_`);
            }
          }
          if (missing.length > 0) {
            lines.push("");
            lines.push("**❌ Missing (no backup group):**");
            for (const g of missing.slice(0, 10)) {
              const stoppedTag = g.status === "stopped" ? " _(stopped)_" : "";
              lines.push(`• \`${g.type}/${g.vmid}\` ${g.name}${stoppedTag}`);
            }
            if (missing.length > 10) {
              lines.push(`_…and ${missing.length - 10} more missing_`);
            }
          }
          if (orphans.length > 0) {
            lines.push("");
            lines.push("**🗑️ Orphans (backup group but no guest):**");
            for (const o of orphans.slice(0, 10)) {
              lines.push(
                `• \`${o.backupType}/${o.backupId}\` — ${o.backupCount} snaps, ${o.ageHours}h ago`,
              );
            }
            if (orphans.length > 10) {
              lines.push(`_…and ${orphans.length - 10} more orphans_`);
            }
          }

          const allClear = stale.length === 0 && missing.length === 0 &&
            orphans.length === 0;
          const headerEmoji = pct >= 90
            ? "🚨"
            : (stale.length + missing.length > 0 ? "⚠️" : "💾");
          const color = pct >= 90
            ? 0xe74c3c
            : (stale.length + missing.length > 0
              ? 0xe67e22
              : (allClear ? 0x2ecc71 : 0x3498db));

          embeds.push({
            title: `${headerEmoji} PBS Backups`,
            description: lines.join("\n"),
            color,
          });
        }

        // Disk usage embed (only if data wired)
        const diskUsage = context.globalArgs.diskUsage;
        if (diskUsage && Array.isArray(diskUsage.volumes)) {
          const lines: string[] = [];
          for (const v of diskUsage.volumes) {
            const icon = v.status === "critical"
              ? "🔴"
              : (v.status === "warning" ? "🟠" : "🟢");
            const usedTb = (v.usedBytes / 1024 ** 4).toFixed(2);
            const totalTb = (v.totalBytes / 1024 ** 4).toFixed(2);
            const freeTb = (v.availBytes / 1024 ** 4).toFixed(2);
            lines.push(
              `${icon} **${v.path}** — ${usedTb} / ${totalTb} TiB (${v.usePercent}%) · ${freeTb} TiB free`,
            );
          }
          const headerEmoji = diskUsage.anyCritical
            ? "🚨"
            : (diskUsage.anyWarning ? "⚠️" : "💾");
          embeds.push({
            title: `${headerEmoji} Disk Usage (${diskUsage.host})`,
            description: lines.join("\n"),
            color: diskUsage.anyCritical
              ? 0xe74c3c
              : (diskUsage.anyWarning ? 0xf39c12 : 0x3498db),
          });
        }

        // Movie drops — embed shows preview, attachment has full list
        if (movieCandidates.length > 0) {
          const shown = movieCandidates.slice(0, topN);
          const lines = shown.map(fmtItemLine);
          const more = movieCandidates.length > topN
            ? `\n_…${movieCandidates.length - topN} more in attached CSV_`
            : "";
          const desc = lines.join("\n") + more;
          embeds.push({
            title:
              `🎬 Movie Drop Candidates (${movieCandidates.length} total, top ${shown.length} shown)`,
            description: desc.length > 4000
              ? desc.slice(0, 4000) + "\n…(truncated)"
              : desc,
            color: 0xe74c3c,
          });
        }

        // TV drops — embed shows preview, attachment has full list
        if (tvCandidates.length > 0) {
          const shown = tvCandidates.slice(0, topN);
          const lines = shown.map(fmtItemLine);
          const more = tvCandidates.length > topN
            ? `\n_…${tvCandidates.length - topN} more in attached CSV_`
            : "";
          const desc = lines.join("\n") + more;
          embeds.push({
            title:
              `📺 TV Drop Candidates (${tvCandidates.length} total, top ${shown.length} shown)`,
            description: desc.length > 4000
              ? desc.slice(0, 4000) + "\n…(truncated)"
              : desc,
            color: 0xe74c3c,
          });
        }

        // Tag-shielded sanity check (only if any)
        if (totalProtected > 0) {
          const lines: string[] = [];
          if (movieProtected.length > 0) {
            lines.push("**🎬 Movies (shielded by keep-forever tag):**");
            for (const m of movieProtected.slice(0, topN)) {
              lines.push(fmtItemLine(m));
            }
            if (movieProtected.length > topN) {
              lines.push(`_…${movieProtected.length - topN} more_`);
            }
          }
          if (tvProtected.length > 0) {
            if (lines.length) lines.push("");
            lines.push("**📺 TV (shielded by keep-forever tag):**");
            for (const s of tvProtected.slice(0, topN)) {
              lines.push(fmtItemLine(s));
            }
            if (tvProtected.length > topN) {
              lines.push(`_…${tvProtected.length - topN} more_`);
            }
          }
          const desc = lines.join("\n");
          embeds.push({
            title:
              `🛡️ Currently Tag-Shielded (would drop without your keep tags)`,
            description: desc.length > 4000
              ? desc.slice(0, 4000) + "\n…(truncated)"
              : desc,
            color: 0x3498db,
          });
        }

        // Action hint
        embeds.push({
          description: [
            "**To act:**",
            "• Spare a movie/show forever — add the `keep-forever` tag in Radarr/Sonarr",
            "• Untag if you no longer want to protect — it'll surface in the drops list next week",
            "• Apply a drop: `swamp model method run media-cleaner applyDrops --input apply=true`",
            "  (or `tv-cleaner` for shows; both dry-run by default)",
          ].join("\n"),
          color: 0x95a5a6,
        });

        const payload = { username, embeds };

        // Write each non-empty list to a temp CSV file and attach as multipart upload.
        const today = new Date().toISOString().slice(0, 10);
        const tmpDir = await Deno.makeTempDir({ prefix: "discord-curator-" });
        const attachments: { path: string; filename: string }[] = [];
        try {
          if (movieCandidates.length > 0) {
            const path = `${tmpDir}/movie-drops-${today}.csv`;
            await Deno.writeTextFile(
              path,
              itemsToCsv(movieCandidates, [
                "radarr_id",
                "tmdb_id",
                "imdb_id",
                "path",
                "rating",
                "play_count",
              ]),
            );
            attachments.push({ path, filename: `movie-drops-${today}.csv` });
          }
          if (movieProtected.length > 0) {
            const path = `${tmpDir}/movie-protected-${today}.csv`;
            await Deno.writeTextFile(
              path,
              itemsToCsv(movieProtected, [
                "radarr_id",
                "tags",
                "path",
                "rating",
                "play_count",
              ]),
            );
            attachments.push({
              path,
              filename: `movie-protected-${today}.csv`,
            });
          }
          if (tvCandidates.length > 0) {
            const path = `${tmpDir}/tv-drops-${today}.csv`;
            await Deno.writeTextFile(
              path,
              itemsToCsv(tvCandidates, [
                "sonarr_id",
                "tmdb_id",
                "imdb_id",
                "status",
                "rating",
                "path",
                "play_count",
              ]),
            );
            attachments.push({ path, filename: `tv-drops-${today}.csv` });
          }
          if (tvProtected.length > 0) {
            const path = `${tmpDir}/tv-protected-${today}.csv`;
            await Deno.writeTextFile(
              path,
              itemsToCsv(tvProtected, [
                "sonarr_id",
                "tags",
                "status",
                "rating",
                "path",
                "play_count",
              ]),
            );
            attachments.push({ path, filename: `tv-protected-${today}.csv` });
          }

          // POST multipart via curl. Write payload to a temp file so any `;` or `=` in
          // the JSON body doesn't collide with curl's -F directive parsing.
          const payloadPath = `${tmpDir}/payload.json`;
          await Deno.writeTextFile(payloadPath, JSON.stringify(payload));
          const args = [
            "-sS",
            "-X",
            "POST",
            "-F",
            `payload_json=<${payloadPath}`,
          ];
          attachments.forEach((a, i) => {
            args.push("-F", `files[${i}]=@${a.path}`);
          });
          args.push("-w", "\n__HTTP_STATUS__:%{http_code}", webhookUrl);

          const cmd = new Deno.Command("curl", {
            args,
            stdout: "piped",
            stderr: "piped",
          });
          const { code, stdout, stderr } = await cmd.output();
          if (code !== 0) {
            throw new Error(
              `curl exit ${code}: ${new TextDecoder().decode(stderr)}`,
            );
          }
          const raw = new TextDecoder().decode(stdout);
          const m = raw.match(/\n__HTTP_STATUS__:(\d+)$/);
          const status = m ? parseInt(m[1], 10) : 0;
          const ok = status >= 200 && status < 300;

          const log = {
            sentAt: new Date().toISOString(),
            httpStatus: status,
            ok,
            embedCount: embeds.length,
            attachmentCount: attachments.length,
            movieDropCount: movieCandidates.length,
            tvDropCount: tvCandidates.length,
            movieProtectedCount: movieProtected.length,
            tvProtectedCount: tvProtected.length,
          };

          const handle = await context.writeResource(
            "notification_log",
            "notification_log",
            log,
          );
          if (!ok) {
            const body = m ? raw.slice(0, m.index) : raw;
            throw new Error(
              `Discord webhook returned HTTP ${status}: ${body.slice(0, 400)}`,
            );
          }
          return { dataHandles: [handle] };
        } finally {
          try {
            await Deno.remove(tmpDir, { recursive: true });
          } catch {
            // best-effort cleanup
          }
        }
      },
    },
  },
};
