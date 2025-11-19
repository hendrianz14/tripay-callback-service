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
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables."
  );
  process.exit(1);
}

if (!tripayPrivateKey) {
  console.warn(
    "Warning: TRIPAY_PRIVATE_KEY is not set. Tripay callback verification will always fail."
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

  const data = payload?.data || payload;
  const merchantRef =
    data?.merchant_ref || data?.merchantRef || data?.reference || "";
  const statusRaw = String(data?.status || "").toUpperCase(); // PAID | EXPIRED | PENDING

  try {
    const { data: tx } = await supabaseAdmin
      .from("transactions")
      .select("id, user_id, plan, status")
      .eq("external_ref", merchantRef)
      .single();

    if (!tx) {
      return sendJson(res, 200, {
        success: true,
        note: "Transaction not found; ack",
      });
    }

    const normalizedStatus =
      statusRaw === "PAID" || statusRaw === "SUCCESS"
        ? "PAID"
        : statusRaw === "EXPIRED"
        ? "EXPIRED"
        : "PENDING";

    await supabaseAdmin
      .from("transactions")
      .update({ status: normalizedStatus })
      .eq("id", tx.id);

    if (normalizedStatus === "PAID") {
      const now = new Date();
      const expires = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
      const plan = (tx && (tx as any).plan) || "Basic";

      try {
        await supabaseAdmin.from("subscriptions").insert({
          user_id: (tx as any).user_id,
          plan_name: plan,
          status: "active",
          expires_at: expires.toISOString(),
        });
      } catch (err) {
        console.error("Tripay callback: subscriptions insert failed", err);
      }

      try {
        await supabaseAdmin
          .from("profiles")
          .update({ plan, plan_expires_at: expires.toISOString() })
          .eq("user_id", (tx as any).user_id);
      } catch (err) {
        console.error("Tripay callback: profiles update failed", err);
      }
    }

    return sendJson(res, 200, { success: true });
  } catch (err) {
    console.error("Tripay callback error", err);
    return sendJson(res, 200, { success: true, note: "Handled with errors" });
  }
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

