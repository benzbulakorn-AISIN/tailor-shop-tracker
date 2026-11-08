// shared/supabase-client.js
// สร้าง Supabase Client ฝั่ง Browser โดยใช้ Anon Key เท่านั้น (ปลอดภัย RLS คุมสิทธิ์จริง)
// Client ต้องถูกสร้างใหม่ทุกครั้งที่ Access Token (Custom JWT) เปลี่ยน เพราะ supabase-js v2
// ไม่มี API ให้ "สลับ" Header ของ Client ที่สร้างไปแล้วแบบ Dynamic

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { APP_CONFIG } from "./config.js";

let cachedClient = null;
let cachedToken = null;

/**
 * คืนค่า Supabase Client ที่ผูกกับ Access Token ปัจจุบัน
 * @param {string|null} accessToken - Custom JWT จาก pin-login/refresh-session (null = Anonymous)
 */
export function getSupabaseClient(accessToken = null) {
  if (cachedClient && cachedToken === accessToken) {
    return cachedClient;
  }

  cachedToken = accessToken;
  cachedClient = createClient(
    APP_CONFIG.SUPABASE_URL,
    APP_CONFIG.SUPABASE_ANON_KEY,
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: accessToken
        ? { headers: { Authorization: `Bearer ${accessToken}` } }
        : {},
    },
  );
  return cachedClient;
}

export function invalidateSupabaseClientCache() {
  cachedClient = null;
  cachedToken = null;
}
