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
  `You are a statement advisor for Wilson Marketing Group. ` +
  `Analyze ONLY the payment and statement data provided. ` +
  `Suggest statement updates, flag overdue items, detect duplicate checks, ` +
  `identify missing payment info. Never invent data not present in the input. ` +
  `If the data is insufficient for a specific suggestion, omit that suggestion. ` +
  `Return JSON only, no prose.`;

interface AdvisorRequest {
  seller_account_id?: string;
  buyer_account_id?: string;
}

interface StatementDataBundle {
  account_type: "seller" | "buyer";
  account_id: string;
  invoices: Record<string, unknown>[];
  payments: Record<string, unknown>[];
  seller_statements: Record<string, unknown>[];
  statement_lines: Record<string, unknown>[];
  ar_records: Record<string, unknown>[];
  adjustments: Record<string, unknown>[];
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

function hasAnyRecords(data: StatementDataBundle): boolean {
  return (
    data.invoices.length > 0 ||
    data.payments.length > 0 ||
    data.seller_statements.length > 0 ||
    data.statement_lines.length > 0 ||
    data.ar_records.length > 0 ||
    data.adjustments.length > 0
  );
}

async function fetchSellerStatementData(
  sellerAccountId: string,
): Promise<StatementDataBundle> {
  const supabase = createServiceRoleClient();

  const { data: loads } = await supabase
    .from("loads")
    .select("id")
    .eq("seller_account_id", sellerAccountId);

  const loadIds = (loads ?? []).map((l) => l.id as string);

  let invoices: Record<string, unknown>[] = [];
  if (loadIds.length > 0) {
    const { data } = await supabase
      .from("invoices")
      .select("*")
      .in("load_id", loadIds);
    invoices = data ?? [];
  }

  const { data: sellerStatements } = await supabase
    .from("seller_statements")
    .select("*")
    .eq("seller_account_id", sellerAccountId);

  const statementIds = (sellerStatements ?? []).map((s) => s.id as string);

  let statementLines: Record<string, unknown>[] = [];
  let adjustments: Record<string, unknown>[] = [];

  if (statementIds.length > 0) {
    const { data: lines } = await supabase
      .from("statement_lines")
      .select("*")
      .in("statement_id", statementIds);
    statementLines = lines ?? [];

    const { data: adj } = await supabase
      .from("adjustments")
      .select("*")
      .in("statement_id", statementIds);
    adjustments = adj ?? [];
  }

  let arRecords: Record<string, unknown>[] = [];
  if (loadIds.length > 0) {
    const { data } = await supabase
      .from("ar_records")
      .select("*")
      .in("load_id", loadIds);
    arRecords = data ?? [];
  }

  let payments: Record<string, unknown>[] = [];
  const invoiceIds = invoices.map((i) => i.id as string);
  if (invoiceIds.length > 0) {
    const { data: matches } = await supabase
      .from("payment_matching_records")
      .select("*, payments(*)")
      .in("invoice_id", invoiceIds);

    const seen = new Set<string>();
    for (const match of matches ?? []) {
      const payment = (match as Record<string, unknown>).payments as Record<string, unknown> | null;
      if (payment?.id && !seen.has(payment.id as string)) {
        seen.add(payment.id as string);
        payments.push({ ...payment, matched_amount: match.matched_amount, invoice_id: match.invoice_id });
      }
    }
  }

  return {
    account_type: "seller",
    account_id: sellerAccountId,
    invoices,
    payments,
    seller_statements: sellerStatements ?? [],
    statement_lines: statementLines,
    ar_records: arRecords,
    adjustments,
  };
}

async function fetchBuyerStatementData(
  buyerAccountId: string,
): Promise<StatementDataBundle> {
  const supabase = createServiceRoleClient();

  const { data: invoices } = await supabase
    .from("invoices")
    .select("*")
    .eq("buyer_account_id", buyerAccountId);

  const { data: payments } = await supabase
    .from("payments")
    .select("*")
    .eq("buyer_account_id", buyerAccountId);

  const { data: arRecords } = await supabase
    .from("ar_records")
    .select("*")
    .eq("buyer_account_id", buyerAccountId);

  const { data: loads } = await supabase
    .from("loads")
    .select("id, seller_account_id")
    .eq("buyer_account_id", buyerAccountId);

  const loadIds = (loads ?? []).map((l) => l.id as string);
  const sellerAccountIds = [...new Set((loads ?? []).map((l) => l.seller_account_id as string))];

  let sellerStatements: Record<string, unknown>[] = [];
  let statementLines: Record<string, unknown>[] = [];
  let adjustments: Record<string, unknown>[] = [];

  if (sellerAccountIds.length > 0) {
    const { data: statements } = await supabase
      .from("seller_statements")
      .select("*")
      .in("seller_account_id", sellerAccountIds);
    sellerStatements = statements ?? [];

    const statementIds = sellerStatements.map((s) => s.id as string);
    if (statementIds.length > 0) {
      const { data: lines } = await supabase
        .from("statement_lines")
        .select("*")
        .in("statement_id", statementIds);
      statementLines = (lines ?? []).filter((line) =>
        !line.load_id || loadIds.includes(line.load_id as string)
      );

      const { data: adj } = await supabase
        .from("adjustments")
        .select("*")
        .in("statement_id", statementIds);
      adjustments = (adj ?? []).filter((a) =>
        !a.load_id || loadIds.includes(a.load_id as string)
      );
    }
  }

  return {
    account_type: "buyer",
    account_id: buyerAccountId,
    invoices: invoices ?? [],
    payments: payments ?? [],
    seller_statements: sellerStatements,
    statement_lines: statementLines,
    ar_records: arRecords ?? [],
    adjustments,
  };
}

async function callClaude(data: StatementDataBundle): Promise<unknown> {
  const userPrompt = [
    "Analyze the following REAL database records. Do not invent any values.",
    "Return JSON with keys: suggestions (array), overdue_items (array), duplicate_checks (array), missing_payment_info (array), summary (string).",
    "",
    JSON.stringify(data, null, 2),
  ].join("\n");

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
      messages: [{ role: "user", content: userPrompt }],
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
  return JSON.parse(fenceMatch ? fenceMatch[1].trim() : trimmed);
}

async function handleAdvisor(body: AdvisorRequest, dryRun: boolean): Promise<Response> {
  const hasSeller = Boolean(body.seller_account_id);
  const hasBuyer = Boolean(body.buyer_account_id);

  if (hasSeller === hasBuyer) {
    return jsonResponse({
      error: 'Provide exactly one of "seller_account_id" or "buyer_account_id"',
    }, 400);
  }

  const data = hasSeller
    ? await fetchSellerStatementData(body.seller_account_id!)
    : await fetchBuyerStatementData(body.buyer_account_id!);

  if (!hasAnyRecords(data)) {
    return jsonResponse({
      sufficient_data: false,
      message: "No invoices, payments, statements, AR records, or adjustments found for this account.",
      account_type: data.account_type,
      account_id: data.account_id,
    });
  }

  if (dryRun) {
    return jsonResponse({
      sufficient_data: true,
      dry_run: true,
      account_type: data.account_type,
      account_id: data.account_id,
      record_counts: {
        invoices: data.invoices.length,
        payments: data.payments.length,
        seller_statements: data.seller_statements.length,
        statement_lines: data.statement_lines.length,
        ar_records: data.ar_records.length,
        adjustments: data.adjustments.length,
      },
      data,
    });
  }

  const suggestions = await callClaude(data);

  return jsonResponse({
    sufficient_data: true,
    account_type: data.account_type,
    account_id: data.account_id,
    record_counts: {
      invoices: data.invoices.length,
      payments: data.payments.length,
      seller_statements: data.seller_statements.length,
      statement_lines: data.statement_lines.length,
      ar_records: data.ar_records.length,
      adjustments: data.adjustments.length,
    },
    suggestions,
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
    const body = (await req.json()) as AdvisorRequest;
    return await handleAdvisor(body, isTestPath);
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
