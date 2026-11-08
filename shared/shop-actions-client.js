// shared/shop-actions-client.js
// เรียก Edge Function ที่เกี่ยวข้องกับการกระทำบน Dashboard ฝั่งร้าน
// (ยืนยันนัด, เปลี่ยนสถานะ, มอบหมายงาน, บันทึกหมายเหตุ, Archive)

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

export function confirmAppointment({ accessToken, jobId, confirmedDate, confirmedTime, changeReason }) {
  return callFunction("confirm-appointment", {
    accessToken,
    body: {
      job_id: jobId,
      confirmed_date: confirmedDate,
      confirmed_time: confirmedTime,
      change_reason: changeReason ?? null,
    },
  });
}

export function changeJobStatus({ accessToken, jobId, newStatus, reason }) {
  return callFunction("change-job-status", {
    accessToken,
    body: { job_id: jobId, new_status: newStatus, reason: reason ?? null },
  });
}

export function assignJob({ accessToken, jobId, shopUserId }) {
  return callFunction("assign-job", {
    accessToken,
    body: { job_id: jobId, shop_user_id: shopUserId ?? null },
  });
}

export function addJobNote({ accessToken, jobId, internalNote }) {
  return callFunction("add-job-note", {
    accessToken,
    body: { job_id: jobId, internal_note: internalNote },
  });
}

export function archiveJob({ accessToken, jobId, reason }) {
  return callFunction("archive-job", {
    accessToken,
    body: { job_id: jobId, reason },
  });
}
