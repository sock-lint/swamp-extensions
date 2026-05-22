/**
 * `@lint/home-assistant` — Home Assistant control-API wrapper for swamp.
 *
 * Connects to a [Home Assistant](https://www.home-assistant.io/) instance over
 * its REST API and exposes two slices of functionality:
 *
 * 1. **Automation lifecycle** — `sync`, `upsertAutomation`, `deleteAutomation`,
 *    `setEnabled`, and `trigger` cover the full CRUD lifecycle for HA
 *    automations created via the UI/REST API (those with a stable `id`).
 *    YAML-only automations are surfaced in the inventory but cannot be edited
 *    through the REST config endpoint and are flagged as `yamlOnly`.
 *
 * 2. **Generic service actuation** — `callService` is a thin wrapper around
 *    `POST /api/services/<domain>/<service>`. Use it to actuate the house
 *    from a swamp workflow: turn on a light when a deploy completes, push
 *    a phone notification via `notify.mobile_app_*`, create an in-HA banner
 *    via `persistent_notification.create`, queue a media item via
 *    `media_player.play_media`, etc.
 *
 * Both styles of service-call targeting are supported:
 * - `target` block (preferred) — accepts `entity_id`, `area_id`, `device_id`
 *   (string or array). Use this for entity-aware domains like `light.*`,
 *   `switch.*`, `climate.*`, `media_player.*`.
 * - `serviceData` (flat) — merged at the top level of the body. Use this for
 *   services that take flat keys (`notify.*` wants `message`/`title`,
 *   `persistent_notification.create` wants `message`/`title`/`notification_id`,
 *   automations want `entity_id` and `skip_condition`).
 *
 * Auth is the standard HA long-lived access token, passed as
 * `Authorization: Bearer <token>` on every request. Generate one from your HA
 * profile page: https://www.home-assistant.io/docs/authentication/.
 *
 * Transport is `curl` via `Deno.Command`, so any failing call can be replayed
 * as a one-line shell command using the same `baseUrl` + token.
 */
import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  baseUrl: z.string().describe(
    "HA base URL, e.g. http://homeassistant.local:8123 (no trailing slash)",
  ),
  accessToken: z.string().describe(
    "Long-lived access token (vault-resolved). Generate from HA profile.",
  ),
  requestTimeoutSec: z.number().default(15),
});

const AutomationSchema = z.object({
  entity_id: z.string(),
  id: z.string().nullable().describe(
    "HA automation id (null if YAML-only / unmanageable via REST)",
  ),
  alias: z.string(),
  state: z.string().describe("on | off | unavailable"),
  last_triggered: z.string().nullable(),
  mode: z.string().nullable(),
  current: z.number().nullable(),
  max: z.number().nullable(),
});

const InventorySchema = z.object({
  fetchedAt: z.iso.datetime(),
  baseUrl: z.string(),
  automations: z.array(AutomationSchema),
});

const SummarySchema = z.object({
  fetchedAt: z.iso.datetime(),
  baseUrl: z.string(),
  totalCount: z.number(),
  onCount: z.number(),
  offCount: z.number(),
  unavailableCount: z.number(),
  managedCount: z.number().describe(
    "Automations with an id — manageable via /api/config/automation/config/<id>",
  ),
  yamlOnlyCount: z.number(),
  recentlyTriggered: z.array(z.object({
    entity_id: z.string(),
    alias: z.string(),
    last_triggered: z.string(),
  })).describe("Top 5 most-recently-triggered"),
});

const SyncLogSchema = z.object({
  ranAt: z.iso.datetime(),
  method: z.string(),
  ok: z.boolean(),
  httpStatus: z.number().nullable(),
  totalFetched: z.number().nullable(),
  detail: z.string().nullable(),
});

// Swamp wires args/context at runtime; the model loader doesn't expose types.
// deno-lint-ignore no-explicit-any
type ExecuteArgs = any;
// deno-lint-ignore no-explicit-any
type ExecuteContext = any;

/** Issue an HTTP request via `curl` and return `{ status, body }`. */
async function curlReq(
  method: "GET" | "POST" | "DELETE",
  url: string,
  headers: string[],
  body?: string,
  timeoutSec = 15,
): Promise<{ status: number; body: string }> {
  const args = ["-sS", "-X", method, "-m", String(timeoutSec)];
  for (const h of headers) args.push("-H", h);
  args.push("-w", "\n__HTTP_STATUS__:%{http_code}");
  if (body != null) args.push("--data-binary", "@-");
  args.push(url);
  const cmd = new Deno.Command("curl", {
    args,
    stdin: body != null ? "piped" : "null",
    stdout: "piped",
    stderr: "piped",
  });
  const proc = cmd.spawn();
  if (body != null) {
    const w = proc.stdin.getWriter();
    await w.write(new TextEncoder().encode(body));
    await w.close();
  }
  const { code, stdout, stderr } = await proc.output();
  if (code !== 0) {
    throw new Error(
      `curl ${method} ${url} exit=${code}: ${new TextDecoder().decode(stderr)}`,
    );
  }
  const out = new TextDecoder().decode(stdout);
  const m = out.match(/__HTTP_STATUS__:(\d+)\s*$/);
  return {
    status: m ? parseInt(m[1], 10) : -1,
    body: m ? out.slice(0, m.index).trimEnd() : out,
  };
}

function haHeaders(token: string, contentType = false): string[] {
  const h = [`Authorization: Bearer ${token}`, "Accept: application/json"];
  if (contentType) h.push("Content-Type: application/json");
  return h;
}

async function haGet(
  base: string,
  token: string,
  path: string,
  timeoutSec: number,
  // deno-lint-ignore no-explicit-any
): Promise<{ status: number; json: any }> {
  const r = await curlReq(
    "GET",
    base.replace(/\/$/, "") + path,
    haHeaders(token),
    undefined,
    timeoutSec,
  );
  // deno-lint-ignore no-explicit-any
  let json: any = null;
  try {
    json = JSON.parse(r.body);
  } catch { /* leave null */ }
  return { status: r.status, json };
}

async function haPost(
  base: string,
  token: string,
  path: string,
  body: unknown,
  timeoutSec: number,
  // deno-lint-ignore no-explicit-any
): Promise<{ status: number; json: any; raw: string }> {
  const r = await curlReq(
    "POST",
    base.replace(/\/$/, "") + path,
    haHeaders(token, true),
    JSON.stringify(body),
    timeoutSec,
  );
  // deno-lint-ignore no-explicit-any
  let json: any = null;
  try {
    json = JSON.parse(r.body);
  } catch { /* leave null */ }
  return { status: r.status, json, raw: r.body };
}

async function haDelete(
  base: string,
  token: string,
  path: string,
  timeoutSec: number,
): Promise<{ status: number; raw: string }> {
  const r = await curlReq(
    "DELETE",
    base.replace(/\/$/, "") + path,
    haHeaders(token),
    undefined,
    timeoutSec,
  );
  return { status: r.status, raw: r.body };
}

/** Project an HA `/api/states` automation entry into the schema shape. */
// deno-lint-ignore no-explicit-any
function pickAutomation(state: any): z.infer<typeof AutomationSchema> {
  const a = state?.attributes || {};
  return {
    entity_id: state.entity_id,
    id: typeof a.id === "string" ? a.id : null,
    alias: typeof a.friendly_name === "string"
      ? a.friendly_name
      : state.entity_id.replace(/^automation\./, ""),
    state: state.state,
    last_triggered: typeof a.last_triggered === "string"
      ? a.last_triggered
      : null,
    mode: typeof a.mode === "string" ? a.mode : null,
    current: typeof a.current === "number" ? a.current : null,
    max: typeof a.max === "number" ? a.max : null,
  };
}

/** Tell HA to reread automation configs after a config-API edit. */
async function reloadAutomations(
  base: string,
  token: string,
  timeoutSec: number,
): Promise<void> {
  const r = await haPost(
    base,
    token,
    "/api/services/automation/reload",
    {},
    timeoutSec,
  );
  if (r.status < 200 || r.status >= 300) {
    throw new Error(
      `automation/reload failed: ${r.status} ${r.raw.slice(0, 200)}`,
    );
  }
}

/** Guard automation ids against URL-path injection. */
function requireId(id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error(
      `automation id must match [A-Za-z0-9_-]+, got: ${JSON.stringify(id)}`,
    );
  }
  return id;
}

/** Guard HA domain/service names against URL-path injection. */
function requireServiceName(label: string, value: string): string {
  if (!/^[a-z0-9_]+$/.test(value)) {
    throw new Error(
      `${label} must match [a-z0-9_]+, got: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** Swamp model definition for `@lint/home-assistant`. */
export const model: {
  type: string;
  version: string;
  reports: string[];
  resources: Record<string, unknown>;
  globalArguments: unknown;
  methods: Record<string, unknown>;
} = {
  type: "@lint/home-assistant",
  version: "2026.05.22.1",
  reports: [],
  globalArguments: GlobalArgsSchema,
  resources: {
    "inventory": {
      description:
        "Current list of HA automations (entity_id, id, alias, state, last_triggered, mode).",
      schema: InventorySchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    "summary": {
      description:
        "Compact summary of automation state — counts + recently-triggered list.",
      schema: SummarySchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    "sync_log": {
      description:
        "Per-method audit (sync, upsertAutomation, deleteAutomation, setEnabled, trigger, callService).",
      schema: SyncLogSchema,
      lifetime: "infinite",
      garbageCollection: 30,
    },
  },
  methods: {
    sync: {
      description:
        "Fetch all automations from /api/states, build inventory + summary.",
      arguments: z.object({}),
      execute: async (_args: ExecuteArgs, context: ExecuteContext) => {
        const { baseUrl, accessToken, requestTimeoutSec } = context.globalArgs;
        const now = new Date().toISOString();
        const r = await haGet(
          baseUrl,
          accessToken,
          "/api/states",
          requestTimeoutSec,
        );
        if (r.status < 200 || r.status >= 300 || !Array.isArray(r.json)) {
          const log: z.infer<typeof SyncLogSchema> = {
            ranAt: now,
            method: "sync",
            ok: false,
            httpStatus: r.status,
            totalFetched: null,
            detail: `GET /api/states failed: ${r.status}`,
          };
          await context.writeResource("sync_log", "sync_log", log);
          throw new Error(log.detail!);
        }
        const automations = r.json
          // deno-lint-ignore no-explicit-any
          .filter((s: any) =>
            typeof s?.entity_id === "string" &&
            s.entity_id.startsWith("automation.")
          )
          .map(pickAutomation)
          .sort((a, b) => a.alias.localeCompare(b.alias));

        const inv: z.infer<typeof InventorySchema> = {
          fetchedAt: now,
          baseUrl,
          automations,
        };
        const onCount = automations.filter((a) => a.state === "on").length;
        const offCount = automations.filter((a) => a.state === "off").length;
        const unavailableCount =
          automations.filter((a) => a.state === "unavailable").length;
        const managedCount = automations.filter((a) => a.id != null).length;
        const yamlOnlyCount = automations.length - managedCount;
        const recentlyTriggered = automations
          .filter((a) => a.last_triggered)
          .sort((a, b) =>
            (b.last_triggered || "").localeCompare(a.last_triggered || "")
          )
          .slice(0, 5)
          .map((a) => ({
            entity_id: a.entity_id,
            alias: a.alias,
            last_triggered: a.last_triggered as string,
          }));

        const summary: z.infer<typeof SummarySchema> = {
          fetchedAt: now,
          baseUrl,
          totalCount: automations.length,
          onCount,
          offCount,
          unavailableCount,
          managedCount,
          yamlOnlyCount,
          recentlyTriggered,
        };
        const log: z.infer<typeof SyncLogSchema> = {
          ranAt: now,
          method: "sync",
          ok: true,
          httpStatus: r.status,
          totalFetched: automations.length,
          detail: null,
        };

        const h1 = await context.writeResource("inventory", "inventory", inv);
        const h2 = await context.writeResource("summary", "summary", summary);
        const h3 = await context.writeResource("sync_log", "sync_log", log);
        return { dataHandles: [h1, h2, h3] };
      },
    },

    upsertAutomation: {
      description:
        "Create or update an automation via /api/config/automation/config/<id>. Calls automation/reload afterward. Idempotent — re-running with the same body is a no-op.",
      arguments: z.object({
        id: z.string().describe(
          "Automation id (URL slug, [A-Za-z0-9_-]+). Required.",
        ),
        alias: z.string().describe("Display name"),
        description: z.string().optional(),
        trigger: z.any().describe(
          "HA trigger list (loose schema; HA validates server-side)",
        ),
        condition: z.any().optional(),
        action: z.any().describe("HA action list"),
        mode: z.enum(["single", "restart", "queued", "parallel"]).default(
          "single",
        ),
        max: z.number().optional(),
        initial_state: z.boolean().optional(),
      }),
      execute: async (args: ExecuteArgs, context: ExecuteContext) => {
        const { baseUrl, accessToken, requestTimeoutSec } = context.globalArgs;
        const id = requireId(args.id);
        const body: Record<string, unknown> = {
          id,
          alias: args.alias,
          mode: args.mode,
          trigger: args.trigger,
          action: args.action,
        };
        if (args.description != null) body.description = args.description;
        if (args.condition != null) body.condition = args.condition;
        if (args.max != null) body.max = args.max;
        if (args.initial_state != null) body.initial_state = args.initial_state;

        const r = await haPost(
          baseUrl,
          accessToken,
          `/api/config/automation/config/${encodeURIComponent(id)}`,
          body,
          requestTimeoutSec,
        );
        const now = new Date().toISOString();
        if (r.status < 200 || r.status >= 300) {
          const log: z.infer<typeof SyncLogSchema> = {
            ranAt: now,
            method: "upsertAutomation",
            ok: false,
            httpStatus: r.status,
            totalFetched: null,
            detail: `POST config/${id} -> ${r.status}: ${r.raw.slice(0, 200)}`,
          };
          await context.writeResource("sync_log", "sync_log", log);
          throw new Error(log.detail!);
        }
        await reloadAutomations(baseUrl, accessToken, requestTimeoutSec);
        const log: z.infer<typeof SyncLogSchema> = {
          ranAt: now,
          method: "upsertAutomation",
          ok: true,
          httpStatus: r.status,
          totalFetched: null,
          detail: `upserted ${id} (${args.alias})`,
        };
        const h = await context.writeResource("sync_log", "sync_log", log);
        return { dataHandles: [h] };
      },
    },

    deleteAutomation: {
      description:
        "Delete an automation via DELETE /api/config/automation/config/<id>. Calls automation/reload afterward.",
      arguments: z.object({
        id: z.string().describe("Automation id"),
      }),
      execute: async (args: ExecuteArgs, context: ExecuteContext) => {
        const { baseUrl, accessToken, requestTimeoutSec } = context.globalArgs;
        const id = requireId(args.id);
        const r = await haDelete(
          baseUrl,
          accessToken,
          `/api/config/automation/config/${encodeURIComponent(id)}`,
          requestTimeoutSec,
        );
        const now = new Date().toISOString();
        if (r.status < 200 || r.status >= 300) {
          const log: z.infer<typeof SyncLogSchema> = {
            ranAt: now,
            method: "deleteAutomation",
            ok: false,
            httpStatus: r.status,
            totalFetched: null,
            detail: `DELETE config/${id} -> ${r.status}: ${
              r.raw.slice(0, 200)
            }`,
          };
          await context.writeResource("sync_log", "sync_log", log);
          throw new Error(log.detail!);
        }
        await reloadAutomations(baseUrl, accessToken, requestTimeoutSec);
        const log: z.infer<typeof SyncLogSchema> = {
          ranAt: now,
          method: "deleteAutomation",
          ok: true,
          httpStatus: r.status,
          totalFetched: null,
          detail: `deleted ${id}`,
        };
        const h = await context.writeResource("sync_log", "sync_log", log);
        return { dataHandles: [h] };
      },
    },

    setEnabled: {
      description:
        "Enable or disable a single automation via the automation.turn_on / turn_off service.",
      arguments: z.object({
        entity_id: z.string().describe(
          "Full entity id, e.g. automation.morning_lights",
        ),
        enabled: z.boolean(),
      }),
      execute: async (args: ExecuteArgs, context: ExecuteContext) => {
        const { baseUrl, accessToken, requestTimeoutSec } = context.globalArgs;
        const service = args.enabled ? "turn_on" : "turn_off";
        const r = await haPost(
          baseUrl,
          accessToken,
          `/api/services/automation/${service}`,
          { entity_id: args.entity_id },
          requestTimeoutSec,
        );
        const now = new Date().toISOString();
        const ok = r.status >= 200 && r.status < 300;
        const log: z.infer<typeof SyncLogSchema> = {
          ranAt: now,
          method: "setEnabled",
          ok,
          httpStatus: r.status,
          totalFetched: null,
          detail: ok
            ? `${args.entity_id} -> ${service}`
            : `${service} ${args.entity_id} -> ${r.status}: ${
              r.raw.slice(0, 200)
            }`,
        };
        const h = await context.writeResource("sync_log", "sync_log", log);
        if (!ok) throw new Error(log.detail!);
        return { dataHandles: [h] };
      },
    },

    trigger: {
      description:
        "Manually fire an automation via the automation.trigger service.",
      arguments: z.object({
        entity_id: z.string(),
        skip_condition: z.boolean().default(true).describe(
          "Skip the automation's `condition:` block (HA default for service-based triggering)",
        ),
      }),
      execute: async (args: ExecuteArgs, context: ExecuteContext) => {
        const { baseUrl, accessToken, requestTimeoutSec } = context.globalArgs;
        const r = await haPost(
          baseUrl,
          accessToken,
          "/api/services/automation/trigger",
          {
            entity_id: args.entity_id,
            skip_condition: args.skip_condition,
          },
          requestTimeoutSec,
        );
        const now = new Date().toISOString();
        const ok = r.status >= 200 && r.status < 300;
        const log: z.infer<typeof SyncLogSchema> = {
          ranAt: now,
          method: "trigger",
          ok,
          httpStatus: r.status,
          totalFetched: null,
          detail: ok
            ? `triggered ${args.entity_id}`
            : `trigger ${args.entity_id} -> ${r.status}: ${
              r.raw.slice(0, 200)
            }`,
        };
        const h = await context.writeResource("sync_log", "sync_log", log);
        if (!ok) throw new Error(log.detail!);
        return { dataHandles: [h] };
      },
    },

    callService: {
      description:
        "Call any HA service via POST /api/services/<domain>/<service>. Use `target` for entity/area/device-based services (light.*, switch.*, climate.*); use `serviceData` for flat top-level keys (notify.*, persistent_notification.*, automation.*).",
      arguments: z.object({
        domain: z.string().describe(
          "HA domain, e.g. light, notify, media_player, script, scene, persistent_notification",
        ),
        service: z.string().describe(
          "Service name, e.g. turn_on, mobile_app_phone, play_media, create",
        ),
        target: z.object({
          entity_id: z.union([z.string(), z.array(z.string())]).optional(),
          area_id: z.union([z.string(), z.array(z.string())]).optional(),
          device_id: z.union([z.string(), z.array(z.string())]).optional(),
        }).optional().describe(
          "Modern target block — preferred for entity/area/device-aware services.",
        ),
        serviceData: z.any().optional().describe(
          "Flat service-call data merged at top level (e.g. {message, title, brightness_pct}).",
        ),
      }),
      execute: async (args: ExecuteArgs, context: ExecuteContext) => {
        const { baseUrl, accessToken, requestTimeoutSec } = context.globalArgs;
        const domain = requireServiceName("domain", args.domain);
        const service = requireServiceName("service", args.service);
        const body: Record<string, unknown> = { ...(args.serviceData ?? {}) };
        if (args.target) {
          const t: Record<string, unknown> = {};
          if (args.target.entity_id != null) {
            t.entity_id = args.target.entity_id;
          }
          if (args.target.area_id != null) t.area_id = args.target.area_id;
          if (args.target.device_id != null) {
            t.device_id = args.target.device_id;
          }
          if (Object.keys(t).length > 0) body.target = t;
        }
        const r = await haPost(
          baseUrl,
          accessToken,
          `/api/services/${domain}/${service}`,
          body,
          requestTimeoutSec,
        );
        const now = new Date().toISOString();
        const ok = r.status >= 200 && r.status < 300;
        const changedCount = ok && Array.isArray(r.json) ? r.json.length : null;
        const log: z.infer<typeof SyncLogSchema> = {
          ranAt: now,
          method: "callService",
          ok,
          httpStatus: r.status,
          totalFetched: changedCount,
          detail: ok
            ? `${domain}.${service} -> ${r.status} changed=${
              changedCount ?? "?"
            }`
            : `${domain}.${service} -> ${r.status}: ${r.raw.slice(0, 200)}`,
        };
        const h = await context.writeResource("sync_log", "sync_log", log);
        if (!ok) throw new Error(log.detail!);
        return { dataHandles: [h] };
      },
    },
  },
};
