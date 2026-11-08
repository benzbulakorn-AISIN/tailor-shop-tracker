// shared/job-aggregation.js
// คำนวณสรุปข้อมูลสำหรับ Family Dashboard (Card สรุป, ปฏิทิน, ค้นหา/กรอง)
// ทำงานฝั่ง Client ล้วน ๆ จากข้อมูลที่ดึงมาครั้งเดียว (ดู shop-data-client.js)

import { getTodayBangkokISODate } from "./utils.js";

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
    const q = criteria.searchText.trim().toLowerCase();
    result = result.filter((j) => {
      const customerName = (j.customers?.full_name ?? "").toLowerCase();
      const customerPhone = (j.customers?.phone ?? "").toLowerCase();
      const jobNumber = (j.job_number ?? "").toLowerCase();
      return customerName.includes(q) || customerPhone.includes(q) || jobNumber.includes(q);
    });
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
