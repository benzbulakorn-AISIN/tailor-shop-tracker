// shared/liff-adapter.js
// ชั้นกลาง (Adapter) คั่นระหว่างหน้าฟอร์มกับ LINE LIFF SDK จริง
//
// เหตุผลที่ต้องมีชั้นนี้: ร้านยังไม่มี LINE Official Account/LIFF App จริง
// (จะตั้งค่าใน Phase 8) จึงเปิด "โหมดจำลอง" (Mock Mode) ไว้ชั่วคราวผ่าน
// APP_CONFIG.LIFF_MOCK_MODE เพื่อให้ทดสอบฟอร์ม/อัปโหลดรูป/บันทึกงานได้ครบ Flow
// โดยไม่ต้องรอ LIFF จริง เมื่อถึง Phase 8 ให้เปลี่ยนค่า LIFF_MOCK_MODE เป็น false
// และใส่ LIFF_ID จริงใน config.js เท่านั้น ไม่ต้องแก้โค้ดหน้าฟอร์มใด ๆ เพิ่มเติม
//
// ข้อควรระวังด้านความปลอดภัย: Mock Mode ต้องถูกปิดเสมอใน Production จริง เพราะ
// client_id token ปลอมจะถูก Edge Function "customer-identify" ปฏิเสธอยู่ดี
// (ฝั่ง Server ตรวจสอบ ALLOW_MOCK_CUSTOMER_IDENTITY Secret แยกต่างหาก ถ้าปิดไว้
// จะใช้ Mock ไม่ได้แม้ Client จะส่งมาก็ตาม)

import { APP_CONFIG } from "./config.js";

const LIFF_SDK_URL = "https://static.line-scdn.net/liff/edge/versions/2.31.2/sdk.js";

let liffSdkLoadPromise = null;

function loadLiffSdkScript() {
  if (liffSdkLoadPromise) return liffSdkLoadPromise;
  liffSdkLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = LIFF_SDK_URL;
    script.onload = () => resolve(window.liff);
    script.onerror = () => reject(new Error("ไม่สามารถโหลด LINE LIFF SDK ได้ กรุณาตรวจสอบอินเทอร์เน็ต"));
    document.head.appendChild(script);
  });
  return liffSdkLoadPromise;
}

const MOCK_STORAGE_KEY = "qe_tailor_mock_line_identity";

function getOrCreateMockIdentity() {
  const existing = sessionStorage.getItem(MOCK_STORAGE_KEY);
  if (existing) return JSON.parse(existing);

  const mockIdentity = {
    userId: `MOCK-${crypto.randomUUID ? crypto.randomUUID() : Date.now()}`,
    displayName: "ลูกค้าทดสอบ (Mock)",
    pictureUrl: null,
  };
  sessionStorage.setItem(MOCK_STORAGE_KEY, JSON.stringify(mockIdentity));
  return mockIdentity;
}

/**
 * เตรียมความพร้อม LIFF (หรือจำลองถ้าอยู่ใน Mock Mode)
 * คืนค่า { isReady: boolean, isLoggedIn: boolean }
 */
export async function initLiff() {
  if (APP_CONFIG.LIFF_MOCK_MODE) {
    return { isReady: true, isLoggedIn: true, isMock: true };
  }

  const liff = await loadLiffSdkScript();
  await liff.init({ liffId: APP_CONFIG.LIFF_ID_CUSTOMER_FORM });

  if (!liff.isLoggedIn()) {
    liff.login();
    return { isReady: true, isLoggedIn: false, isMock: false };
  }

  return { isReady: true, isLoggedIn: true, isMock: false };
}

/**
 * ดึง "ID Token" ของผู้ใช้ LINE ปัจจุบัน (หรือ Mock Token ถ้าอยู่ใน Mock Mode)
 * ID Token นี้จะถูกส่งไปให้ Edge Function "customer-identify" ตรวจสอบกับ LINE
 * Platform โดยตรง (ไม่เชื่อข้อมูล Profile ที่ Client ส่งมาเองโดยตรง)
 */
export async function getLineIdentity() {
  if (APP_CONFIG.LIFF_MOCK_MODE) {
    const mockIdentity = getOrCreateMockIdentity();
    return {
      mode: "mock",
      mockCustomer: {
        line_user_id: mockIdentity.userId,
        display_name: mockIdentity.displayName,
      },
      idToken: null,
    };
  }

  const liff = window.liff;
  if (!liff || !liff.isLoggedIn()) {
    throw new Error("กรุณาเข้าสู่ระบบผ่าน LINE ก่อนดำเนินการต่อ");
  }

  const idToken = liff.getIDToken();
  if (!idToken) {
    throw new Error("ไม่สามารถยืนยันตัวตนผ่าน LINE ได้ กรุณาลองเปิดหน้านี้ผ่านแอป LINE ใหม่อีกครั้ง");
  }

  return { mode: "liff", idToken, mockCustomer: null };
}

export function isRunningInsideLineApp() {
  if (APP_CONFIG.LIFF_MOCK_MODE) return false;
  return !!(window.liff && window.liff.isInClient && window.liff.isInClient());
}

export function closeLiffWindow() {
  if (APP_CONFIG.LIFF_MOCK_MODE) return;
  if (window.liff && window.liff.isInClient && window.liff.isInClient()) {
    window.liff.closeWindow();
  }
}
