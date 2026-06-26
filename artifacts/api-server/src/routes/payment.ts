import { Router } from "express";
import Razorpay from "razorpay";
import crypto from "crypto";
import { requireAuth } from "../lib/auth";
import { supabaseAdmin } from "../lib/supabaseAdmin";
import { logger } from "../lib/logger";

const router = Router();

function getRazorpay() {
  const key_id = process.env.RAZORPAY_KEY_ID;
  const key_secret = process.env.RAZORPAY_KEY_SECRET;
  if (!key_id || !key_secret) throw new Error("Razorpay keys not configured");
  return new Razorpay({ key_id, key_secret });
}

async function getINRtoUSD(): Promise<number> {
  const { data } = await supabaseAdmin
    .from("exchange_rates")
    .select("rate")
    .eq("target_currency", "INR")
    .single();
  return data?.rate || 83.5;
}

// ── POST /api/payment/razorpay/create-order ───────────────────────────────────
router.post("/razorpay/create-order", requireAuth, async (req, res) => {
  try {
    const { amountINR } = req.body;
    const parsed = Number(amountINR);
    if (!amountINR || isNaN(parsed) || parsed < 1) {
      return res.status(400).json({ error: "Invalid amount. Minimum ₹1." });
    }

    const razorpay = getRazorpay();
    const amountPaise = Math.round(parsed * 100);

    const order = await razorpay.orders.create({
      amount: amountPaise,
      currency: "INR",
      receipt: `rcpt_${Date.now()}`,
    });

    return res.json({
      orderId: order.id,
      amount: amountPaise,
      currency: "INR",
      keyId: process.env.RAZORPAY_KEY_ID,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to create payment order";
    if (msg.includes("not configured")) return res.status(503).json({ error: "Payment gateway not configured" });
    logger.error({ err }, "Razorpay create-order error");
    return res.status(500).json({ error: "Failed to create payment order" });
  }
});

// ── POST /api/payment/razorpay/verify ────────────────────────────────────────
//
// Security guarantees:
//  1. HMAC-SHA256 signature verified against server-held key_secret
//  2. Payment amount fetched from Razorpay server-side (never trusted from body)
//  3. Payment status must be "captured"; order_id must match
//  4. Idempotency: razorpay_payment_id stored as reference_id (unique per payment);
//     duplicate calls return the original credited amount without double-crediting
router.post("/razorpay/verify", requireAuth, async (req, res) => {
  const userId = (req as { userId?: string }).userId as string;

  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ error: "Missing payment verification fields" });
  }

  const key_secret = process.env.RAZORPAY_KEY_SECRET;
  if (!key_secret) return res.status(503).json({ error: "Payment gateway not configured" });

  // ── 1. Verify HMAC-SHA256 signature ────────────────────────────────────────
  const expectedSig = crypto
    .createHmac("sha256", key_secret)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest("hex");

  if (!crypto.timingSafeEqual(Buffer.from(expectedSig), Buffer.from(razorpay_signature))) {
    logger.warn({ userId, razorpay_order_id }, "Razorpay signature mismatch");
    return res.status(400).json({ error: "Payment verification failed: invalid signature" });
  }

  try {
    // ── 2. Idempotency check ────────────────────────────────────────────────
    // If this payment_id has already been credited, return success without
    // modifying the wallet again.
    const { data: existingTx } = await supabaseAdmin
      .from("wallet_transactions")
      .select("amount, balance_after")
      .eq("reference_id", razorpay_payment_id)
      .eq("user_id", userId)
      .eq("type", "credit")
      .maybeSingle();

    if (existingTx) {
      logger.info({ userId, razorpay_payment_id }, "Duplicate verify — returning existing credit");
      return res.json({
        success: true,
        creditedUSD: existingTx.amount,
        newBalance: existingTx.balance_after,
        paymentId: razorpay_payment_id,
        duplicate: true,
      });
    }

    // ── 3. Fetch payment from Razorpay server-side (authoritative amount) ───
    const razorpay = getRazorpay();
    const payment = await razorpay.payments.fetch(razorpay_payment_id);

    // Validate that the payment belongs to the expected order
    if (payment.order_id !== razorpay_order_id) {
      logger.warn({ userId, razorpay_order_id, payment_order_id: payment.order_id }, "Payment order_id mismatch");
      return res.status(400).json({ error: "Payment does not match the expected order" });
    }

    // Payment must be captured (i.e. money actually moved)
    if (payment.status !== "captured") {
      logger.warn({ userId, razorpay_payment_id, status: payment.status }, "Payment not captured");
      return res.status(400).json({ error: `Payment not completed (status: ${payment.status})` });
    }

    // Currency guard — we only handle INR top-ups
    if (payment.currency !== "INR") {
      return res.status(400).json({ error: "Only INR payments are accepted" });
    }

    // Authoritative INR amount from Razorpay (paise → INR)
    const amountINR = Number(payment.amount) / 100;
    if (amountINR <= 0) {
      return res.status(400).json({ error: "Payment amount is zero" });
    }

    // ── 4. Convert INR → USD using server-side rate ──────────────────────────
    const inrRate = await getINRtoUSD();
    const amountUSD = amountINR / inrRate;

    // ── 5. Fetch wallet ──────────────────────────────────────────────────────
    const { data: wallet, error: walletErr } = await supabaseAdmin
      .from("wallets")
      .select("id, balance")
      .eq("user_id", userId)
      .single();

    if (walletErr || !wallet) {
      return res.status(404).json({ error: "Wallet not found" });
    }

    const newBalance = wallet.balance + amountUSD;

    // ── 6. Credit wallet (verify row was actually updated) ───────────────────
    const { data: updated, error: updateErr } = await supabaseAdmin
      .from("wallets")
      .update({ balance: newBalance, updated_at: new Date().toISOString() })
      .eq("id", wallet.id)
      .select("id");

    if (updateErr) throw updateErr;
    if (!updated || updated.length === 0) {
      throw new Error("Wallet update affected 0 rows");
    }

    // ── 7. Record transaction (reference_id = payment_id ensures idempotency) ─
    const { error: txErr } = await supabaseAdmin.from("wallet_transactions").insert({
      wallet_id: wallet.id,
      user_id: userId,
      type: "credit",
      amount: amountUSD,
      description: `Wallet top-up via Razorpay (₹${amountINR.toFixed(2)})`,
      reference_id: razorpay_payment_id,
      balance_after: newBalance,
    });

    if (txErr) {
      // Unique violation on reference_id = payment_id means a concurrent request
      // already inserted the transaction. The wallet balance update we just applied
      // was idempotent (same amount, same final value). Do NOT rollback — rolling
      // back here would undo the first request's legitimately credited balance.
      if (txErr.code === "23505") {
        logger.info({ userId, razorpay_payment_id }, "Concurrent verify — tx already inserted, returning success without rollback");
        return res.json({
          success: true,
          creditedUSD: amountUSD,
          newBalance,
          paymentId: razorpay_payment_id,
          duplicate: true,
        });
      }
      throw txErr;
    }

    logger.info({ userId, razorpay_payment_id, amountINR, amountUSD }, "Wallet credited via Razorpay");

    return res.json({
      success: true,
      creditedUSD: amountUSD,
      newBalance,
      paymentId: razorpay_payment_id,
    });
  } catch (err: unknown) {
    logger.error({ err, userId, razorpay_payment_id }, "Razorpay verify error");
    return res.status(500).json({ error: "Payment verification failed" });
  }
});

export default router;
