// shared/notification-client.js
// เรียก Edge Function "retry-notification" (ปุ่ม "ลองส่งใหม่" บน Dashboard)

import { APP_CONFIG } from "./config.js";

export async function retryNotification({ accessToken, notificationId, notificationTable }) {
  const res = await fetch(`${APP_CONFIG.FUNCTIONS_BASE_URL}/retry-notification`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": APP_CONFIG.SUPABASE_ANON_KEY,
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify({ notification_id: notificationId, notification_table: notificationTable }),
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
