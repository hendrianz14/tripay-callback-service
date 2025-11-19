import http from "http";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";
import "dotenv/config";

const PORT = process.env.PORT || process.env.TRIPAY_CALLBACK_PORT || 4000;

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const tripayPrivateKey = process.env.TRIPAY_PRIVATE_KEY || "";

if (!supabaseUrl || !supabaseServiceKey) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables.",
  );
  process.exit(1);
}

if (!tripayPrivateKey) {
  console.warn(
    "Warning: TRIPAY_PRIVATE_KEY is not set. Tripay callback verification will always fail.",
  );
}

const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

function sendJson(res, statusCode, body) {
  const json = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", (err) => reject(err));
  });
}

function getHeaderSignature(req) {
  const headers = req.headers || {};
  return (
    headers["x-callback-signature"] ||
    headers["X-Callback-Signature"] ||
    headers["x-signature"] ||
    headers["X-Signature"] ||
    ""
  );
}

async function markPaid(externalId, userId, credits, amount, payload) {
  const { data: auditRow } = await supabaseAdmin
    .from("topup_invoices")
    .select("status, raw")
    .eq("external_id", externalId)
    .maybeSingle();

  if (auditRow && auditRow.status === "PAID") {
    await supabaseAdmin.from("topup_invoices").upsert(
      {
        external_id: externalId,
        user_id: userId,
        credits,
        amount,
        status: "PAID",
        paid_at: new Date().toISOString(),
        raw: Object.assign(
          {},
          (auditRow && auditRow.raw) || {},
          payload || {},
        ),
      },
      { onConflict: "external_id" },
    );
    return;
  }

  await supabaseAdmin.from("credits_wallet").upsert(
    { user_id: userId, balance: 0 },
    { onConflict: "user_id", ignoreDuplicates: true },
  );

  const { data: wallet } = await supabaseAdmin
    .from("credits_wallet")
    .select("balance")
    .eq("user_id", userId)
    .maybeSingle();
  const current = Number((wallet && wallet.balance) || 0);

  await supabaseAdmin
    .from("credits_wallet")
    .update({ balance: current + credits })
    .eq("user_id", userId);

  await supabaseAdmin.from("credits_ledger").insert({
    user_id: userId,
    reason: "purchase_credits",
    amount: credits,
    external_id: externalId,
  });

  await supabaseAdmin.from("topup_invoices").upsert(
    {
      external_id: externalId,
      user_id: userId,
      credits,
      amount,
      status: "PAID",
      paid_at: new Date().toISOString(),
      raw: Object.assign(
        {},
        (auditRow && auditRow.raw) || {},
        payload || {},
      ),
    },
    { onConflict: "external_id" },
  );
}

async function handleTripayCallback(req, res) {
  if (req.method !== "POST") {
    return sendJson(res, 405, { success: false, error: "Method not allowed" });
  }

  let rawBody = "";
  try {
    rawBody = await readRawBody(req);
  } catch {
    return sendJson(res, 400, { success: false, error: "Invalid body" });
  }

  let payload = {};
  if (rawBody) {
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return sendJson(res, 400, { success: false, error: "Invalid JSON" });
    }
  }

  const headerSignature = String(getHeaderSignature(req) || "");

  if (!tripayPrivateKey || !headerSignature) {
    return sendJson(res, 400, {
      success: false,
      error: "Missing callback signature",
    });
  }

  const expectedSignature = crypto
    .createHmac("sha256", tripayPrivateKey)
    .update(rawBody)
    .digest("hex")
    .toLowerCase();

  if (expectedSignature !== headerSignature.toLowerCase()) {
    return sendJson(res, 400, { success: false, error: "Invalid signature" });
  }

  const data =
    payload && typeof payload === "object" && payload.data != null
      ? payload.data
      : payload || {};
  const merchantRef =
    (data && (data.merchant_ref || data.merchantRef || data.reference)) || "";
  const amountRaw = Number(
    (data && (data.amount || data.total_amount || 0)) || 0,
  );
  const statusRaw = String((data && data.status) || "").toUpperCase(); // PAID | EXPIRED | PENDING

  const external = String(merchantRef || "");
  if (!external.startsWith("topup_")) {
    return sendJson(res, 200, {
      success: true,
      note: "Ignored non-topup callback",
    });
  }

  try {
    const { data: auditRow } = await supabaseAdmin
      .from("topup_invoices")
      .select("user_id, credits, amount, raw, status")
      .eq("external_id", external)
      .maybeSingle();

    let userId = (auditRow && auditRow.user_id) || null;
    let credits =
      Number((auditRow && auditRow.credits) || 0) || null;
    let amount = Number(
      (auditRow && auditRow.amount) || amountRaw || 0,
    );

    if (!userId || !credits) {
      const parts = external.split("_");
      if (parts.length >= 4) {
        userId = parts[1];
        const parsedCredits = parseInt(parts[3], 10);
        if (isFinite(parsedCredits) && parsedCredits > 0) {
          credits = parsedCredits;
        }
      }
    }

    if (!userId || !credits || credits <= 0) {
      return sendJson(res, 200, {
        success: true,
        note: "Missing user/credits",
      });
    }

    if (!isFinite(amount) || amount <= 0) {
      amount = credits * 300;
    }

    const normalizedStatus =
      statusRaw === "PAID" || statusRaw === "SUCCESS"
        ? "PAID"
        : statusRaw === "EXPIRED"
        ? "EXPIRED"
        : "PENDING";

    if (normalizedStatus === "PAID") {
      await markPaid(external, userId, credits, amount, payload);
    } else {
      await supabaseAdmin.from("topup_invoices").upsert(
        {
          external_id: external,
          user_id: userId,
          credits,
          amount,
          status: normalizedStatus,
          raw: Object.assign(
            {},
            (auditRow && auditRow.raw) || {},
            payload || {},
          ),
        },
        { onConflict: "external_id" },
      );
    }
  } catch (err) {
    console.error("Tripay callback error", err);
    return sendJson(res, 500, { success: false, error: "Internal" });
  }

  return sendJson(res, 200, { success: true });
}

const server = http.createServer((req, res) => {
  const url = req.url || "/";

  if (url === "/health" || url === "/healthz") {
    return sendJson(res, 200, { ok: true });
  }

  if (url === "/tripay/callback") {
    return void handleTripayCallback(req, res);
  }

  return sendJson(res, 404, { success: false, error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`Tripay callback server listening on port ${PORT}`);
});
