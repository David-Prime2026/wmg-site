import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const FROM_EMAIL = "payments@wilsonmarketing.com";
const FROM_NAME = "Wilson Marketing Group";
const SENDGRID_API_URL = "https://api.sendgrid.com/v3/mail/send";
const SKIP_REASON = "Recipient has opted out of email notifications";

interface NotifyRequest {
  payment_id: string;
}

interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

interface PaymentContext {
  paymentId: string;
  invoiceId: string;
  paymentNumber: string | null;
  paymentDate: string;
  paymentAmount: number;
  matchedAmount: number;
  invoiceNumber: string;
  invoiceAmount: number;
  loadNumber: string | null;
  sellerAccountName: string;
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

async function getSellerEmailOptIn(
  sellerAccountId: string,
): Promise<{ optedIn: boolean; userId: string | null }> {
  const supabase = createServiceRoleClient();
  const { data: portalAccess } = await supabase
    .from("portal_access_settings")
    .select("user_id")
    .eq("seller_account_id", sellerAccountId)
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

async function fetchPaymentContext(paymentId: string): Promise<PaymentContext> {
  const supabase = createServiceRoleClient();

  const { data: payment, error: paymentError } = await supabase
    .from("payments")
    .select("id, payment_number, payment_date, amount")
    .eq("id", paymentId)
    .maybeSingle();

  if (paymentError) throw new Error(`Failed to fetch payment: ${paymentError.message}`);
  if (!payment) throw new Error(`Payment not found: ${paymentId}`);

  const { data: match, error: matchError } = await supabase
    .from("payment_matching_records")
    .select("invoice_id, matched_amount")
    .eq("payment_id", paymentId)
    .not("invoice_id", "is", null)
    .order("matched_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (matchError) throw new Error(`Failed to fetch payment match: ${matchError.message}`);
  if (!match?.invoice_id) {
    throw new Error("No matched invoice found for payment");
  }

  const { data: invoice, error: invoiceError } = await supabase
    .from("invoices")
    .select("id, invoice_number, amount, load_id")
    .eq("id", match.invoice_id)
    .maybeSingle();

  if (invoiceError || !invoice) {
    throw new Error(invoiceError?.message ?? `Invoice not found: ${match.invoice_id}`);
  }
  if (!invoice.load_id) throw new Error("Invoice has no associated load");

  const { data: load, error: loadError } = await supabase
    .from("loads")
    .select("load_number, seller_account_id")
    .eq("id", invoice.load_id)
    .maybeSingle();

  if (loadError || !load) {
    throw new Error(loadError?.message ?? `Load not found: ${invoice.load_id}`);
  }

  const { data: seller, error: sellerError } = await supabase
    .from("seller_accounts")
    .select("id, crm_account_id")
    .eq("id", load.seller_account_id)
    .maybeSingle();

  if (sellerError || !seller) {
    throw new Error(sellerError?.message ?? `Seller account not found: ${load.seller_account_id}`);
  }

  const { data: crmAccount } = await supabase
    .from("crm_accounts")
    .select("name")
    .eq("id", seller.crm_account_id)
    .maybeSingle();

  const { data: contacts, error: contactsError } = await supabase
    .from("contacts")
    .select("email, first_name, last_name, is_primary")
    .eq("crm_account_id", seller.crm_account_id)
    .not("email", "is", null)
    .order("is_primary", { ascending: false });

  if (contactsError) throw new Error(`Failed to fetch seller contacts: ${contactsError.message}`);

  const contact = (contacts ?? []).find((c) => c.email);
  if (!contact?.email) throw new Error("No contact email found for seller account");

  const { optedIn, userId } = await getSellerEmailOptIn(seller.id);
  const recipientName = [contact.first_name, contact.last_name].filter(Boolean).join(" ").trim() ||
    crmAccount?.name || "Valued Partner";

  return {
    paymentId,
    invoiceId: invoice.id,
    paymentNumber: payment.payment_number,
    paymentDate: payment.payment_date,
    paymentAmount: Number(payment.amount),
    matchedAmount: Number(match.matched_amount),
    invoiceNumber: invoice.invoice_number,
    invoiceAmount: Number(invoice.amount),
    loadNumber: load.load_number,
    sellerAccountName: crmAccount?.name ?? "Seller",
    recipientEmail: contact.email,
    recipientName,
    recipientUserId: userId,
    emailOptedIn: optedIn,
  };
}

function buildEmailContent(ctx: PaymentContext): EmailContent {
  const subject =
    `Payment Confirmation — Invoice ${ctx.invoiceNumber} (Load ${ctx.loadNumber ?? "N/A"})`;

  const html = `<!DOCTYPE html>
<html><body style="font-family: Arial, sans-serif; color: #222; line-height: 1.5;">
  <p>Dear ${escapeHtml(ctx.recipientName)},</p>
  <p>A payment has been received and matched to an invoice on your load.</p>
  <table style="border-collapse: collapse; max-width: 560px;">
    <tr><td style="padding: 6px 0;"><strong>Payment #</strong></td><td>${escapeHtml(ctx.paymentNumber ?? "—")}</td></tr>
    <tr><td style="padding: 6px 0;"><strong>Payment Date</strong></td><td>${formatDate(ctx.paymentDate)}</td></tr>
    <tr><td style="padding: 6px 0;"><strong>Payment Amount</strong></td><td>${formatCurrency(ctx.paymentAmount)}</td></tr>
    <tr><td style="padding: 6px 0;"><strong>Matched Amount</strong></td><td>${formatCurrency(ctx.matchedAmount)}</td></tr>
    <tr><td style="padding: 6px 0;"><strong>Invoice #</strong></td><td>${escapeHtml(ctx.invoiceNumber)}</td></tr>
    <tr><td style="padding: 6px 0;"><strong>Invoice Amount</strong></td><td>${formatCurrency(ctx.invoiceAmount)}</td></tr>
    <tr><td style="padding: 6px 0;"><strong>Load #</strong></td><td>${escapeHtml(ctx.loadNumber ?? "—")}</td></tr>
    <tr><td style="padding: 6px 0;"><strong>Seller</strong></td><td>${escapeHtml(ctx.sellerAccountName)}</td></tr>
  </table>
  <p style="margin-top: 24px;">Thank you,<br/>Wilson Marketing Group</p>
</body></html>`;

  const text = [
    `Dear ${ctx.recipientName},`,
    "",
    "A payment has been received and matched to an invoice on your load.",
    "",
    `Payment #: ${ctx.paymentNumber ?? "—"}`,
    `Payment Date: ${formatDate(ctx.paymentDate)}`,
    `Payment Amount: ${formatCurrency(ctx.paymentAmount)}`,
    `Matched Amount: ${formatCurrency(ctx.matchedAmount)}`,
    `Invoice #: ${ctx.invoiceNumber}`,
    `Invoice Amount: ${formatCurrency(ctx.invoiceAmount)}`,
    `Load #: ${ctx.loadNumber ?? "—"}`,
    `Seller: ${ctx.sellerAccountName}`,
    "",
    "Thank you,",
    "Wilson Marketing Group",
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
    notification_type: "payment_confirmation",
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

async function handleNotify(paymentId: string, dryRun: boolean): Promise<Response> {
  const ctx = await fetchPaymentContext(paymentId);
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
      payment_id: paymentId,
      invoice_id: ctx.invoiceId,
      recipient_email: ctx.recipientEmail,
      notification_log_id: logId,
    });
  }

  if (dryRun) {
    console.log("[notify-payment-confirmation/test]", { to: ctx.recipientEmail, subject: email.subject });
    return jsonResponse({
      success: true,
      dry_run: true,
      payment_id: paymentId,
      invoice_id: ctx.invoiceId,
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
      payment_id: paymentId,
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
      payment_id: paymentId,
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
    if (!body.payment_id) return jsonResponse({ error: 'Missing required field: "payment_id"' }, 400);
    return await handleNotify(body.payment_id, isTestPath);
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
