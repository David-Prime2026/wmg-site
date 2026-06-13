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
  `You are an internal assistant for Wilson Marketing Group team members ` +
  `(Skip, Kevin, Alisa, Dena). Answer questions about loads, customers, AR, ` +
  `and payments using ONLY the database records provided in context. ` +
  `If the data needed to answer is not in context, say you don't have that ` +
  `record rather than guessing. Never invent customers, amounts, or load details.`;

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface ChatRequest {
  message: string;
  conversation_history?: ChatMessage[];
}

interface ReferencedRecords {
  loads: Record<string, unknown>[];
  crm_accounts: Record<string, unknown>[];
  invoices: Record<string, unknown>[];
  ar_records: Record<string, unknown>[];
  payments: Record<string, unknown>[];
}

const UUID_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;

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

function extractUuids(text: string): string[] {
  return [...new Set(text.match(UUID_RE) ?? [])];
}

function extractInvoiceNumbers(text: string): string[] {
  const matches = text.match(/\b(?:INV|INVOICE)[-#\s]?([A-Z0-9-]+)\b/gi) ?? [];
  const bare = text.match(/\binvoice\s+#?\s*([A-Z0-9-]+)\b/gi) ?? [];
  return [...new Set([...matches, ...bare].map((m) => m.replace(/^invoice\s+#?\s*/i, "").trim()))];
}

function extractLoadNumbers(text: string): string[] {
  const matches = text.match(/\b(?:load|LD)[-#\s]?([A-Z0-9-]+)\b/gi) ?? [];
  return [...new Set(matches.map((m) => m.replace(/^(load|LD)[-#\s]?/i, "").trim()))];
}

function extractNameCandidates(text: string): string[] {
  const quoted = [...text.matchAll(/"([^"]{2,80})"/g)].map((m) => m[1]);
  const capitalized = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3}\b/g) ?? [];
  return [...new Set([...quoted, ...capitalized])].slice(0, 5);
}

async function retrieveContext(message: string): Promise<ReferencedRecords> {
  const supabase = createServiceRoleClient();
  const context: ReferencedRecords = {
    loads: [],
    crm_accounts: [],
    invoices: [],
    ar_records: [],
    payments: [],
  };

  const uuids = extractUuids(message);

  for (const id of uuids) {
    const { data: load } = await supabase.from("loads").select("*").eq("id", id).maybeSingle();
    if (load) context.loads.push(load);

    const { data: invoice } = await supabase.from("invoices").select("*").eq("id", id).maybeSingle();
    if (invoice) context.invoices.push(invoice);

    const { data: ar } = await supabase.from("ar_records").select("*").eq("id", id).maybeSingle();
    if (ar) context.ar_records.push(ar);

    const { data: payment } = await supabase.from("payments").select("*").eq("id", id).maybeSingle();
    if (payment) context.payments.push(payment);

    const { data: account } = await supabase.from("crm_accounts").select("*").eq("id", id).maybeSingle();
    if (account) context.crm_accounts.push(account);
  }

  for (const num of extractInvoiceNumbers(message)) {
    const { data } = await supabase
      .from("invoices")
      .select("*")
      .ilike("invoice_number", `%${num}%`);
    for (const row of data ?? []) {
      if (!context.invoices.some((i) => i.id === row.id)) context.invoices.push(row);
    }
  }

  for (const num of extractLoadNumbers(message)) {
    const { data } = await supabase
      .from("loads")
      .select("*")
      .ilike("load_number", `%${num}%`);
    for (const row of data ?? []) {
      if (!context.loads.some((l) => l.id === row.id)) context.loads.push(row);
    }
  }

  for (const name of extractNameCandidates(message)) {
    const { data } = await supabase
      .from("crm_accounts")
      .select("*")
      .ilike("name", `%${name}%`)
      .limit(5);
    for (const row of data ?? []) {
      if (!context.crm_accounts.some((a) => a.id === row.id)) context.crm_accounts.push(row);
    }
  }

  const loadIds = context.loads.map((l) => l.id as string);
  if (loadIds.length > 0) {
    const { data: invoices } = await supabase.from("invoices").select("*").in("load_id", loadIds);
    for (const row of invoices ?? []) {
      if (!context.invoices.some((i) => i.id === row.id)) context.invoices.push(row);
    }

    const { data: arRecords } = await supabase.from("ar_records").select("*").in("load_id", loadIds);
    for (const row of arRecords ?? []) {
      if (!context.ar_records.some((a) => a.id === row.id)) context.ar_records.push(row);
    }
  }

  const invoiceIds = context.invoices.map((i) => i.id as string);
  if (invoiceIds.length > 0) {
    const { data: arByInvoice } = await supabase
      .from("ar_records")
      .select("*")
      .in("invoice_id", invoiceIds);
    for (const row of arByInvoice ?? []) {
      if (!context.ar_records.some((a) => a.id === row.id)) context.ar_records.push(row);
    }

    const { data: matches } = await supabase
      .from("payment_matching_records")
      .select("*, payments(*)")
      .in("invoice_id", invoiceIds);
    for (const match of matches ?? []) {
      const payment = (match as Record<string, unknown>).payments as Record<string, unknown> | null;
      if (payment && !context.payments.some((p) => p.id === payment.id)) {
        context.payments.push(payment);
      }
    }
  }

  const accountIds = context.crm_accounts.map((a) => a.id as string);
  if (accountIds.length > 0) {
    const { data: buyers } = await supabase
      .from("buyer_accounts")
      .select("id")
      .in("crm_account_id", accountIds);
    const buyerIds = (buyers ?? []).map((b) => b.id as string);
    if (buyerIds.length > 0) {
      const { data: buyerPayments } = await supabase
        .from("payments")
        .select("*")
        .in("buyer_account_id", buyerIds);
      for (const row of buyerPayments ?? []) {
        if (!context.payments.some((p) => p.id === row.id)) context.payments.push(row);
      }
    }
  }

  return context;
}

function hasAnyContext(ctx: ReferencedRecords): boolean {
  return (
    ctx.loads.length > 0 ||
    ctx.crm_accounts.length > 0 ||
    ctx.invoices.length > 0 ||
    ctx.ar_records.length > 0 ||
    ctx.payments.length > 0
  );
}

function summarizeReferences(ctx: ReferencedRecords): Record<string, string[]> {
  return {
    loads: ctx.loads.map((l) => l.id as string),
    crm_accounts: ctx.crm_accounts.map((a) => a.id as string),
    invoices: ctx.invoices.map((i) => i.id as string),
    ar_records: ctx.ar_records.map((a) => a.id as string),
    payments: ctx.payments.map((p) => p.id as string),
  };
}

async function callClaude(
  message: string,
  history: ChatMessage[],
  context: ReferencedRecords,
): Promise<string> {
  const contextBlock = JSON.stringify(context, null, 2);
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [
    ...history.filter((m) => m.role === "user" || m.role === "assistant"),
    {
      role: "user",
      content: [
        "DATABASE RECORDS (use ONLY these — do not invent data):",
        contextBlock,
        "",
        `USER QUESTION: ${message}`,
      ].join("\n"),
    },
  ];

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
      messages,
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic API error (${response.status}): ${await response.text()}`);
  }

  const result = await response.json();
  const text = result.content?.[0]?.text;
  if (typeof text !== "string") throw new Error("Anthropic API returned no text content");
  return text;
}

async function handleChat(body: ChatRequest, dryRun: boolean): Promise<Response> {
  if (!body.message?.trim()) {
    return jsonResponse({ error: 'Missing required field: "message"' }, 400);
  }

  const context = await retrieveContext(body.message);
  const referenced_records = summarizeReferences(context);

  if (!hasAnyContext(context)) {
    return jsonResponse({
      sufficient_data: false,
      message: "No matching loads, customers, invoices, AR records, or payments found for this message.",
      response: "I don't have any matching records in the database for that question. Please provide a load ID, invoice number, or customer name that exists in the system.",
      referenced_records,
    });
  }

  if (dryRun) {
    return jsonResponse({
      sufficient_data: true,
      dry_run: true,
      referenced_records,
      context,
    });
  }

  const response = await callClaude(
    body.message,
    body.conversation_history ?? [],
    context,
  );

  return jsonResponse({
    sufficient_data: true,
    response,
    referenced_records,
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const isTestPath = new URL(req.url).pathname.endsWith("/test");

  try {
    if (!(req.headers.get("content-type") ?? "").includes("application/json")) {
      return jsonResponse({ error: "Expected application/json" }, 400);
    }
    const body = (await req.json()) as ChatRequest;
    return await handleChat(body, isTestPath);
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
