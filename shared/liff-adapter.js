// shared/liff-adapter.js
// ชั้นกลาง (Adapter) คั่นระหว่างหน้าฟอร์ม/หน้าสถานะกับ LINE LIFF SDK จริง
//
// สำคัญ: ไฟล์นี้ใช้ร่วมกันหลายหน้า (customer-form, customer-status) ซึ่งแต่ละ
// หน้ามี LIFF ID เป็นของตัวเอง (คนละ LIFF App กัน) initLiff() จึงต้องรับพารามิเตอร์
// ระบุว่าเป็นหน้าไหน แล้วเลือก LIFF ID ที่ถูกต้องจาก config.js ให้ตรงกับหน้านั้น
// (เวอร์ชันก่อนหน้านี้ Hardcode ใช้ LIFF_ID_CUSTOMER_FORM เสมอ ทำให้หน้าอื่น
// เรียก liff.init() ด้วย ID ผิดตัว และขึ้น Error "Invalid LIFF ID")
//
// เหตุผลที่ต้องมีชั้นนี้: ร้านยังไม่มี LINE Official Account/LIFF App จริงตอน
// Phase 4 จึงเปิด "โหมดจำลอง" (Mock Mode) ไว้ชั่วคราวผ่าน APP_CONFIG.LIFF_MOCK_MODE
// (ปัจจุบันปิดแล้วตั้งแต่ Phase 8 เพราะมี LINE Official Account จริง)

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

/** เลือก LIFF ID ที่ถูกต้องตามหน้าที่ระบุ ("form" หรือ "status") */
function resolveLiffId(page) {
  if (page === "status") return APP_CONFIG.LIFF_ID_CUSTOMER_STATUS;
  return APP_CONFIG.LIFF_ID_CUSTOMER_FORM;
}

/**
 * เตรียมความพร้อม LIFF (หรือจำลองถ้าอยู่ใน Mock Mode)
 * @param {"form"|"status"} page - ระบุว่าเป็นหน้าฝากงาน ("form") หรือหน้าเช็คสถานะ ("status")
 *                                 ค่าเริ่มต้นคือ "form" เพื่อไม่กระทบโค้ดเดิมที่เรียกแบบไม่ส่งพารามิเตอร์
 * คืนค่า { isReady: boolean, isLoggedIn: boolean }
 */
export async function initLiff(page = "form") {
  if (APP_CONFIG.LIFF_MOCK_MODE) {
    return { isReady: true, isLoggedIn: true, isMock: true };
  }

  const liffId = resolveLiffId(page);
  if (!liffId || liffId === "__REPLACE_WITH_LIFF_ID__") {
    throw new Error("ยังไม่ได้ตั้งค่า LIFF ID สำหรับหน้านี้ กรุณาติดต่อผู้ดูแลระบบ");
  }

  const liff = await loadLiffSdkScript();
  await liff.init({ liffId });

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
