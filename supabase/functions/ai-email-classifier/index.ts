import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const CLAUDE_MODEL = "claude-sonnet-4-6";
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

const SYSTEM_PROMPT =
  `You are an email classifier for Wilson Marketing Group, ` +
  `a commodity management company. Classify emails and extract structured data. ` +
  `Return JSON only, no prose.`;

const DB_CLASSIFICATIONS = new Set([
  "invoice",
  "load_order",
  "pickup_verification",
]);

type DbClassification = "invoice" | "load_order" | "pickup_verification";

interface ExtractedData {
  sender_company: string;
  reference_number: string;
  commodity: string;
  tonnage: number | null;
  amount: number | null;
  date: string;
  notes: string;
}

interface ClaudeClassificationResult {
  classification: "invoice" | "load_order" | "pickup_verification" | "other";
  confidence: number;
  extracted: ExtractedData;
}

interface InboundEmailRecord {
  id: string;
  to_address: string;
  from_address: string | null;
  subject: string | null;
  raw_body: string | null;
  classification: string | null;
  confidence: number | null;
}

interface ProcessedRecordSummary {
  id: string;
  classification: string;
  confidence: number;
  status: "processed" | "failed";
  error?: string;
}

interface TestClassifyBody {
  subject?: string;
  raw_body?: string;
  from_address?: string;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function createServiceRoleClient() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    db: { schema: "app" },
  });
}

function getAnthropicApiKey(): string {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    throw new Error("Missing ANTHROPIC_API_KEY");
  }
  return apiKey;
}

function clampConfidence(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function toDbClassification(
  classification: string,
): DbClassification | null {
  if (DB_CLASSIFICATIONS.has(classification)) {
    return classification as DbClassification;
  }
  return null;
}

function parseClaudeJson(text: string): ClaudeClassificationResult {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonText = fenceMatch ? fenceMatch[1].trim() : trimmed;

  const parsed = JSON.parse(jsonText) as ClaudeClassificationResult;

  if (!parsed.classification || typeof parsed.confidence !== "number") {
    throw new Error("Claude response missing classification or confidence");
  }

  parsed.confidence = clampConfidence(parsed.confidence);
  parsed.extracted = {
    sender_company: parsed.extracted?.sender_company ?? "",
    reference_number: parsed.extracted?.reference_number ?? "",
    commodity: parsed.extracted?.commodity ?? "",
    tonnage: parsed.extracted?.tonnage ?? null,
    amount: parsed.extracted?.amount ?? null,
    date: parsed.extracted?.date ?? "",
    notes: parsed.extracted?.notes ?? "",
  };

  return parsed;
}

function buildUserPrompt(record: {
  subject: string | null;
  raw_body: string | null;
  from_address?: string | null;
}): string {
  return [
    "Classify this inbound email and extract structured data.",
    "Return JSON with this exact shape:",
    `{`,
    `  "classification": "invoice|load_order|pickup_verification|other",`,
    `  "confidence": 0.0,`,
    `  "extracted": {`,
    `    "sender_company": "",`,
    `    "reference_number": "",`,
    `    "commodity": "",`,
    `    "tonnage": null,`,
    `    "amount": null,`,
    `    "date": "",`,
    `    "notes": ""`,
    `  }`,
    `}`,
    "",
    `From: ${record.from_address ?? "(unknown)"}`,
    `Subject: ${record.subject ?? "(no subject)"}`,
    "",
    "Body:",
    record.raw_body ?? "(empty body)",
  ].join("\n");
}

async function classifyWithClaude(record: {
  subject: string | null;
  raw_body: string | null;
  from_address?: string | null;
}): Promise<ClaudeClassificationResult> {
  const apiKey = getAnthropicApiKey();

  const response = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: buildUserPrompt(record),
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Anthropic API error (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const content = data.content?.[0]?.text;

  if (typeof content !== "string") {
    throw new Error("Anthropic API returned no text content");
  }

  return parseClaudeJson(content);
}

async function fetchUnprocessedRecords(): Promise<InboundEmailRecord[]> {
  const supabase = createServiceRoleClient();

  const { data, error } = await supabase
    .from("inbound_email_routing")
    .select("id, to_address, from_address, subject, raw_body, classification, confidence")
    .eq("processed", false)
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(`Failed to fetch unprocessed records: ${error.message}`);
  }

  return (data ?? []) as InboundEmailRecord[];
}

async function updateProcessedRecord(
  id: string,
  result: ClaudeClassificationResult,
): Promise<void> {
  const supabase = createServiceRoleClient();
  const dbClassification = toDbClassification(result.classification);
  const processedAt = new Date().toISOString();

  const { error } = await supabase
    .from("inbound_email_routing")
    .update({
      classification: dbClassification,
      confidence: result.confidence,
      processed: true,
      processed_at: processedAt,
    })
    .eq("id", id);

  if (error) {
    throw new Error(`Failed to update record ${id}: ${error.message}`);
  }
}

async function queueInternalNotification(
  record: InboundEmailRecord,
  result: ClaudeClassificationResult,
): Promise<void> {
  const supabase = createServiceRoleClient();

  const subject =
    `Inbound email classified: ${result.classification} — ${record.subject ?? "(no subject)"}`;

  const body = JSON.stringify(
    {
      inbound_email_id: record.id,
      to_address: record.to_address,
      from_address: record.from_address,
      claude_classification: result.classification,
      stored_classification: toDbClassification(result.classification),
      confidence: result.confidence,
      extracted: result.extracted,
    },
    null,
    2,
  );

  const { error } = await supabase.from("outbound_notification_log").insert({
    recipient_user_id: null,
    recipient_email: null,
    recipient_phone: null,
    channel: "email",
    notification_type: "load_status",
    subject,
    body,
    status: "queued",
    related_entity_type: null,
    related_entity_id: null,
    sent_at: null,
  });

  if (error) {
    throw new Error(
      `Failed to queue internal notification for ${record.id}: ${error.message}`,
    );
  }
}

async function processRecord(
  record: InboundEmailRecord,
): Promise<ProcessedRecordSummary> {
  try {
    const result = await classifyWithClaude({
      subject: record.subject,
      raw_body: record.raw_body,
      from_address: record.from_address,
    });

    await updateProcessedRecord(record.id, result);
    await queueInternalNotification(record, result);

    return {
      id: record.id,
      classification: result.classification,
      confidence: result.confidence,
      status: "processed",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      id: record.id,
      classification: record.classification ?? "unknown",
      confidence: record.confidence ?? 0,
      status: "failed",
      error: message,
    };
  }
}

async function runClassifier(): Promise<Response> {
  const records = await fetchUnprocessedRecords();

  if (records.length === 0) {
    return jsonResponse({
      processed_count: 0,
      failed_count: 0,
      records: [],
    });
  }

  const summaries: ProcessedRecordSummary[] = [];

  for (const record of records) {
    summaries.push(await processRecord(record));
  }

  const processed_count = summaries.filter((s) => s.status === "processed").length;
  const failed_count = summaries.filter((s) => s.status === "failed").length;

  return jsonResponse({
    processed_count,
    failed_count,
    records: summaries,
  });
}

async function handleTestClassify(body: TestClassifyBody): Promise<Response> {
  const result = await classifyWithClaude({
    subject: body.subject ?? null,
    raw_body: body.raw_body ?? null,
    from_address: body.from_address ?? null,
  });

  return jsonResponse({
    ...result,
    stored_classification: toDbClassification(result.classification),
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const url = new URL(req.url);
  const isTestPath = url.pathname.endsWith("/test");

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  try {
    if (isTestPath) {
      const contentType = req.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) {
        return jsonResponse(
          { error: "Test endpoint expects application/json" },
          400,
        );
      }

      const body = (await req.json()) as TestClassifyBody;
      return await handleTestClassify(body);
    }

    return await runClassifier();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ error: message }, 500);
  }
});
