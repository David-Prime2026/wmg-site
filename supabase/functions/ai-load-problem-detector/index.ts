import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const CLAUDE_MODEL = "claude-sonnet-4-6";
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

const SYSTEM_PROMPT =
  `You are an operations analyst for Wilson Marketing Group. ` +
  `Identify problem loads from the ACTUAL load data provided. ` +
  `Flag stuck loads, missing buyer assignments, reroute loops, overdue pickups, ` +
  `and other anomalies. Do not invent loads or problems not supported by the data. ` +
  `Every flagged load must reference a load id from the input. ` +
  `Return JSON only: { "flagged_loads": [{ "load_id": "uuid", "load_number": "...", "reasons": ["..."], "severity": "low|medium|high" }] }`;

interface DetectorRequest {
  load_id?: string;
}

interface LoadAnalysisRecord {
  load: Record<string, unknown>;
  load_state: Record<string, unknown> | null;
  reroutes: Record<string, unknown>[];
  audit_log_entries: Record<string, unknown>[];
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function createServiceRoleClient(): SupabaseClient {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient(supabaseUrl, serviceRoleKey, { db: { schema: "app" } });
}

function getAnthropicApiKey(): string {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY");
  return apiKey;
}

async function fetchActiveLoadRecords(loadId?: string): Promise<LoadAnalysisRecord[]> {
  const supabase = createServiceRoleClient();

  let loadsQuery = supabase.from("loads").select("*");

  if (loadId) {
    loadsQuery = loadsQuery.eq("id", loadId);
  } else {
    const { data: activeStates } = await supabase
      .from("load_states")
      .select("id")
      .eq("is_terminal", false);

    const activeStateIds = (activeStates ?? []).map((s) => s.id as string);
    if (activeStateIds.length === 0) return [];

    loadsQuery = loadsQuery.in("load_state_id", activeStateIds);
  }

  const { data: loads, error: loadsError } = await loadsQuery;
  if (loadsError) throw new Error(`Failed to fetch loads: ${loadsError.message}`);

  const records: LoadAnalysisRecord[] = [];

  for (const load of loads ?? []) {
    const { data: loadState } = await supabase
      .from("load_states")
      .select("*")
      .eq("id", load.load_state_id)
      .maybeSingle();

    const { data: reroutes } = await supabase
      .from("reroutes")
      .select("*")
      .eq("load_id", load.id)
      .order("created_at", { ascending: false });

    const { data: auditEntries } = await supabase
      .from("audit_log_entries")
      .select("*")
      .eq("entity_type", "load")
      .eq("entity_id", load.id)
      .order("created_at", { ascending: false })
      .limit(20);

    records.push({
      load,
      load_state: loadState,
      reroutes: reroutes ?? [],
      audit_log_entries: auditEntries ?? [],
    });
  }

  return records;
}

async function callClaude(records: LoadAnalysisRecord[]): Promise<{
  flagged_loads: Array<{
    load_id: string;
    load_number?: string;
    reasons: string[];
    severity: string;
  }>;
}> {
  const payload = records.map((r) => ({
    load: r.load,
    load_state: r.load_state,
    reroutes: r.reroutes,
    audit_log_entries: r.audit_log_entries,
  }));

  const response = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": getAnthropicApiKey(),
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: [
          "Analyze ONLY these real load records. Do not invent loads or problems.",
          JSON.stringify(payload, null, 2),
        ].join("\n"),
      }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic API error (${response.status}): ${await response.text()}`);
  }

  const result = await response.json();
  const text = result.content?.[0]?.text;
  if (typeof text !== "string") throw new Error("Anthropic API returned no text content");

  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const parsed = JSON.parse(fenceMatch ? fenceMatch[1].trim() : trimmed);

  if (!Array.isArray(parsed.flagged_loads)) {
    throw new Error("Claude response missing flagged_loads array");
  }

  const validLoadIds = new Set(records.map((r) => r.load.id as string));
  parsed.flagged_loads = parsed.flagged_loads.filter((flag: { load_id?: string }) =>
    flag.load_id && validLoadIds.has(flag.load_id)
  );

  return parsed;
}

async function fetchInternalUserIds(): Promise<string[]> {
  const supabase = createServiceRoleClient();

  const { data: roles } = await supabase
    .from("roles")
    .select("id")
    .eq("is_internal", true);

  const roleIds = (roles ?? []).map((r) => r.id as string);
  if (roleIds.length === 0) return [];

  const { data: userRoles } = await supabase
    .from("user_roles")
    .select("user_id")
    .in("role_id", roleIds);

  return [...new Set((userRoles ?? []).map((ur) => ur.user_id as string))];
}

async function insertProblemNotifications(
  flaggedLoads: Array<{ load_id: string; load_number?: string; reasons: string[]; severity: string }>,
): Promise<number> {
  const userIds = await fetchInternalUserIds();
  if (userIds.length === 0 || flaggedLoads.length === 0) return 0;

  const supabase = createServiceRoleClient();
  let inserted = 0;

  for (const flag of flaggedLoads) {
    const loadLabel = flag.load_number ?? flag.load_id;
    const primaryReason = flag.reasons[0]?.trim() || "Load problem detected";
    const title = `[${flag.severity}] ${loadLabel}: ${primaryReason}`.slice(0, 120);

    const body = [
      `Load: ${loadLabel}`,
      `Load ID: ${flag.load_id}`,
      `Severity: ${flag.severity}`,
      "",
      "Details:",
      ...flag.reasons.map((reason, index) => `${index + 1}. ${reason}`),
    ].join("\n");

    for (const userId of userIds) {
      const { error } = await supabase.from("notifications").insert({
        user_id: userId,
        title,
        body,
        category: "load_problem",
        entity_type: "load",
        entity_id: flag.load_id,
      });
      if (!error) inserted++;
    }
  }

  return inserted;
}

async function handleDetector(body: DetectorRequest, dryRun: boolean): Promise<Response> {
  const records = await fetchActiveLoadRecords(body.load_id);

  if (records.length === 0) {
    return jsonResponse({
      sufficient_data: false,
      message: body.load_id
        ? `No load found with id ${body.load_id}.`
        : "No active loads found in the database.",
      flagged_loads: [],
    });
  }

  if (dryRun) {
    return jsonResponse({
      sufficient_data: true,
      dry_run: true,
      load_count: records.length,
      loads: records.map((r) => ({
        load_id: r.load.id,
        load_number: r.load.load_number,
        state: r.load_state?.code ?? r.load_state?.name,
        reroute_count: r.reroutes.length,
        audit_entry_count: r.audit_log_entries.length,
      })),
    });
  }

  const analysis = await callClaude(records);
  const notifications_created = await insertProblemNotifications(analysis.flagged_loads);

  return jsonResponse({
    sufficient_data: true,
    load_count: records.length,
    flagged_loads: analysis.flagged_loads,
    notifications_created,
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const isTestPath = new URL(req.url).pathname.endsWith("/test");

  try {
    const contentType = req.headers.get("content-type") ?? "";
    let body: DetectorRequest = {};
    if (contentType.includes("application/json")) {
      const text = await req.text();
      if (text.trim()) body = JSON.parse(text) as DetectorRequest;
    }

    return await handleDetector(body, isTestPath);
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
