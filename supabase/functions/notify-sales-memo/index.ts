import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const FROM_EMAIL = "salesmemos@wilsonmarketing.com";
const FROM_NAME = "Wilson Marketing Group";
const SENDGRID_API_URL = "https://api.sendgrid.com/v3/mail/send";

interface NotifyRequest {
  sales_memo_id: string;
}

interface SalesMemoRow {
  id: string;
  load_id: string;
  memo_number: string;
  memo_date: string;
  amount: number | null;
  status: string;
  notes: string | null;
  document_url: string | null;
}

interface LoadRow {
  id: string;
  load_number: string | null;
  buyer_account_id: string | null;
  commodity_id: string;
  quantity: number | null;
  quantity_unit: string | null;
  intake_date: string | null;
}

interface CommodityRow {
  id: string;
  name: string;
  code: string;
  unit: string | null;
}

interface PricingRow {
  price: number;
  currency: string;
}

interface BuyerRow {
  id: string;
  buyer_code: string | null;
  crm_account_id: string;
}

interface ContactRow {
  email: string | null;
  first_name: string | null;
  last_name: string | null;
}

interface CrmAccountRow {
  name: string;
}

interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

interface SalesMemoContext {
  memo: SalesMemoRow;
  load: LoadRow;
  commodity: CommodityRow;
  pricing: PricingRow | null;
  buyerAccountName: string;
  buyerCode: string | null;
  recipientEmail: string;
  recipientName: string;
  recipientUserId: string | null;
  emailOptedIn: boolean;
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

  return createClient(supabaseUrl, serviceRoleKey, {
    db: { schema: "app" },
  });
}

function getSendGridApiKey(): string {
  const apiKey = Deno.env.get("SENDGRID_API_KEY");
  if (!apiKey) {
    throw new Error("Missing SENDGRID_API_KEY");
  }
  return apiKey;
}

function formatCurrency(amount: number | null, currency = "USD"): string {
  if (amount === null || Number.isNaN(amount)) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
    amount,
  );
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function fetchSalesMemoContext(
  salesMemoId: string,
): Promise<SalesMemoContext> {
  const supabase = createServiceRoleClient();

  const { data: memo, error: memoError } = await supabase
    .from("sales_memos")
    .select("id, load_id, memo_number, memo_date, amount, status, notes, document_url")
    .eq("id", salesMemoId)
    .maybeSingle();

  if (memoError) {
    throw new Error(`Failed to fetch sales memo: ${memoError.message}`);
  }
  if (!memo) {
    throw new Error(`Sales memo not found: ${salesMemoId}`);
  }

  const { data: load, error: loadError } = await supabase
    .from("loads")
    .select("id, load_number, buyer_account_id, commodity_id, quantity, quantity_unit, intake_date")
    .eq("id", memo.load_id)
    .maybeSingle();

  if (loadError) {
    throw new Error(`Failed to fetch load: ${loadError.message}`);
  }
  if (!load) {
    throw new Error(`Load not found for sales memo: ${memo.load_id}`);
  }
  if (!load.buyer_account_id) {
    throw new Error("Load has no buyer assigned — cannot send sales memo");
  }

  const { data: commodity, error: commodityError } = await supabase
    .from("commodities")
    .select("id, name, code, unit")
    .eq("id", load.commodity_id)
    .maybeSingle();

  if (commodityError || !commodity) {
    throw new Error(
      commodityError?.message ?? `Commodity not found: ${load.commodity_id}`,
    );
  }

  const memoDate = new Date(memo.memo_date);
  const pricingYear = memoDate.getUTCFullYear();
  const pricingMonth = memoDate.getUTCMonth() + 1;

  const { data: pricing } = await supabase
    .from("commodity_monthly_pricing")
    .select("price, currency")
    .eq("commodity_id", commodity.id)
    .eq("pricing_year", pricingYear)
    .eq("pricing_month", pricingMonth)
    .maybeSingle();

  const { data: buyer, error: buyerError } = await supabase
    .from("buyer_accounts")
    .select("id, buyer_code, crm_account_id")
    .eq("id", load.buyer_account_id)
    .maybeSingle();

  if (buyerError || !buyer) {
    throw new Error(
      buyerError?.message ?? `Buyer account not found: ${load.buyer_account_id}`,
    );
  }

  const { data: crmAccount } = await supabase
    .from("crm_accounts")
    .select("name")
    .eq("id", buyer.crm_account_id)
    .maybeSingle();

  const { data: contacts, error: contactsError } = await supabase
    .from("contacts")
    .select("email, first_name, last_name, is_primary")
    .eq("crm_account_id", buyer.crm_account_id)
    .not("email", "is", null)
    .order("is_primary", { ascending: false });

  if (contactsError) {
    throw new Error(`Failed to fetch buyer contacts: ${contactsError.message}`);
  }

  const contact = (contacts ?? []).find((c) => c.email) as ContactRow | undefined;
  if (!contact?.email) {
    throw new Error("No contact email found for buyer account");
  }

  const { optedIn, userId } = await getEmailOptIn(buyer.id);

  const recipientName = [contact.first_name, contact.last_name]
    .filter(Boolean)
    .join(" ")
    .trim() || crmAccount?.name || "Valued Customer";

  return {
    memo: memo as SalesMemoRow,
    load: load as LoadRow,
    commodity: commodity as CommodityRow,
    pricing: pricing as PricingRow | null,
    buyerAccountName: crmAccount?.name ?? "Buyer",
    buyerCode: buyer.buyer_code,
    recipientEmail: contact.email,
    recipientName,
    recipientUserId: userId,
    emailOptedIn: optedIn,
  };
}

async function getEmailOptIn(
  buyerAccountId: string,
): Promise<{ optedIn: boolean; userId: string | null }> {
  const supabase = createServiceRoleClient();

  const { data: portalAccess } = await supabase
    .from("portal_access_settings")
    .select("user_id")
    .eq("buyer_account_id", buyerAccountId)
    .eq("is_enabled", true)
    .limit(1)
    .maybeSingle();

  if (!portalAccess?.user_id) {
    return { optedIn: true, userId: null };
  }

  const { data: preference } = await supabase
    .from("notification_preferences")
    .select("opted_in")
    .eq("user_id", portalAccess.user_id)
    .eq("channel", "email")
    .maybeSingle();

  if (!preference) {
    return { optedIn: true, userId: portalAccess.user_id };
  }

  return { optedIn: preference.opted_in, userId: portalAccess.user_id };
}

function buildEmailContent(ctx: SalesMemoContext): EmailContent {
  const quantityLabel = ctx.load.quantity != null
    ? `${ctx.load.quantity}${ctx.load.quantity_unit ? ` ${ctx.load.quantity_unit}` : ""}`
    : "—";

  const unitPrice = ctx.pricing
    ? formatCurrency(ctx.pricing.price, ctx.pricing.currency)
    : "—";

  const subject =
    `Sales Memo ${ctx.memo.memo_number} — ${ctx.commodity.name} (Load ${ctx.load.load_number ?? "N/A"})`;

  const notesBlock = ctx.memo.notes
    ? `<p><strong>Notes:</strong> ${escapeHtml(ctx.memo.notes)}</p>`
    : "";

  const documentBlock = ctx.memo.document_url
    ? `<p><a href="${escapeHtml(ctx.memo.document_url)}">View sales memo document</a></p>`
    : "";

  const html = `<!DOCTYPE html>
<html>
<body style="font-family: Arial, sans-serif; color: #222; line-height: 1.5;">
  <p>Dear ${escapeHtml(ctx.recipientName)},</p>
  <p>Wilson Marketing Group has issued a sales memo for your review.</p>
  <table style="border-collapse: collapse; width: 100%; max-width: 560px;">
    <tr><td style="padding: 6px 0;"><strong>Memo #</strong></td><td>${escapeHtml(ctx.memo.memo_number)}</td></tr>
    <tr><td style="padding: 6px 0;"><strong>Memo Date</strong></td><td>${formatDate(ctx.memo.memo_date)}</td></tr>
    <tr><td style="padding: 6px 0;"><strong>Buyer</strong></td><td>${escapeHtml(ctx.buyerAccountName)}${ctx.buyerCode ? ` (${escapeHtml(ctx.buyerCode)})` : ""}</td></tr>
    <tr><td style="padding: 6px 0;"><strong>Load #</strong></td><td>${escapeHtml(ctx.load.load_number ?? "—")}</td></tr>
    <tr><td style="padding: 6px 0;"><strong>Commodity</strong></td><td>${escapeHtml(ctx.commodity.name)} (${escapeHtml(ctx.commodity.code)})</td></tr>
    <tr><td style="padding: 6px 0;"><strong>Quantity</strong></td><td>${escapeHtml(quantityLabel)}</td></tr>
    <tr><td style="padding: 6px 0;"><strong>Unit Price</strong></td><td>${unitPrice}</td></tr>
    <tr><td style="padding: 6px 0;"><strong>Amount</strong></td><td>${formatCurrency(ctx.memo.amount)}</td></tr>
    <tr><td style="padding: 6px 0;"><strong>Status</strong></td><td>${escapeHtml(ctx.memo.status)}</td></tr>
  </table>
  ${notesBlock}
  ${documentBlock}
  <p style="margin-top: 24px;">Thank you,<br/>Wilson Marketing Group</p>
</body>
</html>`;

  const text = [
    `Dear ${ctx.recipientName},`,
    "",
    "Wilson Marketing Group has issued a sales memo for your review.",
    "",
    `Memo #: ${ctx.memo.memo_number}`,
    `Memo Date: ${formatDate(ctx.memo.memo_date)}`,
    `Buyer: ${ctx.buyerAccountName}${ctx.buyerCode ? ` (${ctx.buyerCode})` : ""}`,
    `Load #: ${ctx.load.load_number ?? "—"}`,
    `Commodity: ${ctx.commodity.name} (${ctx.commodity.code})`,
    `Quantity: ${quantityLabel}`,
    `Unit Price: ${unitPrice}`,
    `Amount: ${formatCurrency(ctx.memo.amount)}`,
    `Status: ${ctx.memo.status}`,
    ctx.memo.notes ? `Notes: ${ctx.memo.notes}` : "",
    ctx.memo.document_url ? `Document: ${ctx.memo.document_url}` : "",
    "",
    "Thank you,",
    "Wilson Marketing Group",
  ].filter(Boolean).join("\n");

  return { subject, html, text };
}

async function sendViaSendGrid(
  toEmail: string,
  toName: string,
  content: EmailContent,
): Promise<void> {
  const apiKey = getSendGridApiKey();

  const response = await fetch(SENDGRID_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: toEmail, name: toName }] }],
      from: { email: FROM_EMAIL, name: FROM_NAME },
      subject: content.subject,
      content: [
        { type: "text/plain", value: content.text },
        { type: "text/html", value: content.html },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`SendGrid error (${response.status}): ${errorText}`);
  }
}

async function logOutboundNotification(params: {
  salesMemoId: string;
  recipientUserId: string | null;
  recipientEmail: string;
  subject: string;
  body: string;
  status: "sent" | "failed" | "skipped";
  sentAt: string | null;
}): Promise<string> {
  const supabase = createServiceRoleClient();

  const { data, error } = await supabase
    .from("outbound_notification_log")
    .insert({
      recipient_user_id: params.recipientUserId,
      recipient_email: params.recipientEmail,
      channel: "email",
      notification_type: "sales_memo",
      subject: params.subject,
      body: params.body,
      status: params.status,
      related_entity_type: "sales_memo",
      related_entity_id: params.salesMemoId,
      sent_at: params.sentAt,
    })
    .select("id")
    .single();

  if (error) {
    throw new Error(`Failed to log outbound notification: ${error.message}`);
  }

  return data.id as string;
}

async function handleNotify(
  salesMemoId: string,
  dryRun: boolean,
): Promise<Response> {
  const ctx = await fetchSalesMemoContext(salesMemoId);
  const email = buildEmailContent(ctx);

  if (!ctx.emailOptedIn) {
    const skipReason = "Buyer has opted out of email notifications";
    const skippedBody = `skip_reason: ${skipReason}\n\n${email.text}`;

    const logId = dryRun
      ? null
      : await logOutboundNotification({
        salesMemoId,
        recipientUserId: ctx.recipientUserId,
        recipientEmail: ctx.recipientEmail,
        subject: email.subject,
        body: skippedBody,
        status: "skipped",
        sentAt: null,
      });

    return jsonResponse({
      success: true,
      skipped: true,
      skip_reason: skipReason,
      sales_memo_id: salesMemoId,
      recipient_email: ctx.recipientEmail,
      notification_log_id: logId,
    });
  }

  if (dryRun) {
    console.log("[notify-sales-memo/test] Email preview:", {
      to: ctx.recipientEmail,
      from: FROM_EMAIL,
      subject: email.subject,
      text: email.text,
    });

    return jsonResponse({
      success: true,
      dry_run: true,
      sales_memo_id: salesMemoId,
      recipient_email: ctx.recipientEmail,
      recipient_name: ctx.recipientName,
      email_opted_in: ctx.emailOptedIn,
      subject: email.subject,
      html: email.html,
      text: email.text,
    });
  }

  try {
    await sendViaSendGrid(ctx.recipientEmail, ctx.recipientName, email);

    const sentAt = new Date().toISOString();
    const logId = await logOutboundNotification({
      salesMemoId,
      recipientUserId: ctx.recipientUserId,
      recipientEmail: ctx.recipientEmail,
      subject: email.subject,
      body: email.text,
      status: "sent",
      sentAt,
    });

    return jsonResponse({
      success: true,
      sales_memo_id: salesMemoId,
      recipient_email: ctx.recipientEmail,
      notification_log_id: logId,
      sent_at: sentAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    const logId = await logOutboundNotification({
      salesMemoId,
      recipientUserId: ctx.recipientUserId,
      recipientEmail: ctx.recipientEmail,
      subject: email.subject,
      body: `${email.text}\n\n---\nSend error: ${message}`,
      status: "failed",
      sentAt: null,
    });

    return jsonResponse({
      success: false,
      sales_memo_id: salesMemoId,
      recipient_email: ctx.recipientEmail,
      notification_log_id: logId,
      error: message,
    }, 500);
  }
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

    const body = (await req.json()) as NotifyRequest;
    if (!body.sales_memo_id) {
      return jsonResponse({ error: 'Missing required field: "sales_memo_id"' }, 400);
    }

    return await handleNotify(body.sales_memo_id, isTestPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ error: message }, 500);
  }
});
