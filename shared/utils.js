// shared/utils.js
// Utility Functions ที่ใช้ร่วมกันทั้ง Customer Form, Customer Status และ Family Dashboard

import { APP_CONFIG } from "./config.js";

// ============================================================================
// Date/Time Formatting (Asia/Bangkok)
// ============================================================================

const THAI_MONTHS = [
  "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
  "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม",
];

/**
 * แปลง Date/ISOString ให้เป็นวันที่ภาษาไทยอ่านง่าย เช่น "12 พฤศจิกายน 2569"
 * ใช้ปี พ.ศ. ตามความคุ้นเคยของผู้ใช้ไทย
 */
export function formatThaiDate(dateInput) {
  const date = toDateInBangkok(dateInput);
  const day = date.getDate();
  const month = THAI_MONTHS[date.getMonth()];
  const buddhistYear = date.getFullYear() + 543;
  return `${day} ${month} ${buddhistYear}`;
}

/** แปลงเวลาเป็นรูปแบบ HH:MM น. ตามเวลาไทย */
export function formatThaiTime(dateInput) {
  const date = toDateInBangkok(dateInput);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm} น.`;
}

export function formatThaiDateTime(dateInput) {
  return `${formatThaiDate(dateInput)} เวลา ${formatThaiTime(dateInput)}`;
}

/** คืนค่า Date Object ที่ปรับให้ตรงกับเวลา Asia/Bangkok (สำหรับแสดงผลเท่านั้น) */
function toDateInBangkok(dateInput) {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: APP_CONFIG.DISPLAY_TIMEZONE ?? "Asia/Bangkok",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  return new Date(
    `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`,
  );
}

/** คืนค่าวันที่ปัจจุบันตามเวลาไทยในรูปแบบ YYYY-MM-DD (สำหรับใส่ลงฟอร์ม/Date Input) */
export function getTodayBangkokISODate() {
  const date = toDateInBangkok(new Date());
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** คืนค่าเวลาปัจจุบันตามเวลาไทยในรูปแบบ HH:MM */
export function getNowBangkokTime() {
  const date = toDateInBangkok(new Date());
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

// ============================================================================
// Validation
// ============================================================================

/** ตรวจสอบรูปแบบเบอร์โทรไทย (9-10 หลัก อนุญาตมี -, (), เว้นวรรค) */
export function isValidThaiPhone(phone) {
  const digitsOnly = phone.replace(/[^0-9]/g, "");
  return /^0[0-9]{8,9}$/.test(digitsOnly);
}

export function isValidPinFormat(pin) {
  return /^[0-9]{6}$/.test(pin);
}

// ============================================================================
// Safe Text Helpers (ป้องกัน XSS เมื่อจำเป็นต้องประกอบ HTML ด้วย Template String)
// ============================================================================

/**
 * Escape ข้อความจากผู้ใช้/ลูกค้าก่อนฝังลงใน HTML (ชื่อ, รายละเอียด, หมายเหตุ, error_message ฯลฯ)
 * ใช้ได้ทั้งในเนื้อหา Element และค่า Attribute ที่อยู่ในเครื่องหมายคำพูด
 */
export function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** เหลือเฉพาะตัวเลขของเบอร์โทร (ตัดช่องว่าง, ขีด, วงเล็บ ฯลฯ) สำหรับเปรียบเทียบในการค้นหา */
export function normalizePhoneDigits(value) {
  return String(value ?? "").replace(/[^0-9]/g, "");
}

/** ปรับข้อความค้นหาให้เทียบกันได้: ตัวพิมพ์เล็ก + ตัดช่องว่างหัวท้าย */
export function normalizeSearchText(value) {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * แปลง Error ของเครือข่าย (เช่น "Failed to fetch" ภาษาอังกฤษ) ให้เป็นข้อความไทยที่บอกวิธีแก้
 * ใช้ครอบ catch ของ Action สำคัญ เพื่อไม่ให้ผู้ใช้เข้าใจผิดว่าบันทึกสำเร็จ
 */
export function toFriendlyErrorMessage(err, fallback = "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง") {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return "ไม่มีสัญญาณอินเทอร์เน็ต ยังไม่ได้บันทึก กรุณาต่อสัญญาณแล้วลองใหม่";
  }
  if (err instanceof TypeError) {
    return "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ ยังไม่ได้บันทึก กรุณาตรวจสอบสัญญาณแล้วลองใหม่";
  }
  return err?.message || fallback;
}

// ============================================================================
// Idempotency Key (ป้องกันการส่งซ้ำ เช่น Submit ฟอร์ม, บันทึกรับเงิน)
// ============================================================================

export function generateIdempotencyKey(prefix = "idem") {
  const randomPart = crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${randomPart}`;
}

// ============================================================================
// Double-Submit Prevention
// ============================================================================

/**
 * ห่อฟังก์ชัน Async ไม่ให้ถูกเรียกซ้ำซ้อนระหว่างที่ยังทำงานค้างอยู่
 * ใช้กับปุ่ม Submit/บันทึก เพื่อป้องกันผู้ใช้กดซ้ำ
 */
export function preventDoubleSubmit(asyncFn) {
  let isRunning = false;
  return async (...args) => {
    if (isRunning) return;
    isRunning = true;
    try {
      return await asyncFn(...args);
    } finally {
      isRunning = false;
    }
  };
}

// ============================================================================
// Toast / Feedback UI (ไม่พึ่ง Framework ใด ๆ)
// ============================================================================

let toastContainer = null;

function ensureToastContainer() {
  if (toastContainer) return toastContainer;
  toastContainer = document.createElement("div");
  toastContainer.setAttribute("aria-live", "polite");
  toastContainer.style.cssText = [
    "position:fixed", "left:50%", "bottom:24px", "transform:translateX(-50%)",
    "display:flex", "flex-direction:column", "gap:8px", "z-index:9999",
    "width:min(92vw,420px)", "pointer-events:none",
  ].join(";");
  document.body.appendChild(toastContainer);
  return toastContainer;
}

const TOAST_STYLES = {
  success: { bg: "#1e8e3e", icon: "✅" },
  error: { bg: "#d93025", icon: "⚠️" },
  info: { bg: "#1a73e8", icon: "ℹ️" },
};

/**
 * แสดง Toast แจ้งผลการทำงาน
 * @param {string} message - ข้อความภาษาไทย
 * @param {"success"|"error"|"info"} type
 */
export function showToast(message, type = "info", durationMs = 3200) {
  const container = ensureToastContainer();
  const style = TOAST_STYLES[type] ?? TOAST_STYLES.info;

  const toastEl = document.createElement("div");
  toastEl.textContent = `${style.icon} ${message}`;
  toastEl.style.cssText = [
    `background:${style.bg}`, "color:#fff", "padding:14px 18px",
    "border-radius:12px", "font-size:16px", "font-family:inherit",
    "box-shadow:0 4px 14px rgba(0,0,0,0.25)", "text-align:center",
    "pointer-events:auto",
  ].join(";");

  container.appendChild(toastEl);
  setTimeout(() => {
    toastEl.style.transition = "opacity 0.3s";
    toastEl.style.opacity = "0";
    setTimeout(() => toastEl.remove(), 300);
  }, durationMs);
}

// ============================================================================
// Image Compression (ก่อน Upload ขึ้น Supabase Storage)
// ============================================================================

/**
 * บีบอัดไฟล์รูปภาพให้มีขนาดไม่เกิน maxWidth/maxHeight และคุณภาพที่กำหนด
 * คืนค่าเป็น Blob พร้อม Upload
 */
export function compressImage(file, { maxWidth = 1600, maxHeight = 1600, quality = 0.75 } = {}) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();

    reader.onerror = () => reject(new Error("ไม่สามารถอ่านไฟล์รูปภาพได้"));
    reader.onload = (e) => {
      img.onerror = () => reject(new Error("ไฟล์รูปภาพไม่ถูกต้องหรือเสียหาย"));
      img.onload = () => {
        let { width, height } = img;
        if (width > maxWidth || height > maxHeight) {
          const ratio = Math.min(maxWidth / width, maxHeight / height);
          width = Math.round(width * ratio);
          height = Math.round(height * ratio);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob(
          (blob) => {
            if (!blob) {
              reject(new Error("บีบอัดรูปภาพไม่สำเร็จ"));
              return;
            }
            resolve(blob);
          },
          "image/jpeg",
          quality,
        );
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB (ต้องตรงกับ Storage Bucket Limit)

/** ตรวจสอบชนิดและขนาดไฟล์รูปภาพก่อน Upload (ตรวจซ้ำอีกชั้นฝั่ง Client) */
export function validateImageFile(file) {
  if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
    return { valid: false, message: "รองรับเฉพาะไฟล์รูปภาพ JPEG, PNG หรือ WEBP เท่านั้น" };
  }
  if (file.size > MAX_IMAGE_SIZE_BYTES) {
    return { valid: false, message: "ไฟล์รูปภาพมีขนาดใหญ่เกิน 5MB" };
  }
  return { valid: true };
}

/** สุ่มชื่อไฟล์ใหม่เสมอ (ห้ามใช้ชื่อไฟล์จากผู้ใช้โดยตรงตามข้อกำหนดความปลอดภัย) */
export function generateRandomFileName(originalFile) {
  const ext = (originalFile.type.split("/")[1] ?? "jpg").replace("jpeg", "jpg");
  const randomId = crypto.randomUUID ? crypto.randomUUID() : generateIdempotencyKey("file");
  return `${randomId}.${ext}`;
}

// ============================================================================
// Fetch Wrapper พร้อมจัดการ Error แบบมาตรฐาน (ใช้กับ Supabase REST/PostgREST ตรง ๆ หากจำเป็น)
// ============================================================================

export async function safeFetch(url, options = {}) {
  try {
    const res = await fetch(url, options);
    if (!res.ok) {
      let message = "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง";
      try {
        const body = await res.json();
        message = body.message ?? message;
      } catch {
        // เพิกเฉยต่อ Body ที่ไม่ใช่ JSON
      }
      throw new Error(message);
    }
    return await res.json();
  } catch (err) {
    if (err instanceof TypeError) {
      // เครือข่ายหลุด / เรียก Fetch ไม่สำเร็จ
      throw new Error("อินเทอร์เน็ตหลุดหรือเชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจสอบสัญญาณแล้วลองใหม่");
    }
    throw err;
  }
}

// ============================================================================
// ค่าคงที่: สถานะงาน และการแสดงผล (Icon + สี + ข้อความ ไม่ใช้สีอย่างเดียว)
// ============================================================================

export const JOB_STATUS_DISPLAY = {
  pending_confirmation: { label: "รอยืนยันนัด", icon: "⏳", color: "#f9a825" },
  waiting: { label: "รอทำ", icon: "📋", color: "#1a73e8" },
  in_progress: { label: "กำลังทำ", icon: "✂️", color: "#8e24aa" },
  completed: { label: "เสร็จแล้ว", icon: "✅", color: "#1e8e3e" },
  picked_up: { label: "ลูกค้ารับแล้ว", icon: "📦", color: "#5f6368" },
  cancelled: { label: "ยกเลิก", icon: "🚫", color: "#d93025" },
};

export const PAYMENT_STATUS_DISPLAY = {
  unpaid: { label: "ยังไม่ชำระ", icon: "⭕", color: "#d93025" },
  deposit_paid: { label: "ชำระมัดจำแล้ว", icon: "🔸", color: "#f9a825" },
  paid: { label: "ชำระครบแล้ว", icon: "✅", color: "#1e8e3e" },
  refunded: { label: "คืนเงินแล้ว", icon: "↩️", color: "#5f6368" },
};

// ============================================================================
// สถานะที่ "เจ้าของร้าน" เห็น (รวมสถานะภายในเดิมให้เหลือ 4 ป้าย)
// สถานะจริงในฐานข้อมูลยังมี 6 ค่าเหมือนเดิม (Compatibility) นี่คือการรวมป้ายแสดงผลเท่านั้น
// pending_confirmation / waiting / in_progress -> "รับเข้าระบบ"
// ============================================================================
export function getOwnerStatusKey(status) {
  if (status === "completed") return "completed";
  if (status === "picked_up") return "picked_up";
  if (status === "cancelled") return "cancelled";
  return "received";
}

export const OWNER_STATUS_DISPLAY = {
  received: { label: "รับเข้าระบบ", icon: "📋", color: "#1a5276" },
  completed: { label: "เสร็จแล้ว", icon: "✅", color: "#1e8e3e" },
  picked_up: { label: "รับแล้ว/ปิดงาน", icon: "📦", color: "#5f6368" },
  cancelled: { label: "ยกเลิก", icon: "🚫", color: "#d93025" },
};

export function getOwnerStatusDisplay(status) {
  return OWNER_STATUS_DISPLAY[getOwnerStatusKey(status)];
}
