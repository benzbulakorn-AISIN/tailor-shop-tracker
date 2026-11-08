// shared/customer-status-client.js
// อ่านข้อมูลงานของลูกค้า "ตัวเอง" เท่านั้น สำหรับหน้าตรวจสอบสถานะ (customer-status)
// ใช้ Customer JWT ที่ได้จาก customer-identify (เหมือนหน้าฝากงาน)
//
// ความปลอดภัย: RLS ของทุกตารางที่เรียกใช้ที่นี่ (jobs, job_images,
// customer_notifications, payment_transactions) บังคับกรองด้วย
// customer_id = fn_current_customer_id() จาก JWT เสมอ (ตั้งไว้ตั้งแต่ Phase 2)
// ดังนั้นแม้ลูกค้าจะพยายามแก้ไข Parameter ใน URL ก็ไม่สามารถเห็นงานของ
// ลูกค้าคนอื่นได้ — ฝั่ง Client นี้จึงไม่ต้อง Filter ซ้ำเอง (RLS เป็นผู้บังคับจริง)
//
// ฟิลด์ที่ตั้งใจไม่ดึงมาเลย (ตามข้อห้ามแสดงผลที่ระบุไว้): internal_note,
// audit_logs, line_user_id แบบเต็ม, ข้อมูลลูกค้าคนอื่น, ข้อมูลผู้ใช้งานฝั่งร้าน

import { getSupabaseClient } from "./supabase-client.js";

/** ดึงงานทั้งหมดของลูกค้าปัจจุบัน (เรียงจากใหม่ไปเก่า) */
export async function fetchMyJobs({ accessToken }) {
  const supabase = getSupabaseClient(accessToken);
  const { data, error } = await supabase
    .from("jobs")
    .select(`
      id, job_number, description, quantity, quantity_is_over_ten, quantity_note,
      requested_pickup_date, requested_pickup_time_slot,
      confirmed_pickup_date, confirmed_pickup_time,
      status, price_estimate, price_final, deposit_amount, payment_status,
      created_at,
      job_types ( label_th ),
      job_type_other
    `)
    .eq("is_archived", false)
    .order("created_at", { ascending: false });

  if (error) throw new Error("โหลดรายการงานไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
  return data ?? [];
}

/** ดึงรูปภาพของงาน 1 รายการ (เฉพาะของลูกค้าเอง ตาม RLS) */
export async function fetchMyJobImages({ accessToken, jobId }) {
  const supabase = getSupabaseClient(accessToken);
  const { data, error } = await supabase
    .from("job_images")
    .select("id, storage_path")
    .eq("job_id", jobId)
    .eq("is_deleted", false)
    .order("created_at", { ascending: true });

  if (error) return [];

  const withUrls = await Promise.all(
    (data ?? []).map(async (img) => {
      const { data: signed } = await supabase.storage
        .from("job-photos")
        .createSignedUrl(img.storage_path, 60 * 30); // 30 นาที
      return { ...img, signedUrl: signed?.signedUrl ?? null };
    }),
  );
  return withUrls;
}

/**
 * ดึงยอดชำระสุทธิของงาน 1 รายการ (ไม่แสดงรายการ Transaction ดิบให้ลูกค้าเห็น
 * ตามข้อกำหนด แสดงเฉพาะยอดสรุปที่จำเป็น)
 */
export async function fetchMyJobPaidTotal({ accessToken, jobId }) {
  const supabase = getSupabaseClient(accessToken);
  const { data, error } = await supabase
    .from("payment_transactions")
    .select("transaction_type, amount, is_voided")
    .eq("job_id", jobId);

  if (error) return 0;
  return (data ?? [])
    .filter((tx) => !tx.is_voided)
    .reduce((sum, tx) => sum + (tx.transaction_type === "payment" ? tx.amount : -tx.amount), 0);
}

/**
 * ดึงประวัติการแจ้งเตือนที่ "อนุญาตให้ลูกค้าเห็น" ของงาน 1 รายการ
 * แสดงเฉพาะประเภทและเวลา ไม่แสดงรายละเอียด Error/Retry ภายใน (เป็นข้อมูล
 * ปฏิบัติการของร้าน ไม่ใช่สิ่งที่ลูกค้าจำเป็นต้องเห็น)
 */
export async function fetchMyJobNotifications({ accessToken, jobId }) {
  const supabase = getSupabaseClient(accessToken);
  const { data, error } = await supabase
    .from("customer_notifications")
    .select("notification_type, status, created_at")
    .eq("job_id", jobId)
    .eq("status", "sent") // แสดงเฉพาะที่ส่งถึงจริงแล้วเท่านั้น
    .order("created_at", { ascending: true });

  if (error) return [];
  return data ?? [];
}
