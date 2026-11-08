// shared/shop-data-client.js
// อ่านข้อมูลงานสำหรับ Family Dashboard โดยตรงผ่าน Supabase Client (ใช้ Shop User
// JWT ของผู้ใช้ปัจจุบัน) — RLS บนตาราง jobs/customers/job_types อนุญาตให้ Shop
// Staff ทุก Role อ่านได้อยู่แล้ว (ดู 002_rls_policies.sql) จึงไม่จำเป็นต้องผ่าน
// Edge Function สำหรับการอ่านข้อมูลธรรมดา
//
// ข้อจำกัดที่ยอมรับได้ในสเกลนี้ (ร้านครอบครัวขนาดเล็ก ~150 งาน/เดือน):
// ดึงงานที่ยังไม่ถูก Archive มาทั้งหมด (สูงสุด 500 รายการล่าสุด) มาคำนวณสรุป/
// ค้นหา/กรองฝั่ง Client ทั้งหมด เพื่อลดความซับซ้อนของ Query ฝั่ง Server หากปริมาณ
// งานในอนาคตมากเกินกว่านี้มาก ควรปรับเป็น Pagination หรือ Query แบบ Server-side
// Filter แทน

import { getSupabaseClient } from "./supabase-client.js";

const JOB_FETCH_LIMIT = 500;

/**
 * ดึงงานทั้งหมดที่ยังไม่ถูก Archive (หรือเฉพาะที่ Archive ถ้า includeArchived=true)
 * พร้อมข้อมูลลูกค้าและประเภทงานที่ Join มาด้วย
 */
export async function fetchJobsWindow({ accessToken, includeArchived = false }) {
  const supabase = getSupabaseClient(accessToken);
  const { data, error } = await supabase
    .from("jobs")
    .select(`
      id, job_number, customer_id, job_type_id, job_type_other, description,
      quantity, quantity_is_over_ten, quantity_note,
      requested_pickup_date, requested_pickup_time_slot,
      confirmed_pickup_date, confirmed_pickup_time,
      status, is_urgent, assigned_to,
      price_estimate, price_final, deposit_amount, payment_status,
      cancel_reason, internal_note, customer_note,
      is_archived, created_at, updated_at,
      customers ( id, full_name, phone, line_user_id ),
      job_types ( id, code, label_th )
    `)
    .eq("is_archived", includeArchived)
    .order("created_at", { ascending: false })
    .limit(JOB_FETCH_LIMIT);

  if (error) {
    throw new Error("โหลดรายการงานไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
  }
  return data ?? [];
}

/** ดึงรูปภาพทั้งหมดของงาน 1 รายการ (ใช้ตอนเปิดดูรายละเอียด) */
export async function fetchJobImages({ accessToken, jobId }) {
  const supabase = getSupabaseClient(accessToken);
  const { data, error } = await supabase
    .from("job_images")
    .select("id, storage_path, image_type, created_at")
    .eq("job_id", jobId)
    .eq("is_deleted", false)
    .order("created_at", { ascending: true });

  if (error) throw new Error("โหลดรูปภาพไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");

  const withUrls = await Promise.all(
    (data ?? []).map(async (img) => {
      const { data: signed } = await supabase.storage
        .from("job-photos")
        .createSignedUrl(img.storage_path, 60 * 60);
      return { ...img, signedUrl: signed?.signedUrl ?? null };
    }),
  );
  return withUrls;
}

/** ดึงประวัติการเปลี่ยนสถานะของงาน 1 รายการ */
export async function fetchJobStatusHistory({ accessToken, jobId }) {
  const supabase = getSupabaseClient(accessToken);
  const { data, error } = await supabase
    .from("job_status_history")
    .select("id, previous_status, new_status, reason, created_at")
    .eq("job_id", jobId)
    .order("created_at", { ascending: true });

  if (error) throw new Error("โหลดประวัติสถานะไม่สำเร็จ");
  return data ?? [];
}

/** ดึงประวัติการนัดหมายของงาน 1 รายการ */
export async function fetchJobAppointments({ accessToken, jobId }) {
  const supabase = getSupabaseClient(accessToken);
  const { data, error } = await supabase
    .from("appointments")
    .select("id, confirmed_date, confirmed_time, previous_confirmed_date, previous_confirmed_time, change_reason, confirmed_at, notification_status")
    .eq("job_id", jobId)
    .order("created_at", { ascending: false });

  if (error) throw new Error("โหลดประวัติการนัดไม่สำเร็จ");
  return data ?? [];
}

/**
 * ดึงรายชื่อ job_id ที่มีการแจ้งเตือน LINE ส่งไม่สำเร็จ ใช้สำหรับ Card แจ้งเตือน
 * "งานที่มีปัญหาส่ง LINE ไม่สำเร็จ" บนหน้า Dashboard
 */
export async function fetchJobIdsWithFailedNotifications({ accessToken }) {
  const supabase = getSupabaseClient(accessToken);
  const { data, error } = await supabase
    .from("customer_notifications")
    .select("job_id")
    .eq("status", "failed")
    .not("job_id", "is", null);

  if (error) return new Set();
  return new Set((data ?? []).map((row) => row.job_id));
}

/** ผนวก flag _hasFailedNotification เข้ากับรายการงาน (ใช้ก่อนคำนวณ Card สรุป) */
export function attachFailedNotificationFlag(jobs, failedJobIdSet) {
  return jobs.map((j) => ({ ...j, _hasFailedNotification: failedJobIdSet.has(j.id) }));
}

/**
 * ดึงประวัติ Payment Transactions ของงาน 1 รายการ พร้อม Signed URL ของหลักฐาน
 * การชำระเงิน (ถ้ามี) และชื่อผู้รับเงิน
 */
export async function fetchJobPaymentTransactions({ accessToken, jobId }) {
  const supabase = getSupabaseClient(accessToken);
  const { data, error } = await supabase
    .from("payment_transactions")
    .select(`
      id, transaction_type, amount, payment_method, note,
      is_voided, voided_at, void_reason, received_at,
      shop_users!payment_transactions_received_by_fkey ( full_name ),
      voider:shop_users!payment_transactions_voided_by_fkey ( full_name ),
      payment_evidence ( id, storage_path )
    `)
    .eq("job_id", jobId)
    .order("received_at", { ascending: false });

  if (error) throw new Error("โหลดประวัติการชำระเงินไม่สำเร็จ");

  const rows = data ?? [];
  const withUrls = await Promise.all(
    rows.map(async (tx) => {
      const evidenceWithUrls = await Promise.all(
        (tx.payment_evidence ?? []).map(async (ev) => {
          const { data: signed } = await supabase.storage
            .from("payment-evidence")
            .createSignedUrl(ev.storage_path, 60 * 60);
          return { ...ev, signedUrl: signed?.signedUrl ?? null };
        }),
      );
      return { ...tx, payment_evidence: evidenceWithUrls };
    }),
  );
  return withUrls;
}

/** คำนวณยอดชำระสุทธิ (payment - refund เฉพาะที่ไม่ถูก Void) จากรายการ Transaction */
export function computeTotalPaid(transactions) {
  return transactions
    .filter((tx) => !tx.is_voided)
    .reduce((sum, tx) => sum + (tx.transaction_type === "payment" ? tx.amount : -tx.amount), 0);
}

/**
 * ดึงประวัติการแจ้งเตือน LINE หาลูกค้า ของงาน 1 รายการ (ใช้แสดงในส่วน
 * "ประวัติการแจ้งเตือน LINE" พร้อมปุ่มลองส่งใหม่สำหรับรายการที่ล้มเหลว)
 */
export async function fetchJobCustomerNotifications({ accessToken, jobId }) {
  const supabase = getSupabaseClient(accessToken);
  const { data, error } = await supabase
    .from("customer_notifications")
    .select("id, notification_type, message_content, status, error_message, sent_at, retry_count, created_at")
    .eq("job_id", jobId)
    .order("created_at", { ascending: false });

  if (error) throw new Error("โหลดประวัติการแจ้งเตือนไม่สำเร็จ");
  return data ?? [];
}
