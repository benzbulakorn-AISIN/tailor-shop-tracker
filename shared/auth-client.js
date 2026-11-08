// shared/auth-client.js
// เรียก Edge Functions ที่เกี่ยวข้องกับ PIN Authentication (ไม่ยุ่งกับ Session State โดยตรง
// ดู session.js สำหรับการจัดการ Token/Device ในเครื่อง)

import { APP_CONFIG } from "./config.js";

async function callFunction(path, { method = "POST", body, accessToken, headers } = {}) {
  const res = await fetch(`${APP_CONFIG.FUNCTIONS_BASE_URL}/${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "apikey": APP_CONFIG.SUPABASE_ANON_KEY,
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(headers ?? {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error("เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
  }

  if (!res.ok || json.success === false) {
    const err = new Error(json.message || "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง");
    err.code = json.error_code;
    throw err;
  }

  return json;
}

export function listLoginIdentities() {
  return callFunction("list-login-identities");
}

export function pinLogin({ shopUserId, pin, rememberDevice, deviceLabel }) {
  return callFunction("pin-login", {
    body: {
      shop_user_id: shopUserId,
      pin,
      remember_device: !!rememberDevice,
      device_label: deviceLabel ?? null,
    },
  });
}

export function refreshSession({ deviceToken }) {
  return callFunction("refresh-session", {
    body: { device_token: deviceToken },
  });
}

export function changePin({ accessToken, currentPin, newPin }) {
  return callFunction("change-pin", {
    accessToken,
    body: { current_pin: currentPin, new_pin: newPin },
  });
}

export function logout({ accessToken }) {
  return callFunction("logout", { accessToken, body: {} });
}

export function revokeDevice({ accessToken, deviceId, reason }) {
  return callFunction("revoke-device", {
    accessToken,
    body: { device_id: deviceId, reason },
  });
}
