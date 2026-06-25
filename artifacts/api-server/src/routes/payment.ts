import { Router } from "express";
import Razorpay from "razorpay";
import crypto from "crypto";
import { requireAuth } from "../lib/auth";
import { supabaseAdmin } from "../lib/supabaseAdmin";

const router = Router();

function getRazorpay() {
  const key_id = process.env.RAZORPAY_KEY_ID;
  const key_secret = process.env.RAZORPAY_KEY_SECRET;
  if (!key_id || !key_secret) {
    throw new Error("Razorpay keys not configured");
  }
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

// POST /api/payment/razorpay/create-order
router.post("/razorpay/create-order", requireAuth, async (req, res) => {
  try {
    const { amountINR } = req.body;
    if (!amountINR || isNaN(Number(amountINR)) || Number(amountINR) < 1) {
      return res.status(400).json({ error: "Invalid amount. Minimum ₹1." });
    }

    const razorpay = getRazorpay();
    const amountPaise = Math.round(Number(amountINR) * 100);

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
    console.error("Razorpay create-order error:", err);
    return res.status(500).json({ error: msg });
  }
});

// POST /api/payment/razorpay/verify
router.post("/razorpay/verify", requireAuth, async (req, res) => {
  try {
    const userId = (req as any).userId as string;
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, amountINR } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !amountINR) {
      return res.status(400).json({ error: "Missing payment verification fields" });
    }

    const key_secret = process.env.RAZORPAY_KEY_SECRET;
    if (!key_secret) return res.status(503).json({ error: "Payment gateway not configured" });

    // Verify signature
    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto.createHmac("sha256", key_secret).update(body).digest("hex");
    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: "Payment verification failed: invalid signature" });
    }

    // Convert INR to USD
    const inrRate = await getINRtoUSD();
    const amountUSD = Number(amountINR) / inrRate;

    // Fetch wallet
    const { data: wallet, error: walletErr } = await supabaseAdmin
      .from("wallets")
      .select("*")
      .eq("user_id", userId)
      .single();

    if (walletErr || !wallet) {
      return res.status(404).json({ error: "Wallet not found" });
    }

    const newBalance = wallet.balance + amountUSD;

    // Credit wallet
    const { error: updateErr } = await supabaseAdmin
      .from("wallets")
      .update({ balance: newBalance, updated_at: new Date().toISOString() })
      .eq("user_id", userId);

    if (updateErr) throw updateErr;

    // Record transaction
    await supabaseAdmin.from("wallet_transactions").insert({
      wallet_id: wallet.id,
      user_id: userId,
      type: "credit",
      amount: amountUSD,
      description: `Wallet top-up via Razorpay (₹${amountINR})`,
      reference_id: razorpay_payment_id,
      balance_after: newBalance,
    });

    return res.json({
      success: true,
      creditedUSD: amountUSD,
      newBalance,
      paymentId: razorpay_payment_id,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Payment verification failed";
    console.error("Razorpay verify error:", err);
    return res.status(500).json({ error: msg });
  }
});

export default router;
