// shared/payment-client.js
// เรียก Edge Function ที่เกี่ยวข้องกับราคาและการชำระเงิน

import { APP_CONFIG } from "./config.js";

async function callFunction(path, { accessToken, body } = {}) {
  const res = await fetch(`${APP_CONFIG.FUNCTIONS_BASE_URL}/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": APP_CONFIG.SUPABASE_ANON_KEY,
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });

  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error("เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ กรุณาตรวจสอบสัญญาณอินเทอร์เน็ตแล้วลองใหม่");
  }

  if (!res.ok || json.success === false) {
    const err = new Error(json.message || "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง");
    err.code = json.error_code;
    throw err;
  }
  return json;
}

export function setJobPricing({ accessToken, jobId, priceEstimate, priceFinal, depositAmount }) {
  return callFunction("set-job-pricing", {
    accessToken,
    body: {
      job_id: jobId,
      price_estimate: priceEstimate,
      price_final: priceFinal,
      deposit_amount: depositAmount,
    },
  });
}

export function recordPayment({ accessToken, jobId, transactionType, amount, paymentMethod, note, idempotencyKey }) {
  return callFunction("record-payment", {
    accessToken,
    body: {
      job_id: jobId,
      transaction_type: transactionType,
      amount,
      payment_method: paymentMethod,
      note: note ?? null,
      idempotency_key: idempotencyKey,
    },
  });
}

export function voidPayment({ accessToken, transactionId, voidReason }) {
  return callFunction("void-payment", {
    accessToken,
    body: { transaction_id: transactionId, void_reason: voidReason },
  });
}
