import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const FROM_EMAIL = "ar@wilsonmarketing.com";
const FROM_NAME = "Wilson Marketing Group";
const SENDGRID_API_URL = "https://api.sendgrid.com/v3/mail/send";
const SKIP_REASON = "Recipient has opted out of email notifications";

interface NotifyRequest {
  ar_record_id: string;
}

interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

interface ArOverdueContext {
  arRecordId: string;
  invoiceId: string;
  invoiceNumber: string;
  dueDate: string | null;
  daysOverdue: number;
  amount: number;
  balance: number;
  loadNumber: string | null;
  customerName: string;
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
  return createClient(supabaseUrl, serviceRoleKey, { db: { schema: "app" } });
}

function getSendGridApiKey(): string {
  const apiKey = Deno.env.get("SENDGRID_API_KEY");
  if (!apiKey) throw new Error("Missing SENDGRID_API_KEY");
  return apiKey;
}

function formatCurrency(amount: number | null, currency = "USD"): string {
  if (amount === null || Number.isNaN(amount)) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function calculateDaysOverdue(dueDate: string | null, recordDate: string): number {
  const reference = dueDate ?? recordDate;
  const due = new Date(reference);
  const today = new Date();
  due.setHours(0, 0, 0, 0);
  today.setHours(0, 0, 0, 0);
  const diffMs = today.getTime() - due.getTime();
  return Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
}

async function getBuyerEmailOptIn(
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

  if (!portalAccess?.user_id) return { optedIn: true, userId: null };

  const { data: preference } = await supabase
    .from("notification_preferences")
    .select("opted_in")
    .eq("user_id", portalAccess.user_id)
    .eq("channel", "email")
    .maybeSingle();

  if (!preference) return { optedIn: true, userId: portalAccess.user_id };
  return { optedIn: preference.opted_in, userId: portalAccess.user_id };
}

async function fetchArOverdueContext(arRecordId: string): Promise<ArOverdueContext> {
  const supabase = createServiceRoleClient();

  const { data: arRecord, error: arError } = await supabase
    .from("ar_records")
    .select("id, buyer_account_id, invoice_id, load_id, record_date, amount, balance, status")
    .eq("id", arRecordId)
    .maybeSingle();

  if (arError) throw new Error(`Failed to fetch AR record: ${arError.message}`);
  if (!arRecord) throw new Error(`AR record not found: ${arRecordId}`);
  if (!arRecord.invoice_id) throw new Error("AR record has no associated invoice");

  const { data: invoice, error: invoiceError } = await supabase
    .from("invoices")
    .select("id, invoice_number, due_date, amount, load_id, buyer_account_id")
    .eq("id", arRecord.invoice_id)
    .maybeSingle();

  if (invoiceError || !invoice) {
    throw new Error(invoiceError?.message ?? `Invoice not found: ${arRecord.invoice_id}`);
  }

  const buyerAccountId = arRecord.buyer_account_id ?? invoice.buyer_account_id;
  if (!buyerAccountId) throw new Error("No buyer account found for AR record");

  let loadNumber: string | null = null;
  const loadId = arRecord.load_id ?? invoice.load_id;
  if (loadId) {
    const { data: load } = await supabase
      .from("loads")
      .select("load_number")
      .eq("id", loadId)
      .maybeSingle();
    loadNumber = load?.load_number ?? null;
  }

  const { data: buyer, error: buyerError } = await supabase
    .from("buyer_accounts")
    .select("id, crm_account_id")
    .eq("id", buyerAccountId)
    .maybeSingle();

  if (buyerError || !buyer) {
    throw new Error(buyerError?.message ?? `Buyer account not found: ${buyerAccountId}`);
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

  if (contactsError) throw new Error(`Failed to fetch customer contacts: ${contactsError.message}`);

  const contact = (contacts ?? []).find((c) => c.email);
  if (!contact?.email) throw new Error("No contact email found for customer");

  const { optedIn, userId } = await getBuyerEmailOptIn(buyer.id);
  const recipientName = [contact.first_name, contact.last_name].filter(Boolean).join(" ").trim() ||
    crmAccount?.name || "Valued Customer";

  const daysOverdue = calculateDaysOverdue(invoice.due_date, arRecord.record_date);

  return {
    arRecordId,
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoice_number,
    dueDate: invoice.due_date,
    daysOverdue,
    amount: Number(arRecord.amount),
    balance: Number(arRecord.balance),
    loadNumber,
    customerName: crmAccount?.name ?? "Customer",
    recipientEmail: contact.email,
    recipientName,
    recipientUserId: userId,
    emailOptedIn: optedIn,
  };
}

function buildEmailContent(ctx: ArOverdueContext): EmailContent {
  const subject =
    `Overdue Invoice ${ctx.invoiceNumber} — ${ctx.daysOverdue} day(s) past due`;

  const html = `<!DOCTYPE html>
<html><body style="font-family: Arial, sans-serif; color: #222; line-height: 1.5;">
  <p>Dear ${escapeHtml(ctx.recipientName)},</p>
  <p>This is a notice that an invoice on your account is overdue.</p>
  <table style="border-collapse: collapse; max-width: 560px;">
    <tr><td style="padding: 6px 0;"><strong>Customer</strong></td><td>${escapeHtml(ctx.customerName)}</td></tr>
    <tr><td style="padding: 6px 0;"><strong>Invoice #</strong></td><td>${escapeHtml(ctx.invoiceNumber)}</td></tr>
    <tr><td style="padding: 6px 0;"><strong>Due Date</strong></td><td>${formatDate(ctx.dueDate)}</td></tr>
    <tr><td style="padding: 6px 0;"><strong>Days Overdue</strong></td><td>${ctx.daysOverdue}</td></tr>
    <tr><td style="padding: 6px 0;"><strong>Original Amount</strong></td><td>${formatCurrency(ctx.amount)}</td></tr>
    <tr><td style="padding: 6px 0;"><strong>Outstanding Balance</strong></td><td>${formatCurrency(ctx.balance)}</td></tr>
    <tr><td style="padding: 6px 0;"><strong>Load #</strong></td><td>${escapeHtml(ctx.loadNumber ?? "—")}</td></tr>
  </table>
  <p style="margin-top: 24px;">Please remit payment at your earliest convenience.</p>
  <p>Thank you,<br/>Wilson Marketing Group Accounts Receivable</p>
</body></html>`;

  const text = [
    `Dear ${ctx.recipientName},`,
    "",
    "This is a notice that an invoice on your account is overdue.",
    "",
    `Customer: ${ctx.customerName}`,
    `Invoice #: ${ctx.invoiceNumber}`,
    `Due Date: ${formatDate(ctx.dueDate)}`,
    `Days Overdue: ${ctx.daysOverdue}`,
    `Original Amount: ${formatCurrency(ctx.amount)}`,
    `Outstanding Balance: ${formatCurrency(ctx.balance)}`,
    `Load #: ${ctx.loadNumber ?? "—"}`,
    "",
    "Please remit payment at your earliest convenience.",
    "",
    "Thank you,",
    "Wilson Marketing Group Accounts Receivable",
  ].join("\n");

  return { subject, html, text };
}

async function sendViaSendGrid(toEmail: string, toName: string, content: EmailContent): Promise<void> {
  const response = await fetch(SENDGRID_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getSendGridApiKey()}`,
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
    throw new Error(`SendGrid error (${response.status}): ${await response.text()}`);
  }
}

async function logOutboundNotification(params: {
  recipientUserId: string | null;
  recipientEmail: string;
  subject: string;
  body: string;
  status: "sent" | "failed" | "skipped";
  relatedEntityId: string;
  sentAt: string | null;
}): Promise<string> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase.from("outbound_notification_log").insert({
    recipient_user_id: params.recipientUserId,
    recipient_email: params.recipientEmail,
    channel: "email",
    notification_type: "ar_overdue",
    subject: params.subject,
    body: params.body,
    status: params.status,
    related_entity_type: "invoice",
    related_entity_id: params.relatedEntityId,
    sent_at: params.sentAt,
  }).select("id").single();

  if (error) throw new Error(`Failed to log outbound notification: ${error.message}`);
  return data.id as string;
}

async function handleNotify(arRecordId: string, dryRun: boolean): Promise<Response> {
  const ctx = await fetchArOverdueContext(arRecordId);
  const email = buildEmailContent(ctx);

  if (!ctx.emailOptedIn) {
    const skippedBody = `skip_reason: ${SKIP_REASON}\n\n${email.text}`;
    const logId = dryRun ? null : await logOutboundNotification({
      recipientUserId: ctx.recipientUserId,
      recipientEmail: ctx.recipientEmail,
      subject: email.subject,
      body: skippedBody,
      status: "skipped",
      relatedEntityId: ctx.invoiceId,
      sentAt: null,
    });

    return jsonResponse({
      success: true,
      skipped: true,
      skip_reason: SKIP_REASON,
      ar_record_id: arRecordId,
      invoice_id: ctx.invoiceId,
      recipient_email: ctx.recipientEmail,
      notification_log_id: logId,
    });
  }

  if (dryRun) {
    console.log("[notify-ar-overdue/test]", { to: ctx.recipientEmail, subject: email.subject });
    return jsonResponse({
      success: true,
      dry_run: true,
      ar_record_id: arRecordId,
      invoice_id: ctx.invoiceId,
      days_overdue: ctx.daysOverdue,
      amount: ctx.amount,
      balance: ctx.balance,
      recipient_email: ctx.recipientEmail,
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
      recipientUserId: ctx.recipientUserId,
      recipientEmail: ctx.recipientEmail,
      subject: email.subject,
      body: email.text,
      status: "sent",
      relatedEntityId: ctx.invoiceId,
      sentAt,
    });

    return jsonResponse({
      success: true,
      ar_record_id: arRecordId,
      invoice_id: ctx.invoiceId,
      recipient_email: ctx.recipientEmail,
      notification_log_id: logId,
      sent_at: sentAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const logId = await logOutboundNotification({
      recipientUserId: ctx.recipientUserId,
      recipientEmail: ctx.recipientEmail,
      subject: email.subject,
      body: `${email.text}\n\n---\nSend error: ${message}`,
      status: "failed",
      relatedEntityId: ctx.invoiceId,
      sentAt: null,
    });

    return jsonResponse({
      success: false,
      ar_record_id: arRecordId,
      invoice_id: ctx.invoiceId,
      recipient_email: ctx.recipientEmail,
      notification_log_id: logId,
      error: message,
    }, 500);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const isTestPath = new URL(req.url).pathname.endsWith("/test");

  try {
    if (!(req.headers.get("content-type") ?? "").includes("application/json")) {
      return jsonResponse({ error: "Expected application/json" }, 400);
    }
    const body = (await req.json()) as NotifyRequest;
    if (!body.ar_record_id) return jsonResponse({ error: 'Missing required field: "ar_record_id"' }, 400);
    return await handleNotify(body.ar_record_id, isTestPath);
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
