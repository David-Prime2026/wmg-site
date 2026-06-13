import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Classification = "invoice" | "load_order" | "pickup_verification";

const TO_ADDRESS_CLASSIFICATION: Record<string, Classification> = {
  "invoices@wilsonmarketing.com": "invoice",
  "orders@wilsonmarketing.com": "load_order",
  "pickup@wilsonmarketing.com": "pickup_verification",
};

interface ParsedEmail {
  to: string;
  from: string;
  subject: string;
  text: string;
  html: string;
  attachments: Array<{ name: string; type: string; size: number }>;
}

interface InboundEmailRoutingInsert {
  to_address: string;
  from_address: string | null;
  subject: string | null;
  raw_body: string | null;
  classification: Classification | null;
  confidence: number;
  processed: boolean;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function extractEmail(value: string): string {
  const trimmed = value.trim();
  const angleMatch = trimmed.match(/<([^>]+)>/);
  if (angleMatch) {
    return angleMatch[1].trim().toLowerCase();
  }
  const emailMatch = trimmed.match(/[\w.+-]+@[\w.-]+\.\w+/);
  return (emailMatch?.[0] ?? trimmed).toLowerCase();
}

function classifyByToAddress(
  to: string,
): { classification: Classification | null; confidence: number } {
  const email = extractEmail(to);
  const classification = TO_ADDRESS_CLASSIFICATION[email] ?? null;
  return {
    classification,
    confidence: classification ? 1.0 : 0,
  };
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

async function insertInboundEmailRouting(
  payload: InboundEmailRoutingInsert,
): Promise<string> {
  const supabase = createServiceRoleClient();

  const { data, error } = await supabase
    .from("inbound_email_routing")
    .insert(payload)
    .select("id")
    .single();

  if (error) {
    throw new Error(`Failed to insert inbound email routing: ${error.message}`);
  }

  return data.id as string;
}

function getStringField(formData: FormData, key: string): string {
  const value = formData.get(key);
  if (typeof value === "string") {
    return value;
  }
  return "";
}

function parseAttachments(
  formData: FormData,
): Array<{ name: string; type: string; size: number }> {
  const attachments: Array<{ name: string; type: string; size: number }> = [];
  const seen = new Set<string>();

  for (const [key, value] of formData.entries()) {
    if (!(value instanceof File) || value.size === 0) {
      continue;
    }

    const name = value.name || key;
    if (seen.has(name)) {
      continue;
    }

    seen.add(name);
    attachments.push({
      name,
      type: value.type || "application/octet-stream",
      size: value.size,
    });
  }

  return attachments;
}

async function parseSendGridPayload(req: Request): Promise<ParsedEmail> {
  const contentType = req.headers.get("content-type") ?? "";

  if (!contentType.includes("multipart/form-data")) {
    throw new Error("Expected multipart/form-data from SendGrid Inbound Parse");
  }

  const formData = await req.formData();

  return {
    to: getStringField(formData, "to"),
    from: getStringField(formData, "from"),
    subject: getStringField(formData, "subject"),
    text: getStringField(formData, "text"),
    html: getStringField(formData, "html"),
    attachments: parseAttachments(formData),
  };
}

interface TestEmailBody {
  to?: string;
  from?: string;
  subject?: string;
  body?: string;
}

function parseTestPayload(body: TestEmailBody): ParsedEmail {
  if (!body.to) {
    throw new Error('Missing required field: "to"');
  }

  return {
    to: body.to,
    from: body.from ?? "",
    subject: body.subject ?? "",
    text: body.body ?? "",
    html: "",
    attachments: [],
  };
}

async function handleInboundEmail(email: ParsedEmail): Promise<Response> {
  if (!email.to) {
    return jsonResponse({ error: 'Missing required field: "to"' }, 400);
  }

  const { classification, confidence } = classifyByToAddress(email.to);
  const rawBody = email.text || email.html || null;

  const id = await insertInboundEmailRouting({
    to_address: email.to,
    from_address: email.from || null,
    subject: email.subject || null,
    raw_body: rawBody,
    classification,
    confidence,
    processed: false,
  });

  return jsonResponse({
    id,
    classification,
    attachment_count: email.attachments.length,
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

      const body = (await req.json()) as TestEmailBody;
      const email = parseTestPayload(body);
      return await handleInboundEmail(email);
    }

    const email = await parseSendGridPayload(req);
    return await handleInboundEmail(email);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ error: message }, 500);
  }
});
