// shared/customer-client.js
// เรียก Edge Function ฝั่งลูกค้า (customer-identify, submit-job) และจัดการ
// Customer JWT ในหน่วยความจำของหน้านี้เท่านั้น (ไม่ persist ข้ามการปิดหน้า เพราะ
// ลูกค้าเปิดฟอร์มผ่าน LIFF ใหม่ทุกครั้งที่สแกน QR หรือกดเมนูอยู่แล้ว)

import { APP_CONFIG } from "./config.js";

let customerAccessToken = null;
let customerId = null;

export function getCustomerAccessToken() {
  return customerAccessToken;
}

export function getCustomerId() {
  return customerId;
}

async function callFunction(path, { body, accessToken } = {}) {
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

/**
 * ยืนยันตัวตนลูกค้าผ่าน LINE (Production: idToken, Dev/Test: mockCustomer)
 * พร้อมบันทึก Consent และได้ Customer JWT กลับมา
 */
export async function identifyCustomer({ idToken, mockCustomer, consent }) {
  const result = await callFunction("customer-identify", {
    body: {
      id_token: idToken ?? null,
      mock_customer: mockCustomer ?? null,
      consent,
    },
  });
  customerAccessToken = result.access_token;
  customerId = result.customer_id;
  return result;
}

/**
 * ส่งฟอร์มฝากงาน (ต้องเรียก identifyCustomer ก่อนเสมอ)
 */
export async function submitJob(jobPayload) {
  if (!customerAccessToken) {
    throw new Error("กรุณายืนยันตัวตนผ่าน LINE ก่อนส่งข้อมูล");
  }
  return callFunction("submit-job", {
    accessToken: customerAccessToken,
    body: jobPayload,
  });
}
