// shared/session.js
// จัดการ Session ของผู้ใช้ฝั่งร้าน (Family Dashboard)
//
// หลักการ:
// - Access Token (Custom JWT อายุ 20 นาที) เก็บไว้ใน Memory เท่านั้น (ตัวแปรในไฟล์นี้)
//   ไม่เก็บลง LocalStorage/SessionStorage เพื่อลดความเสี่ยงถูกขโมยผ่าน XSS
// - Device Token (Remember Device) เก็บใน LocalStorage เพราะต้องอยู่ข้ามการปิดเบราว์เซอร์
//   แต่ Device Token เป็นเพียง "ตัวช่วยขอ Token ใหม่" เท่านั้น ทุกครั้งที่ใช้งานจะถูก
//   ตรวจสอบ Hash/วันหมดอายุ/สถานะเพิกถอนที่ Server เสมอ (ไม่ใช่หลักฐานยืนยันตัวตนลำพัง
//   ตามข้อกำหนดด้านความปลอดภัย)
// - เมื่อ Token ใกล้หมดอายุ ระบบจะต่ออายุอัตโนมัติผ่าน Device Token แบบเงียบ (Silent Refresh)
//   ถ้าไม่มี Device Token หรือต่ออายุไม่สำเร็จ จะต้องกลับไปหน้าใส่ PIN ใหม่

import { pinLogin, refreshSession, logout as logoutApi } from "./auth-client.js";
import { invalidateSupabaseClientCache } from "./supabase-client.js";

const DEVICE_TOKEN_KEY = "qe_tailor_device_token";
const DEVICE_TOKEN_EXPIRES_KEY = "qe_tailor_device_token_expires_at";

const REFRESH_MARGIN_MS = 3 * 60 * 1000; // ต่ออายุล่วงหน้า 3 นาทีก่อนหมดอายุจริง

let state = {
  accessToken: null,
  accessTokenExpiresAt: null, // epoch seconds
  shopUserId: null,
  appRole: null,
};

let refreshTimerId = null;
const listeners = new Set();

function notifyListeners() {
  for (const fn of listeners) fn(getSessionSnapshot());
}

export function onSessionChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getSessionSnapshot() {
  return {
    isLoggedIn: !!state.accessToken,
    shopUserId: state.shopUserId,
    appRole: state.appRole,
  };
}

export function getAccessToken() {
  return state.accessToken;
}

function clearRefreshTimer() {
  if (refreshTimerId) {
    clearTimeout(refreshTimerId);
    refreshTimerId = null;
  }
}

function scheduleAutoRefresh() {
  clearRefreshTimer();
  if (!state.accessTokenExpiresAt) return;

  const expiresAtMs = state.accessTokenExpiresAt * 1000;
  const delay = Math.max(expiresAtMs - Date.now() - REFRESH_MARGIN_MS, 5000);

  refreshTimerId = setTimeout(async () => {
    const ok = await tryRefreshFromDeviceToken();
    if (!ok) {
      clearSession("session_expired");
    }
  }, delay);
}

function persistDeviceToken(deviceToken, expiresAt) {
  if (!deviceToken) return;
  localStorage.setItem(DEVICE_TOKEN_KEY, deviceToken);
  localStorage.setItem(DEVICE_TOKEN_EXPIRES_KEY, expiresAt ?? "");
}

function getStoredDeviceToken() {
  const token = localStorage.getItem(DEVICE_TOKEN_KEY);
  const expiresAt = localStorage.getItem(DEVICE_TOKEN_EXPIRES_KEY);
  if (!token) return null;
  if (expiresAt && new Date(expiresAt) <= new Date()) {
    clearStoredDeviceToken();
    return null;
  }
  return token;
}

function clearStoredDeviceToken() {
  localStorage.removeItem(DEVICE_TOKEN_KEY);
  localStorage.removeItem(DEVICE_TOKEN_EXPIRES_KEY);
}

function applyLoginResult(result) {
  state.accessToken = result.access_token;
  state.accessTokenExpiresAt = result.expires_at;
  state.shopUserId = result.shop_user_id;
  state.appRole = result.app_role;
  invalidateSupabaseClientCache();
  scheduleAutoRefresh();
  notifyListeners();
}

export async function loginWithPin({ shopUserId, pin, rememberDevice, deviceLabel }) {
  const result = await pinLogin({ shopUserId, pin, rememberDevice, deviceLabel });
  applyLoginResult(result);
  if (result.device_token) {
    persistDeviceToken(result.device_token, result.device_token_expires_at);
  }
  return result;
}

export async function tryRefreshFromDeviceToken() {
  const deviceToken = getStoredDeviceToken();
  if (!deviceToken) return false;

  try {
    const result = await refreshSession({ deviceToken });
    applyLoginResult(result);
    return true;
  } catch (err) {
    // Device Token ใช้ไม่ได้แล้ว (หมดอายุ/ถูกเพิกถอน) -> ลบออกจากเครื่อง
    if (
      err.code === "DEVICE_TOKEN_INVALID" ||
      err.code === "DEVICE_TOKEN_EXPIRED" ||
      err.code === "DEVICE_TOKEN_REVOKED" ||
      err.code === "USER_INACTIVE"
    ) {
      clearStoredDeviceToken();
    }
    return false;
  }
}

/** เรียกตอนเปิดหน้าเว็บครั้งแรก เพื่อพยายาม Auto-Login ด้วย Device Token ที่จดจำไว้ */
export async function initSession() {
  if (state.accessToken) return getSessionSnapshot();
  await tryRefreshFromDeviceToken();
  return getSessionSnapshot();
}

export function clearSession() {
  clearRefreshTimer();
  state = {
    accessToken: null,
    accessTokenExpiresAt: null,
    shopUserId: null,
    appRole: null,
  };
  invalidateSupabaseClientCache();
  notifyListeners();
}

export async function logout() {
  const token = state.accessToken;
  try {
    if (token) await logoutApi({ accessToken: token });
  } catch {
    // แม้เรียก API ไม่สำเร็จ (เช่น Offline) ก็ยังต้องล้าง Session ฝั่ง Client เสมอ
  }
  clearStoredDeviceToken();
  clearSession();
}
