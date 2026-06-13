import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const FROM_EMAIL = "loads@wilsonmarketing.com";
const FROM_NAME = "Wilson Marketing Group";
const SENDGRID_API_URL = "https://api.sendgrid.com/v3/mail/send";
const SKIP_REASON = "Recipient has opted out of email notifications";

const SELLER_ONLY_STATUSES = new Set(["uncovered"]);
const BUYER_STATUSES = new Set(["covered", "dispatched", "picked-up", "invoiced"]);
const BOTH_STATUSES = new Set(["received"]);

interface NotifyRequest {
  load_id: string;
  new_status: string;
}

interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

interface RecipientInfo {
  party: "seller" | "buyer";
  email: string;
  name: string;
  userId: string | null;
  emailOptedIn: boolean;
}

interface LoadStatusContext {
  loadId: string;
  loadNumber: string | null;
  newStatus: string;
  commodityName: string;
  quantityLabel: string;
  sellerAccountName: string;
  buyerAccountName: string | null;
  recipients: RecipientInfo[];
}

interface DeliveryResult {
  party: string;
  recipient_email: string;
  success: boolean;
  skipped?: boolean;
  skip_reason?: string;
  notification_log_id?: string | null;
  sent_at?: string;
  error?: string;
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

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function normalizeStatus(status: string): string {
  return status.trim().toLowerCase();
}

function resolveRecipientParties(newStatus: string): Array<"seller" | "buyer"> {
  const status = normalizeStatus(newStatus);
  if (BOTH_STATUSES.has(status)) return ["seller", "buyer"];
  if (SELLER_ONLY_STATUSES.has(status)) return ["seller"];
  if (BUYER_STATUSES.has(status)) return ["buyer"];
  return ["buyer"];
}

async function getEmailOptIn(
  accountType: "seller" | "buyer",
  accountId: string,
): Promise<{ optedIn: boolean; userId: string | null }> {
  const supabase = createServiceRoleClient();
  const column = accountType === "seller" ? "seller_account_id" : "buyer_account_id";

  const { data: portalAccess } = await supabase
    .from("portal_access_settings")
    .select("user_id")
    .eq(column, accountId)
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

async function getContactForAccount(
  crmAccountId: string,
  fallbackName: string,
): Promise<{ email: string; name: string } | null> {
  const supabase = createServiceRoleClient();

  const { data: crmAccount } = await supabase
    .from("crm_accounts")
    .select("name")
    .eq("id", crmAccountId)
    .maybeSingle();

  const { data: contacts, error } = await supabase
    .from("contacts")
    .select("email, first_name, last_name, is_primary")
    .eq("crm_account_id", crmAccountId)
    .not("email", "is", null)
    .order("is_primary", { ascending: false });

  if (error) throw new Error(`Failed to fetch contacts: ${error.message}`);

  const contact = (contacts ?? []).find((c) => c.email);
  if (!contact?.email) return null;

  const name = [contact.first_name, contact.last_name].filter(Boolean).join(" ").trim() ||
    crmAccount?.name || fallbackName;

  return { email: contact.email, name };
}

async function fetchLoadStatusContext(
  loadId: string,
  newStatus: string,
): Promise<LoadStatusContext> {
  const supabase = createServiceRoleClient();

  const { data: load, error: loadError } = await supabase
    .from("loads")
    .select("id, load_number, seller_account_id, buyer_account_id, commodity_id, quantity, quantity_unit")
    .eq("id", loadId)
    .maybeSingle();

  if (loadError) throw new Error(`Failed to fetch load: ${loadError.message}`);
  if (!load) throw new Error(`Load not found: ${loadId}`);

  const { data: commodity } = await supabase
    .from("commodities")
    .select("name")
    .eq("id", load.commodity_id)
    .maybeSingle();

  const { data: seller } = await supabase
    .from("seller_accounts")
    .select("id, crm_account_id")
    .eq("id", load.seller_account_id)
    .maybeSingle();

  if (!seller) throw new Error(`Seller account not found: ${load.seller_account_id}`);

  const { data: sellerCrm } = await supabase
    .from("crm_accounts")
    .select("name")
    .eq("id", seller.crm_account_id)
    .maybeSingle();

  let buyerAccountName: string | null = null;
  let buyer: { id: string; crm_account_id: string } | null = null;

  if (load.buyer_account_id) {
    const { data: buyerData } = await supabase
      .from("buyer_accounts")
      .select("id, crm_account_id")
      .eq("id", load.buyer_account_id)
      .maybeSingle();
    buyer = buyerData;

    if (buyer) {
      const { data: buyerCrm } = await supabase
        .from("crm_accounts")
        .select("name")
        .eq("id", buyer.crm_account_id)
        .maybeSingle();
      buyerAccountName = buyerCrm?.name ?? null;
    }
  }

  const parties = resolveRecipientParties(newStatus);
  const recipients: RecipientInfo[] = [];

  if (parties.includes("seller")) {
    const contact = await getContactForAccount(seller.crm_account_id, "Seller");
    if (!contact) throw new Error("No contact email found for seller");
    const { optedIn, userId } = await getEmailOptIn("seller", seller.id);
    recipients.push({
      party: "seller",
      email: contact.email,
      name: contact.name,
      userId,
      emailOptedIn: optedIn,
    });
  }

  if (parties.includes("buyer")) {
    if (!buyer) throw new Error("Load has no buyer assigned — cannot notify buyer");
    const contact = await getContactForAccount(buyer.crm_account_id, "Buyer");
    if (!contact) throw new Error("No contact email found for buyer");
    const { optedIn, userId } = await getEmailOptIn("buyer", buyer.id);
    recipients.push({
      party: "buyer",
      email: contact.email,
      name: contact.name,
      userId,
      emailOptedIn: optedIn,
    });
  }

  const quantityLabel = load.quantity != null
    ? `${load.quantity}${load.quantity_unit ? ` ${load.quantity_unit}` : ""}`
    : "—";

  return {
    loadId,
    loadNumber: load.load_number,
    newStatus,
    commodityName: commodity?.name ?? "Commodity",
    quantityLabel,
    sellerAccountName: sellerCrm?.name ?? "Seller",
    buyerAccountName,
    recipients,
  };
}

function buildEmailContent(ctx: LoadStatusContext, recipient: RecipientInfo): EmailContent {
  const subject = `Load ${ctx.loadNumber ?? ctx.loadId} — Status Update: ${ctx.newStatus}`;

  const partyLabel = recipient.party === "seller" ? "Seller" : "Buyer";
  const counterparty = recipient.party === "seller"
    ? ctx.buyerAccountName ?? "—"
    : ctx.sellerAccountName;

  const html = `<!DOCTYPE html>
<html><body style="font-family: Arial, sans-serif; color: #222; line-height: 1.5;">
  <p>Dear ${escapeHtml(recipient.name)},</p>
  <p>The status of load <strong>${escapeHtml(ctx.loadNumber ?? ctx.loadId)}</strong> has been updated.</p>
  <table style="border-collapse: collapse; max-width: 560px;">
    <tr><td style="padding: 6px 0;"><strong>New Status</strong></td><td>${escapeHtml(ctx.newStatus)}</td></tr>
    <tr><td style="padding: 6px 0;"><strong>Load #</strong></td><td>${escapeHtml(ctx.loadNumber ?? "—")}</td></tr>
    <tr><td style="padding: 6px 0;"><strong>Commodity</strong></td><td>${escapeHtml(ctx.commodityName)}</td></tr>
    <tr><td style="padding: 6px 0;"><strong>Quantity</strong></td><td>${escapeHtml(ctx.quantityLabel)}</td></tr>
    <tr><td style="padding: 6px 0;"><strong>Your Role</strong></td><td>${partyLabel}</td></tr>
    <tr><td style="padding: 6px 0;"><strong>Counterparty</strong></td><td>${escapeHtml(counterparty)}</td></tr>
  </table>
  <p style="margin-top: 24px;">Thank you,<br/>Wilson Marketing Group</p>
</body></html>`;

  const text = [
    `Dear ${recipient.name},`,
    "",
    `The status of load ${ctx.loadNumber ?? ctx.loadId} has been updated.`,
    "",
    `New Status: ${ctx.newStatus}`,
    `Load #: ${ctx.loadNumber ?? "—"}`,
    `Commodity: ${ctx.commodityName}`,
    `Quantity: ${ctx.quantityLabel}`,
    `Your Role: ${partyLabel}`,
    `Counterparty: ${counterparty}`,
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
    notification_type: "load_status",
    subject: params.subject,
    body: params.body,
    status: params.status,
    related_entity_type: "load",
    related_entity_id: params.relatedEntityId,
    sent_at: params.sentAt,
  }).select("id").single();

  if (error) throw new Error(`Failed to log outbound notification: ${error.message}`);
  return data.id as string;
}

async function deliverToRecipient(
  ctx: LoadStatusContext,
  recipient: RecipientInfo,
  dryRun: boolean,
): Promise<DeliveryResult> {
  const email = buildEmailContent(ctx, recipient);

  if (!recipient.emailOptedIn) {
    const skippedBody = `skip_reason: ${SKIP_REASON}\n\n${email.text}`;
    const logId = dryRun ? null : await logOutboundNotification({
      recipientUserId: recipient.userId,
      recipientEmail: recipient.email,
      subject: email.subject,
      body: skippedBody,
      status: "skipped",
      relatedEntityId: ctx.loadId,
      sentAt: null,
    });

    return {
      party: recipient.party,
      recipient_email: recipient.email,
      success: true,
      skipped: true,
      skip_reason: SKIP_REASON,
      notification_log_id: logId,
    };
  }

  if (dryRun) {
    console.log(`[notify-load-status/test] ${recipient.party}`, {
      to: recipient.email,
      subject: email.subject,
    });
    return {
      party: recipient.party,
      recipient_email: recipient.email,
      success: true,
    };
  }

  try {
    await sendViaSendGrid(recipient.email, recipient.name, email);
    const sentAt = new Date().toISOString();
    const logId = await logOutboundNotification({
      recipientUserId: recipient.userId,
      recipientEmail: recipient.email,
      subject: email.subject,
      body: email.text,
      status: "sent",
      relatedEntityId: ctx.loadId,
      sentAt,
    });

    return {
      party: recipient.party,
      recipient_email: recipient.email,
      success: true,
      notification_log_id: logId,
      sent_at: sentAt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const logId = await logOutboundNotification({
      recipientUserId: recipient.userId,
      recipientEmail: recipient.email,
      subject: email.subject,
      body: `${email.text}\n\n---\nSend error: ${message}`,
      status: "failed",
      relatedEntityId: ctx.loadId,
      sentAt: null,
    });

    return {
      party: recipient.party,
      recipient_email: recipient.email,
      success: false,
      notification_log_id: logId,
      error: message,
    };
  }
}

async function handleNotify(
  loadId: string,
  newStatus: string,
  dryRun: boolean,
): Promise<Response> {
  const ctx = await fetchLoadStatusContext(loadId, newStatus);
  const results: DeliveryResult[] = [];

  for (const recipient of ctx.recipients) {
    results.push(await deliverToRecipient(ctx, recipient, dryRun));
  }

  const sentCount = results.filter((r) => r.success && !r.skipped && r.sent_at).length;
  const skippedCount = results.filter((r) => r.skipped).length;
  const failedCount = results.filter((r) => !r.success).length;

  if (dryRun) {
    const previews = ctx.recipients.map((recipient) => ({
      party: recipient.party,
      recipient_email: recipient.email,
      email_opted_in: recipient.emailOptedIn,
      ...buildEmailContent(ctx, recipient),
    }));

    return jsonResponse({
      success: true,
      dry_run: true,
      load_id: loadId,
      new_status: newStatus,
      recipients: previews,
    });
  }

  const overallSuccess = failedCount === 0;

  return jsonResponse({
    success: overallSuccess,
    load_id: loadId,
    new_status: newStatus,
    sent_count: sentCount,
    skipped_count: skippedCount,
    failed_count: failedCount,
    results,
  }, overallSuccess ? 200 : 500);
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
    if (!body.load_id) return jsonResponse({ error: 'Missing required field: "load_id"' }, 400);
    if (!body.new_status) return jsonResponse({ error: 'Missing required field: "new_status"' }, 400);
    return await handleNotify(body.load_id, body.new_status, isTestPath);
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
