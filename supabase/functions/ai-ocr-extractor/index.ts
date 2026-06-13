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
  `You are an OCR extraction specialist for Wilson Marketing Group. ` +
  `Extract structured data from invoices and BOLs. Return JSON only, no prose.`;

const ALLOWED_MEDIA_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
]);

type OcrStatus = "completed" | "review" | "manual";
type MediaType = "application/pdf" | "image/jpeg" | "image/png";

interface LineItem {
  description?: string;
  quantity?: number | null;
  unit?: string;
  amount?: number | null;
}

interface OcrExtracted {
  control_number: string;
  vendor_name: string;
  commodity: string;
  quantity_tons: number | null;
  total_amount: number | null;
  due_date: string;
  invoice_date: string;
  line_items: LineItem[];
}

interface ClaudeOcrResult {
  document_type: "invoice" | "bol" | "other";
  confidence: number;
  extracted: OcrExtracted;
}

interface ExtractRequest {
  inbound_email_id: string;
  attachment_base64: string;
  media_type: MediaType;
  filename: string;
}

interface OcrDocumentRecord {
  id: string;
  inbound_email_id: string;
  filename: string;
  media_type: string;
  document_type: string;
  extracted_data: Record<string, unknown>;
  confidence: number;
  status: OcrStatus;
  processed_at: string;
  created_at: string;
  updated_at: string;
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

function deriveOcrStatus(confidence: number): OcrStatus {
  if (confidence >= 0.95) return "completed";
  if (confidence >= 0.85) return "review";
  return "manual";
}

function normalizeBase64(input: string): string {
  const dataUrlMatch = input.match(/^data:[^;]+;base64,(.+)$/);
  return (dataUrlMatch?.[1] ?? input).replace(/\s/g, "");
}

function buildExtractionPrompt(filename: string): string {
  return [
    `Extract structured data from the attached document (${filename}).`,
    "Return JSON with this exact shape:",
    `{`,
    `  "document_type": "invoice|bol|other",`,
    `  "confidence": 0.0,`,
    `  "extracted": {`,
    `    "control_number": "",`,
    `    "vendor_name": "",`,
    `    "commodity": "",`,
    `    "quantity_tons": null,`,
    `    "total_amount": null,`,
    `    "due_date": "",`,
    `    "invoice_date": "",`,
    `    "line_items": []`,
    `  }`,
    `}`,
  ].join("\n");
}

function buildContentBlock(
  mediaType: MediaType,
  base64Data: string,
): Record<string, unknown> {
  if (mediaType === "application/pdf") {
    return {
      type: "document",
      source: {
        type: "base64",
        media_type: mediaType,
        data: base64Data,
      },
    };
  }

  return {
    type: "image",
    source: {
      type: "base64",
      media_type: mediaType,
      data: base64Data,
    },
  };
}

function parseClaudeJson(text: string): ClaudeOcrResult {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonText = fenceMatch ? fenceMatch[1].trim() : trimmed;

  const parsed = JSON.parse(jsonText) as ClaudeOcrResult;

  if (!parsed.document_type || typeof parsed.confidence !== "number") {
    throw new Error("Claude response missing document_type or confidence");
  }

  parsed.confidence = clampConfidence(parsed.confidence);
  parsed.extracted = {
    control_number: parsed.extracted?.control_number ?? "",
    vendor_name: parsed.extracted?.vendor_name ?? "",
    commodity: parsed.extracted?.commodity ?? "",
    quantity_tons: parsed.extracted?.quantity_tons ?? null,
    total_amount: parsed.extracted?.total_amount ?? null,
    due_date: parsed.extracted?.due_date ?? "",
    invoice_date: parsed.extracted?.invoice_date ?? "",
    line_items: Array.isArray(parsed.extracted?.line_items)
      ? parsed.extracted.line_items
      : [],
  };

  return parsed;
}

async function extractWithClaude(
  request: ExtractRequest,
): Promise<ClaudeOcrResult> {
  const apiKey = getAnthropicApiKey();
  const base64Data = normalizeBase64(request.attachment_base64);

  const response = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            buildContentBlock(request.media_type, base64Data),
            {
              type: "text",
              text: buildExtractionPrompt(request.filename),
            },
          ],
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

function validateRequest(body: ExtractRequest): void {
  if (!body.inbound_email_id) {
    throw new Error('Missing required field: "inbound_email_id"');
  }
  if (!body.attachment_base64) {
    throw new Error('Missing required field: "attachment_base64"');
  }
  if (!body.media_type || !ALLOWED_MEDIA_TYPES.has(body.media_type)) {
    throw new Error(
      'Invalid media_type — must be application/pdf, image/jpeg, or image/png',
    );
  }
  if (!body.filename) {
    throw new Error('Missing required field: "filename"');
  }
}

async function verifyInboundEmail(inboundEmailId: string): Promise<void> {
  const supabase = createServiceRoleClient();

  const { data, error } = await supabase
    .from("inbound_email_routing")
    .select("id")
    .eq("id", inboundEmailId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to verify inbound email: ${error.message}`);
  }
  if (!data) {
    throw new Error(`Inbound email not found: ${inboundEmailId}`);
  }
}

function buildExtractedData(result: ClaudeOcrResult): Record<string, unknown> {
  return {
    document_type: result.document_type,
    confidence: result.confidence,
    extracted: result.extracted,
  };
}

function mapDbRowToRecord(
  row: Record<string, unknown>,
): OcrDocumentRecord {
  const extractedData = (row.extracted_data ?? {}) as Record<string, unknown>;

  return {
    id: row.id as string,
    inbound_email_id:
      (row.inbound_email_id as string) ??
      (extractedData.inbound_email_id as string) ??
      "",
    filename: (row.source_filename as string) ?? "",
    media_type:
      (row.media_type as string) ??
      (extractedData.media_type as string) ??
      "",
    document_type: row.document_type as string,
    extracted_data: extractedData,
    confidence: Number(row.confidence_score ?? 0),
    status: row.ocr_status as OcrStatus,
    processed_at: row.processed_at as string,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

async function insertOcrDocument(
  request: ExtractRequest,
  result: ClaudeOcrResult,
): Promise<OcrDocumentRecord> {
  const supabase = createServiceRoleClient();
  const status = deriveOcrStatus(result.confidence);
  const processedAt = new Date().toISOString();

  const { data, error } = await supabase
    .from("ocr_documents")
    .insert({
      inbound_email_id: request.inbound_email_id,
      media_type: request.media_type,
      document_type: result.document_type,
      source_filename: request.filename,
      ocr_status: status,
      extracted_data: buildExtractedData(result),
      confidence_score: result.confidence,
      processed_at: processedAt,
    })
    .select("*")
    .single();

  if (error) {
    throw new Error(`Failed to insert OCR document: ${error.message}`);
  }

  return mapDbRowToRecord(data as Record<string, unknown>);
}

async function handleExtract(
  body: ExtractRequest,
  persist: boolean,
): Promise<Response> {
  validateRequest(body);

  if (persist) {
    await verifyInboundEmail(body.inbound_email_id);
  }

  const result = await extractWithClaude(body);
  const status = deriveOcrStatus(result.confidence);

  if (!persist) {
    return jsonResponse({
      inbound_email_id: body.inbound_email_id,
      media_type: body.media_type,
      filename: body.filename,
      document_type: result.document_type,
      confidence: result.confidence,
      status,
      extracted_data: buildExtractedData(result),
    });
  }

  const record = await insertOcrDocument(body, result);
  return jsonResponse(record);
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
    const contentType = req.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      return jsonResponse({ error: "Expected application/json" }, 400);
    }

    const body = (await req.json()) as ExtractRequest;
    return await handleExtract(body, !isTestPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ error: message }, 500);
  }
});
