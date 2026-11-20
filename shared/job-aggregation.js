// shared/job-aggregation.js
// คำนวณสรุปข้อมูลสำหรับ Family Dashboard (Card สรุป, ปฏิทิน, ค้นหา/กรอง)
// ทำงานฝั่ง Client ล้วน ๆ จากข้อมูลที่ดึงมาครั้งเดียว (ดู shop-data-client.js)

import { getTodayBangkokISODate, normalizePhoneDigits, normalizeSearchText, getOwnerStatusKey } from "./utils.js";

function addDaysToISODate(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00`);
  d.setDate(d.getDate() + days);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

const ACTIVE_STATUSES = ["waiting", "in_progress"];
const NON_TERMINAL_STATUSES = ["pending_confirmation", "waiting", "in_progress", "completed"];

/**
 * คำนวณจำนวนงานสำหรับ Card สรุปทั้ง 7 ใบ
 */
export function computeDashboardCards(jobs) {
  const today = getTodayBangkokISODate();
  const tomorrow = addDaysToISODate(today, 1);
  const within3Days = addDaysToISODate(today, 3);

  const cards = {
    pendingConfirmation: jobs.filter((j) => j.status === "pending_confirmation"),
    dueToday: jobs.filter((j) => j.confirmed_pickup_date === today && ACTIVE_STATUSES.includes(j.status)),
    dueTomorrow: jobs.filter((j) => j.confirmed_pickup_date === tomorrow && ACTIVE_STATUSES.includes(j.status)),
    dueWithin3Days: jobs.filter(
      (j) => j.confirmed_pickup_date && j.confirmed_pickup_date >= today && j.confirmed_pickup_date <= within3Days
        && ACTIVE_STATUSES.includes(j.status),
    ),
    overdue: jobs.filter(
      (j) => j.confirmed_pickup_date && j.confirmed_pickup_date < today
        && NON_TERMINAL_STATUSES.includes(j.status) && j.status !== "completed",
    ),
    completedWaitingPickup: jobs.filter((j) => j.status === "completed"),
    notificationFailed: jobs.filter((j) => j._hasFailedNotification === true),
  };

  return cards;
}

/**
 * กรองงานตามเงื่อนไขที่ผู้ใช้เลือก (สถานะ, ประเภทงาน, ผู้รับผิดชอบ, ช่วงวันที่, คำค้นหา)
 */
export function filterJobs(jobs, criteria) {
  let result = jobs;

  if (criteria.status) {
    result = result.filter((j) => j.status === criteria.status);
  }
  if (criteria.jobTypeId) {
    result = result.filter((j) => j.job_type_id === criteria.jobTypeId);
  }
  if (criteria.assignedTo === "__unassigned__") {
    result = result.filter((j) => !j.assigned_to);
  } else if (criteria.assignedTo) {
    result = result.filter((j) => j.assigned_to === criteria.assignedTo);
  }
  if (criteria.dateFrom) {
    result = result.filter((j) => j.confirmed_pickup_date && j.confirmed_pickup_date >= criteria.dateFrom);
  }
  if (criteria.dateTo) {
    result = result.filter((j) => j.confirmed_pickup_date && j.confirmed_pickup_date <= criteria.dateTo);
  }
  if (criteria.searchText && criteria.searchText.trim().length > 0) {
    result = searchJobs(result, criteria.searchText);
  }

  return result;
}

/**
 * จัดกลุ่มงานตามวันที่นัดยืนยัน (confirmed_pickup_date) สำหรับปฏิทินแบบง่าย
 * คืนค่า Map: { "YYYY-MM-DD": [job, job, ...] }
 */
export function groupJobsByConfirmedDate(jobs) {
  const map = new Map();
  for (const job of jobs) {
    if (!job.confirmed_pickup_date) continue;
    if (!ACTIVE_STATUSES.includes(job.status)) continue;
    const list = map.get(job.confirmed_pickup_date) ?? [];
    list.push(job);
    map.set(job.confirmed_pickup_date, list);
  }
  return map;
}

/** สร้างโครงสร้างปฏิทินของเดือนที่กำหนด (ปี ค.ศ., เดือน 0-11) */
export function buildCalendarMonthGrid(year, month) {
  const firstDay = new Date(year, month, 1);
  const startWeekday = firstDay.getDay(); // 0=Sunday
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const cells = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let day = 1; day <= daysInMonth; day++) {
    const mm = String(month + 1).padStart(2, "0");
    const dd = String(day).padStart(2, "0");
    cells.push(`${year}-${mm}-${dd}`);
  }
  return cells;
}

// ============================================================================
// Search (find-as-you-type) — ค้นจาก job_number, customers.full_name, customers.phone
// ที่ shop-data-client.js ดึงมาอยู่แล้ว (ไม่เรียก Server เพิ่ม และไม่ใช้แทน RLS)
// ============================================================================
function compactText(value) {
  // ตัดช่องว่าง/ขีด/ขีดล่าง/สแลช เพื่อให้พิมพ์เลขงานแบบไม่ใส่ขีดก็เจอ
  return String(value ?? "").toLowerCase().replace(/[\s\-_/]/g, "");
}

export function searchJobs(jobs, searchText) {
  const q = normalizeSearchText(searchText);
  if (!q) return jobs;
  const qCompact = compactText(q);
  const qDigits = normalizePhoneDigits(q);
  return jobs.filter((j) => {
    const jobNumber = (j.job_number ?? "").toLowerCase();
    if (jobNumber.includes(q)) return true;
    if (qCompact && compactText(j.job_number).includes(qCompact)) return true;
    const name = (j.customers?.full_name ?? "").toLowerCase();
    if (name.includes(q)) return true;
    if (qDigits.length > 0 && normalizePhoneDigits(j.customers?.phone).includes(qDigits)) return true;
    return false;
  });
}

// ============================================================================
// Owner Dashboard helpers (เรียงงาน, ป้ายเลยกำหนด/วันนี้, สรุป 2 ใบ)
// ============================================================================

/** วันนัดที่ใช้งานจริง: ใช้ confirmed ก่อน ถ้ายังไม่มี (งานเก่าที่ยังไม่ยืนยัน) ใช้วันที่ลูกค้าเลือก */
export function getEffectivePickupDate(job) {
  return job.confirmed_pickup_date ?? job.requested_pickup_date ?? null;
}

export function getEffectivePickupTime(job) {
  return job.confirmed_pickup_time ?? job.requested_pickup_time_slot ?? "";
}

/** คืนค่า "overdue" | "today" | null สำหรับแสดงป้ายบนการ์ด */
export function getUrgencyTag(job, today = getTodayBangkokISODate()) {
  const key = getOwnerStatusKey(job.status);
  if (key === "picked_up" || key === "cancelled") return null;
  const date = getEffectivePickupDate(job);
  if (!date) return null;
  if (key === "received" && date < today) return "overdue";
  if (date === today) return "today";
  return null;
}

/**
 * เรียงงานสำหรับเจ้าของร้าน: เลยกำหนด -> กำหนดวันนี้ -> วันนัดใกล้สุด -> งานปิดแล้ว/ยกเลิกท้ายสุด
 * ไม่แก้ array เดิม
 */
export function sortJobsForOwner(jobs, today = getTodayBangkokISODate()) {
  function rank(job) {
    const key = getOwnerStatusKey(job.status);
    if (key === "picked_up" || key === "cancelled") return 3;
    const tag = getUrgencyTag(job, today);
    if (tag === "overdue") return 0;
    if (tag === "today") return 1;
    return 2;
  }
  return [...jobs].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    const da = getEffectivePickupDate(a) ?? "9999-12-31";
    const db = getEffectivePickupDate(b) ?? "9999-12-31";
    if (da !== db) return da.localeCompare(db);
    const ta = getEffectivePickupTime(a);
    const tb = getEffectivePickupTime(b);
    if (ta !== tb) return ta.localeCompare(tb);
    return String(a.job_number ?? "").localeCompare(String(b.job_number ?? ""));
  });
}

/** สรุปเหลือ 2 ตัวเลข: "งานที่ต้องทำ" (วันนี้+เลยกำหนด) และ "งานเสร็จรอรับ" */
export function computeOwnerSummary(jobs, today = getTodayBangkokISODate()) {
  const todo = jobs.filter((j) => {
    if (getOwnerStatusKey(j.status) !== "received") return false;
    const date = getEffectivePickupDate(j);
    return !!date && date <= today;
  });
  const completedWaitingPickup = jobs.filter((j) => j.status === "completed");
  return { todo, completedWaitingPickup };
}

