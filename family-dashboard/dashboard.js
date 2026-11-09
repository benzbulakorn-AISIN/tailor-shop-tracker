// family-dashboard/dashboard.js
// Logic หลักของ Family Dashboard — เวอร์ชันลดปุ่มสูงสุดสำหรับผู้สูงอายุ (ต่อเนื่อง)
//
// สรุปการปรับปรุงรอบนี้ (ล่าสุด):
// 1) ซ่อนงานสถานะ "รับแล้ว" (picked_up) ออกจากรายการเป็นค่าเริ่มต้นอัตโนมัติ
//    พร้อมสวิตช์เล็กๆ ในแถบตัวกรองให้กดดูย้อนหลังได้ถ้าต้องการ
// 2) ย้ายการ์ด "LINE ส่งไม่สำเร็จ" ออกจากตารางสรุปใหญ่ ไปเป็นไอคอนกระดิ่งเล็กๆ
//    ข้างชื่อผู้ใช้ที่ Header แทน (มีตัวเลขนับแจ้งจำนวน) กดแล้วกรองแสดงเฉพาะงาน
//    ที่มีปัญหา ไม่แสดงไอคอนเลยถ้าไม่มีงานที่มีปัญหา
//
// (คงการแก้ไขรอบก่อนหน้าไว้ทั้งหมด: Event Delegation สำหรับแถบ 3 สถานะ,
// Auto-refresh ทุก 20 วินาที, ปุ่มรวมสำหรับยืนยันรับงาน/ชำระเงิน ฯลฯ)
import { listLoginIdentities } from "../shared/auth-client.js";
import {
  initSession, loginWithPin, logout, onSessionChange, getSessionSnapshot, getAccessToken,
} from "../shared/session.js";
import {
  showToast, preventDoubleSubmit, isValidPinFormat,
  formatThaiDate, formatThaiDateTime, getTodayBangkokISODate,
  generateIdempotencyKey,
} from "../shared/utils.js";
import {
  fetchJobsWindow, fetchJobImages, fetchJobIdsWithFailedNotifications, attachFailedNotificationFlag,
  fetchJobPaymentTransactions, computeTotalPaid, fetchJobCustomerNotifications,
} from "../shared/shop-data-client.js";
import {
  confirmAppointment, changeJobStatus, archiveJob,
} from "../shared/shop-actions-client.js";
import { setJobPricing, recordPayment, voidPayment } from "../shared/payment-client.js";
import { retryNotification } from "../shared/notification-client.js";
import { computeDashboardCards, filterJobs, buildCalendarMonthGrid, groupJobsByConfirmedDate } from "../shared/job-aggregation.js";
import { PICKUP_TIME_SLOTS, JOB_TYPES_FALLBACK } from "../shared/job-constants.js";
import { getSupabaseClient } from "../shared/supabase-client.js";

// ============================================================================
// Simplified Status Display (3 ระดับหลัก + ยกเลิก)
// ============================================================================
function getSimplifiedStatusKey(status) {
  if (status === "completed") return "completed";
  if (status === "picked_up") return "picked_up";
  if (status === "cancelled") return "cancelled";
  return "received"; // pending_confirmation, waiting, in_progress
}
const SIMPLIFIED_STATUS_DISPLAY = {
  received: { label: "รับเข้าระบบ", icon: "📋", color: "#1a73e8" },
  completed: { label: "เสร็จแล้ว", icon: "✅", color: "#1e8e3e" },
  picked_up: { label: "รับแล้ว", icon: "📦", color: "#5f6368" },
  cancelled: { label: "ยกเลิก", icon: "🚫", color: "#d93025" },
};
function getStatusDisplay(status) {
  return SIMPLIFIED_STATUS_DISPLAY[getSimplifiedStatusKey(status)];
}

// ============================================================================
// Identity Display Config (ลำดับ + ชื่อจริงในวงเล็บ)
// ============================================================================
const IDENTITY_NAME_OVERRIDES = {
  "00000000-0000-0000-0000-000000000001": "ณัฏฐา",
  "00000000-0000-0000-0000-000000000002": "บุลากร",
  "00000000-0000-0000-0000-000000000003": "กนกวรรณ",
  "00000000-0000-0000-0000-000000000004": "ธนวิทย์",
};
const ROLE_SORT_PRIORITY = { owner: 0, admin: 1, assistant: 2 };
function sortIdentitiesForLogin(identities) {
  return [...identities].sort((a, b) => {
    const pa = ROLE_SORT_PRIORITY[a.role] ?? 99;
    const pb = ROLE_SORT_PRIORITY[b.role] ?? 99;
    if (pa !== pb) return pa - pb;
    return a.id.localeCompare(b.id);
  });
}
function buildIdentityDisplayLabel(identity) {
  const cleanName = identity.full_name.replace(/\s*\(ตัวอย่าง\)\s*/g, "").trim();
  const personalName = IDENTITY_NAME_OVERRIDES[identity.id];
  return personalName ? `${cleanName} (${personalName})` : cleanName;
}

// ============================================================================
// State
// ============================================================================
const state = {
  allJobs: [],
  shopUsers: [],
  jobTypes: [],
  activeCard: null,
  showPickedUp: false, // ซ่อนงาน "รับแล้ว" เป็นค่าเริ่มต้น
  showNotifFailedOnly: false,
  filters: { status: "", jobTypeId: "", dateFrom: "", dateTo: "", searchText: "" },
  calendarYear: new Date().getFullYear(),
  calendarMonth: new Date().getMonth(),
  selectedCalendarDate: null,
  currentJobId: null,
};
const shopUserMap = new Map();

// ============================================================================
// Screen Elements
// ============================================================================
const screens = {
  loading: document.getElementById("screen-loading"),
  login: document.getElementById("screen-login"),
  dashboard: document.getElementById("screen-dashboard"),
};
function showScreen(name) {
  Object.values(screens).forEach((el) => el.classList.add("hidden"));
  screens[name].classList.remove("hidden");
}

// ============================================================================
// Offline Handling
// ============================================================================
const offlineBanner = document.getElementById("offline-banner");
function updateOfflineBanner() {
  offlineBanner.classList.toggle("hidden", navigator.onLine);
}
window.addEventListener("online", updateOfflineBanner);
window.addEventListener("offline", updateOfflineBanner);

// ============================================================================
// Login Flow
// ============================================================================
let selectedShopUserId = null;
async function loadIdentities() {
  try {
    const { identities } = await listLoginIdentities();
    const sortedIdentities = sortIdentitiesForLogin(identities);
    const listEl = document.getElementById("identity-list");
    const pinSectionEl = document.getElementById("pin-section");
    listEl.innerHTML = "";
    sortedIdentities.forEach((identity) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "identity-btn";
      btn.textContent = buildIdentityDisplayLabel(identity);
      btn.addEventListener("click", () => {
        selectedShopUserId = identity.id;
        document.getElementById("selected-name").textContent = buildIdentityDisplayLabel(identity);
        document.querySelectorAll(".identity-btn").forEach((b) => b.classList.remove("selected"));
        btn.classList.add("selected");
        pinSectionEl.classList.remove("hidden");
        document.getElementById("pin-input").focus();
      });
      listEl.appendChild(btn);
    });
  } catch (err) {
    showToast(err.message, "error");
  }
}
const handleLogin = preventDoubleSubmit(async () => {
  const pinInput = document.getElementById("pin-input");
  const loginBtn = document.getElementById("btn-login");
  const pin = pinInput.value.trim();
  if (!selectedShopUserId) {
    showToast("กรุณาเลือกชื่อผู้ใช้ก่อน", "error");
    return;
  }
  if (!isValidPinFormat(pin)) {
    showToast("PIN ต้องเป็นตัวเลข 6 หลัก", "error");
    return;
  }
  loginBtn.disabled = true;
  try {
    await loginWithPin({
      shopUserId: selectedShopUserId,
      pin,
      rememberDevice: document.getElementById("remember-device-checkbox").checked,
      deviceLabel: navigator.userAgent.slice(0, 60),
    });
    pinInput.value = "";
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    loginBtn.disabled = false;
  }
});
document.getElementById("btn-login").addEventListener("click", handleLogin);
document.getElementById("pin-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") handleLogin();
});
document.getElementById("btn-logout").addEventListener("click", preventDoubleSubmit(async () => {
  await logout();
  showToast("ออกจากระบบแล้ว", "info");
}));

// ============================================================================
// Session Change -> Switch Screens
// ============================================================================
onSessionChange((snapshot) => {
  if (snapshot.isLoggedIn) {
    showScreen("dashboard");
    document.getElementById("header-user-role").textContent =
      { owner: "เจ้าของร้าน", admin: "ผู้ดูแลระบบ", assistant: "ผู้ช่วยร้าน" }[snapshot.appRole] ?? snapshot.appRole;
    loadDashboardData();
    startAutoRefresh();
  } else {
    showScreen("login");
    loadIdentities();
    stopAutoRefresh();
  }
});

// ============================================================================
// Data Loading
// ============================================================================
async function loadDashboardData() {
  const token = getAccessToken();
  try {
    const [{ identities }] = await Promise.all([
      listLoginIdentities(),
      loadJobTypes(token),
    ]);
    state.shopUsers = identities;
    shopUserMap.clear();
    identities.forEach((u) => shopUserMap.set(u.id, u));
    const currentUser = shopUserMap.get(getSessionSnapshot().shopUserId);
    document.getElementById("header-user-name").textContent =
      currentUser ? buildIdentityDisplayLabel(currentUser) : "";
    populateJobTypeFilter();
    await refreshJobs();
  } catch (err) {
    showToast(err.message || "โหลดข้อมูลไม่สำเร็จ กรุณาลองใหม่อีกครั้ง", "error");
  }
}
async function loadJobTypes(token) {
  try {
    const supabase = getSupabaseClient(token);
    const { data, error } = await supabase
      .from("job_types")
      .select("id, code, label_th, allow_custom_detail, sort_order")
      .eq("is_active", true)
      .order("sort_order", { ascending: true });
    if (!error && data && data.length > 0) {
      state.jobTypes = data;
      return data;
    }
  } catch {
    // ตกไปใช้ Fallback
  }
  state.jobTypes = JOB_TYPES_FALLBACK.map((jt, idx) => ({ id: null, ...jt, sort_order: idx }));
  return state.jobTypes;
}
async function refreshJobs() {
  const token = getAccessToken();
  try {
    const [jobs, failedIdSet] = await Promise.all([
      fetchJobsWindow({ accessToken: token, includeArchived: false }),
      fetchJobIdsWithFailedNotifications({ accessToken: token }),
    ]);
    state.allJobs = attachFailedNotificationFlag(jobs, failedIdSet);
    renderAll();
  } catch (err) {
    showToast(err.message || "โหลดรายการงานไม่สำเร็จ", "error");
  }
}
document.getElementById("btn-refresh").addEventListener("click", preventDoubleSubmit(async () => {
  await refreshJobs();
  showToast("รีเฟรชข้อมูลสำเร็จ", "success");
}));

// ============================================================================
// Auto-refresh อัตโนมัติ (ทุก 20 วินาที) เพื่อให้เห็นงานใหม่จากลูกค้าทันที
// โดยไม่ต้องกดปุ่ม 🔄 เอง — จะไม่รีเฟรชถ้ามีหน้าต่างรายละเอียดงานเปิดอยู่
// เพื่อไม่ให้ข้อมูลที่กำลังกรอก/ดูอยู่เปลี่ยนแปลงกลางคัน
// ============================================================================
const AUTO_REFRESH_INTERVAL_MS = 20000;
let autoRefreshTimer = null;
function startAutoRefresh() {
  if (autoRefreshTimer) return;
  autoRefreshTimer = setInterval(async () => {
    if (!navigator.onLine) return;
    if (state.currentJobId !== null) return; // มีหน้าต่างงานเปิดอยู่ ไม่รบกวน
    if (!getSessionSnapshot().isLoggedIn) return;
    try {
      await refreshJobs();
    } catch {
      // เงียบไว้ ไม่ต้องรบกวนผู้ใช้ด้วย Error จากการรีเฟรชเบื้องหลัง
    }
  }, AUTO_REFRESH_INTERVAL_MS);
}
function stopAutoRefresh() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
}

// ============================================================================
// Header: ไอคอนแจ้งเตือน "LINE ส่งไม่สำเร็จ" (ย้ายมาจากการ์ดสรุปใหญ่)
// ============================================================================
function renderNotifFailedBadge() {
  const cardData = computeDashboardCards(state.allJobs);
  const failedJobs = cardData.notificationFailed ?? [];
  const btn = document.getElementById("btn-notif-failed");
  const countEl = document.getElementById("notif-failed-count");
  if (failedJobs.length === 0) {
    btn.classList.add("hidden");
    state.showNotifFailedOnly = false; // ถ้าไม่มีปัญหาแล้ว เลิกกรองค้างไว้
    return;
  }
  btn.classList.remove("hidden");
  countEl.classList.remove("hidden");
  countEl.textContent = failedJobs.length > 99 ? "99+" : String(failedJobs.length);
  btn.classList.toggle("active", state.showNotifFailedOnly);
}
document.getElementById("btn-notif-failed").addEventListener("click", () => {
  state.showNotifFailedOnly = !state.showNotifFailedOnly;
  if (state.showNotifFailedOnly) {
    state.activeCard = null;
    state.selectedCalendarDate = null;
  }
  renderAll();
  document.getElementById("job-list-anchor")?.scrollIntoView({ behavior: "smooth", block: "start" });
});

// ============================================================================
// Summary Cards (ตัด "LINE ส่งไม่สำเร็จ" ออกจากตารางนี้แล้ว — ย้ายไปอยู่ที่ Header)
// ============================================================================
// จัดกลุ่มการ์ดเป็น 2 ชุดตามความเร่งด่วน เพื่อให้ผู้สูงอายุเห็นสิ่งที่ต้องรีบทำก่อน:
// "urgent" = ต้องดูวันนี้ (การ์ดใหญ่ เรียงแนวตั้ง) และ "upcoming" = กำลังจะถึง (การ์ดเล็กกว่า)
// ยังคงมีทั้ง 6 การ์ดเท่าเดิม ไม่มีการเพิ่ม/ลดจำนวนปุ่ม เพียงจัดลำดับและเน้นสีใหม่
const CARD_DEFINITIONS = [
  { key: "overdue", label: "งานเลยกำหนด", icon: "⚠️", group: "urgent", tone: "red" },
  { key: "dueToday", label: "งานวันนี้", icon: "📅", group: "urgent", tone: "blue" },
  { key: "pendingConfirmation", label: "งานใหม่รอยืนยัน", icon: "🆕", group: "urgent", tone: "orange" },
  { key: "dueTomorrow", label: "งานพรุ่งนี้", icon: "📆", group: "upcoming", tone: "neutral" },
  { key: "dueWithin3Days", label: "งานภายใน 3 วัน", icon: "⏱️", group: "upcoming", tone: "neutral" },
  { key: "completedWaitingPickup", label: "เสร็จรอรับ", icon: "📦", group: "upcoming", tone: "green" },
];
function buildSummaryCard(def, cardData) {
  const jobs = cardData[def.key] ?? [];
  const card = document.createElement("div");
  card.className = `summary-card tone-${def.tone}` + (state.activeCard === def.key ? " active" : "");
  card.innerHTML = `
    <div class="icon">${def.icon}</div>
    <div>
      <div class="count">${jobs.length}</div>
      <div class="label">${def.label}</div>
    </div>
  `;
  card.addEventListener("click", () => {
    state.activeCard = state.activeCard === def.key ? null : def.key;
    state.selectedCalendarDate = null;
    state.showNotifFailedOnly = false;
    renderAll();
    document.getElementById("job-list-anchor")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  return card;
}
function renderSummaryCards() {
  const cardData = computeDashboardCards(state.allJobs);
  const container = document.getElementById("summary-grid");
  container.innerHTML = "";

  const urgentTitle = document.createElement("div");
  urgentTitle.className = "summary-group-title";
  urgentTitle.textContent = "📌 ต้องดูวันนี้";
  const urgentGrid = document.createElement("div");
  urgentGrid.className = "summary-grid";
  CARD_DEFINITIONS.filter((d) => d.group === "urgent").forEach((def) => {
    urgentGrid.appendChild(buildSummaryCard(def, cardData));
  });

  const upcomingTitle = document.createElement("div");
  upcomingTitle.className = "summary-group-title";
  upcomingTitle.textContent = "🗓️ งานที่กำลังจะถึง";
  const upcomingGrid = document.createElement("div");
  upcomingGrid.className = "summary-grid summary-grid-sub";
  CARD_DEFINITIONS.filter((d) => d.group === "upcoming").forEach((def) => {
    upcomingGrid.appendChild(buildSummaryCard(def, cardData));
  });

  container.appendChild(urgentTitle);
  container.appendChild(urgentGrid);
  container.appendChild(upcomingTitle);
  container.appendChild(upcomingGrid);
}
function getCardFilteredJobs() {
  if (state.showNotifFailedOnly) {
    const cardData = computeDashboardCards(state.allJobs);
    return cardData.notificationFailed ?? [];
  }
  if (!state.activeCard) return state.allJobs;
  const cardData = computeDashboardCards(state.allJobs);
  return cardData[state.activeCard] ?? [];
}

// ============================================================================
// Filters / Search
// ============================================================================
function populateJobTypeFilter() {
  const select = document.getElementById("filter-job-type");
  select.innerHTML = '<option value="">ประเภทงาน: ทั้งหมด</option>';
  state.jobTypes.forEach((jt) => {
    const opt = document.createElement("option");
    opt.value = jt.id ?? jt.code;
    opt.textContent = jt.label_th;
    select.appendChild(opt);
  });
}
document.getElementById("btn-toggle-filters").addEventListener("click", (e) => {
  const panel = document.getElementById("filter-panel");
  panel.classList.toggle("hidden");
  e.target.textContent = panel.classList.contains("hidden") ? "ตัวกรองเพิ่มเติม ▾" : "ตัวกรองเพิ่มเติม ▴";
});
document.getElementById("toggle-show-picked-up").addEventListener("change", (e) => {
  state.showPickedUp = e.target.checked;
  renderJobList();
});
function clearAllFilters() {
  state.filters = { status: "", jobTypeId: "", dateFrom: "", dateTo: "", searchText: "" };
  document.getElementById("search-input").value = "";
  document.getElementById("filter-status").value = "";
  document.getElementById("filter-job-type").value = "";
  document.getElementById("filter-date-from").value = "";
  document.getElementById("filter-date-to").value = "";
  state.activeCard = null;
  state.selectedCalendarDate = null;
  state.showNotifFailedOnly = false;
  renderAll();
}
function bindFilterInputs() {
  document.getElementById("search-input").addEventListener("input", (e) => {
    state.filters.searchText = e.target.value;
    renderJobList();
  });
  document.getElementById("filter-status").addEventListener("change", (e) => {
    state.filters.status = e.target.value;
    renderJobList();
  });
  document.getElementById("filter-job-type").addEventListener("change", (e) => {
    state.filters.jobTypeId = e.target.value;
    renderJobList();
  });
  document.getElementById("filter-date-from").addEventListener("change", (e) => {
    state.filters.dateFrom = e.target.value;
    renderJobList();
  });
  document.getElementById("filter-date-to").addEventListener("change", (e) => {
    state.filters.dateTo = e.target.value;
    renderJobList();
  });
  document.getElementById("btn-clear-filters").addEventListener("click", clearAllFilters);
  // ปุ่มเดียวกันนี้ยังโผล่ซ้ำในสถานะ "ไม่พบงาน" เพื่อให้ผู้สูงอายุกดกลับไปดูงานทั้งหมด
  // ได้ทันทีโดยไม่ต้องไล่หาตัวกรองที่ซ่อนอยู่ด้านบน (ใช้ฟังก์ชันเดียวกัน ไม่ใช่ฟีเจอร์ใหม่)
  document.getElementById("btn-clear-filters-empty")?.addEventListener("click", clearAllFilters);
}

// ============================================================================
// Calendar
// ============================================================================
function renderCalendar() {
  const monthLabel = document.getElementById("calendar-month-label");
  const weekdaysEl = document.getElementById("calendar-weekdays");
  const gridEl = document.getElementById("calendar-grid");
  const THAI_MONTH_SHORT = ["ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];
  monthLabel.textContent = `${THAI_MONTH_SHORT[state.calendarMonth]} ${state.calendarYear + 543}`;
  weekdaysEl.innerHTML = "";
  ["อา","จ","อ","พ","พฤ","ศ","ส"].forEach((d) => {
    const el = document.createElement("div");
    el.className = "calendar-weekday";
    el.textContent = d;
    weekdaysEl.appendChild(el);
  });
  const cells = buildCalendarMonthGrid(state.calendarYear, state.calendarMonth);
  const jobsByDate = groupJobsByConfirmedDate(state.allJobs);
  const today = getTodayBangkokISODate();
  gridEl.innerHTML = "";
  cells.forEach((isoDate) => {
    const cell = document.createElement("div");
    if (!isoDate) {
      cell.className = "calendar-cell empty";
      gridEl.appendChild(cell);
      return;
    }
    const dayNum = Number(isoDate.split("-")[2]);
    const jobsOnDay = jobsByDate.get(isoDate) ?? [];
    const activeJobsOnDay = jobsOnDay.filter((j) => j.status !== "picked_up" && j.status !== "cancelled");
    const isOverdueDay = isoDate < today && activeJobsOnDay.length > 0;
    let className = "calendar-cell";
    if (isoDate === today) className += " today";
    if (activeJobsOnDay.length > 0) className += " has-jobs";
    if (isOverdueDay) className += " has-jobs-late";
    if (isoDate === state.selectedCalendarDate) className += " selected";
    cell.className = className;
    cell.innerHTML = `<div>${dayNum}</div>${activeJobsOnDay.length > 0 ? `<div class="dot-count">${activeJobsOnDay.length}</div>` : ""}`;
    cell.addEventListener("click", () => {
      state.selectedCalendarDate = state.selectedCalendarDate === isoDate ? null : isoDate;
      state.activeCard = null;
      state.showNotifFailedOnly = false;
      renderAll();
      document.getElementById("job-list-anchor")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    gridEl.appendChild(cell);
  });
}
document.getElementById("btn-cal-prev").addEventListener("click", () => {
  state.calendarMonth -= 1;
  if (state.calendarMonth < 0) { state.calendarMonth = 11; state.calendarYear -= 1; }
  renderCalendar();
});
document.getElementById("btn-cal-next").addEventListener("click", () => {
  state.calendarMonth += 1;
  if (state.calendarMonth > 11) { state.calendarMonth = 0; state.calendarYear += 1; }
  renderCalendar();
});

// ============================================================================
// Job List
// ============================================================================
function renderJobList() {
  let jobs = getCardFilteredJobs();
  // ซ่อนงาน "รับแล้ว" เป็นค่าเริ่มต้น เว้นแต่เปิดสวิตช์ไว้ หรือกำลังดู Card/ตัวกรอง
  // ที่ต้องการงานกลุ่มนั้นโดยตรงอยู่แล้ว (เช่น ไม่ไปซ่อนซ้ำถ้าผู้ใช้เลือกสถานะ
  // "รับแล้ว" ในตัวกรองสถานะเองตรงๆ)
  if (!state.showPickedUp && state.filters.status !== "picked_up") {
    jobs = jobs.filter((j) => j.status !== "picked_up");
  }
  if (state.selectedCalendarDate) {
    jobs = jobs.filter((j) => j.confirmed_pickup_date === state.selectedCalendarDate);
  }
  jobs = filterJobs(jobs, state.filters);
  const listEl = document.getElementById("job-list");
  const emptyEl = document.getElementById("job-list-empty");
  document.getElementById("job-count").textContent = jobs.length;
  listEl.innerHTML = "";
  if (jobs.length === 0) {
    emptyEl.classList.remove("hidden");
    return;
  }
  emptyEl.classList.add("hidden");
  jobs.forEach((job) => {
    const statusInfo = getStatusDisplay(job.status);
    const card = document.createElement("div");
    card.className = "job-card";
    card.innerHTML = `
      ${job.customers?.phone ? `<a href="tel:${job.customers.phone}" class="quick-call-btn" title="โทรหาลูกค้า" onclick="event.stopPropagation()">📞</a>` : ""}
      <div class="job-card-top">
        <div>
          <div class="job-number">${job.job_number}</div>
          <div class="customer-name">${job.customers?.full_name ?? "-"}</div>
        </div>
        <span class="status-badge" style="background:${statusInfo.color}">${statusInfo.icon} ${statusInfo.label}</span>
      </div>
      <div class="job-card-meta">
        <span>✂️ ${job.job_types?.label_th ?? job.job_type_other ?? "-"}</span>
        ${job.confirmed_pickup_date ? `<span>📅 ${formatThaiDate(job.confirmed_pickup_date)} ${job.confirmed_pickup_time ?? ""} น.</span>` : `<span>📅 ต้องการ ${formatThaiDate(job.requested_pickup_date)}</span>`}
        ${job.is_urgent ? '<span class="urgent-tag">🚨 ด่วน</span>' : ""}
        ${job._hasFailedNotification ? '<span class="urgent-tag" style="background:#fff3e0;color:#e65100;">📵 LINE ไม่สำเร็จ</span>' : ""}
      </div>
    `;
    card.addEventListener("click", () => openJobModal(job.id));
    listEl.appendChild(card);
  });
}

// ============================================================================
// Render All
// ============================================================================
function renderAll() {
  renderNotifFailedBadge();
  renderSummaryCards();
  renderCalendar();
  renderJobList();
}

// ============================================================================
// Generic Confirm Dialog
// ============================================================================
function showConfirmDialog({ text, requireReason = false, confirmLabel = "ยืนยัน" }) {
  return new Promise((resolve) => {
    const backdrop = document.getElementById("confirm-dialog-backdrop");
    const textEl = document.getElementById("confirm-dialog-text");
    const reasonEl = document.getElementById("confirm-dialog-reason");
    const okBtn = document.getElementById("confirm-dialog-ok");
    const cancelBtn = document.getElementById("confirm-dialog-cancel");
    textEl.textContent = text;
    reasonEl.value = "";
    reasonEl.classList.toggle("hidden", !requireReason);
    okBtn.textContent = confirmLabel;
    backdrop.classList.remove("hidden");
    function cleanup() {
      backdrop.classList.add("hidden");
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
    }
    function onOk() {
      if (requireReason && reasonEl.value.trim().length === 0) {
        showToast("กรุณาระบุเหตุผล", "error");
        return;
      }
      cleanup();
      resolve({ confirmed: true, reason: reasonEl.value.trim() });
    }
    function onCancel() {
      cleanup();
      resolve({ confirmed: false, reason: null });
    }
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
  });
}

// ============================================================================
// Status Stepper (3 ขั้นหลัก: รับเข้าระบบ → เสร็จแล้ว → รับแล้ว)
// ============================================================================
const STEPPER_SEQUENCE = ["received", "completed", "picked_up"];
const STEPPER_LABELS = {
  received: "รับเข้าระบบ",
  completed: "เสร็จแล้ว",
  picked_up: "รับแล้ว",
};
function buildStepperHtml(status) {
  const simplified = getSimplifiedStatusKey(status);
  if (simplified === "cancelled") {
    return `<div class="stepper-cancelled-box">🚫 งานนี้ถูกยกเลิกแล้ว</div>`;
  }
  const currentIndex = STEPPER_SEQUENCE.indexOf(simplified);
  return `
    <div class="status-stepper" id="status-stepper">
      ${STEPPER_SEQUENCE.map((s, idx) => {
        const done = idx < currentIndex;
        const active = idx === currentIndex;
        const icon = done ? "✅" : (active ? "🔵" : "⚪");
        return `<div class="stepper-item ${active ? "active" : ""} ${done ? "done" : ""}" data-stepper-click="1" style="cursor:pointer;">
          <div class="stepper-icon">${icon}</div>
          <div>${STEPPER_LABELS[s]}</div>
        </div>`;
      }).join("")}
    </div>
  `;
}
/**
 * ผูก Event ให้แถบ 3 สถานะกดแล้วเลื่อนจอไปยังจุดที่ทำรายการได้จริง
 * ใช้วิธี Event Delegation ผูกไว้ที่ "job-modal-sheet" (Element แม่ที่ไม่เคยถูกแทนที่
 * ด้วย innerHTML เลย) ครั้งเดียวตอนเริ่มระบบ แทนการผูกทีละปุ่มทุกครั้งที่เปิดหน้าต่าง
 * วิธีนี้ทำงานแน่นอน ไม่ว่าจะเปิดหน้าต่างงานกี่ครั้งก็ตาม
 */
let currentStepperScrollTarget = "status-section";
document.getElementById("job-modal-sheet").addEventListener("click", (e) => {
  const stepperItem = e.target.closest("[data-stepper-click]");
  if (!stepperItem) return;
  document.getElementById(currentStepperScrollTarget)?.scrollIntoView({ behavior: "smooth", block: "start" });
});

// ============================================================================
// Job Detail Modal
// ============================================================================
const PAYMENT_METHOD_LABELS = { cash: "เงินสด", transfer: "โอนเงิน", qr: "QR Payment", other: "อื่น ๆ" };
const NOTIFICATION_STATUS_LABELS = {
  pending: { label: "รอส่ง", icon: "⏳", color: "#f9a825" },
  sent: { label: "ส่งสำเร็จ", icon: "✅", color: "#1e8e3e" },
  failed: { label: "ส่งไม่สำเร็จ", icon: "📵", color: "#d93025" },
};
const NOTIFICATION_TYPE_LABELS = {
  job_received: "รับคำขอฝากงาน",
  appointment_confirmed: "ยืนยันนัด",
  appointment_changed: "เปลี่ยนนัด",
  status_update: "แจ้งสถานะ",
  reminder: "แจ้งเตือน",
  other: "อื่น ๆ",
};
async function openJobModal(jobId) {
  state.currentJobId = jobId;
  const job = state.allJobs.find((j) => j.id === jobId);
  if (!job) return;
  const token = getAccessToken();
  const session = getSessionSnapshot();
  const isOwnerOrAdmin = session.appRole === "owner" || session.appRole === "admin";
  const isAdminOnly = session.appRole === "admin"; // เก็บถาวรเฉพาะ Admin
  const sheet = document.getElementById("job-modal-sheet");
  sheet.innerHTML = `<div class="center-screen"><div class="spinner"></div><p>กำลังโหลด...</p></div>`;
  document.getElementById("job-modal-backdrop").classList.remove("hidden");
  let images = [];
  let paymentTransactions = [];
  let customerNotifications = [];
  try {
    [images, paymentTransactions, customerNotifications] = await Promise.all([
      fetchJobImages({ accessToken: token, jobId }),
      fetchJobPaymentTransactions({ accessToken: token, jobId }),
      fetchJobCustomerNotifications({ accessToken: token, jobId }),
    ]);
  } catch {
    images = [];
    paymentTransactions = [];
    customerNotifications = [];
  }
  const statusInfo = getStatusDisplay(job.status);
  const quantityText = job.quantity_is_over_ten ? (job.quantity_note ?? "มากกว่า 10 ชิ้น") : `${job.quantity} ชิ้น`;
  const totalPaid = computeTotalPaid(paymentTransactions);
  const balance = job.price_final != null ? job.price_final - totalPaid : null;
  const isFullyPaid = job.price_estimate != null && balance != null && balance <= 0;
  const isPendingConfirmation = job.status === "pending_confirmation";
  sheet.innerHTML = `
    <button class="modal-close-btn" id="modal-close-btn">✕ ปิด</button>
    <h2>${job.job_number} <span class="status-badge" style="background:${statusInfo.color}">${statusInfo.icon} ${statusInfo.label}</span></h2>
    ${buildStepperHtml(job.status)}
    <div class="modal-section" style="border-top:none;margin-top:0;padding-top:0;">
      <h3>👤 ข้อมูลลูกค้า</h3>
      <div class="info-row"><span class="label">ชื่อ</span><span class="value">${job.customers?.full_name ?? "-"}</span></div>
      <div class="info-row"><span class="label">เบอร์โทร</span><span class="value">${job.customers?.phone ?? "-"}</span></div>
      ${job.customers?.phone ? `<a href="tel:${job.customers.phone}" class="btn btn-secondary" style="margin-top:8px;">📞 โทรหาลูกค้า</a>` : ""}
    </div>
    <div class="modal-section">
      <h3>✂️ ข้อมูลงาน</h3>
      <div class="info-row"><span class="label">ประเภทงาน</span><span class="value">${job.job_types?.label_th ?? job.job_type_other ?? "-"}</span></div>
      <div class="info-row"><span class="label">จำนวน</span><span class="value">${quantityText}</span></div>
      <div class="info-row"><span class="label">รายละเอียด</span><span class="value">${job.description ?? "-"}</span></div>
      <div class="info-row"><span class="label">หมายเหตุจากลูกค้า</span><span class="value">${job.customer_note ?? "-"}</span></div>
      <div class="info-row"><span class="label">วันที่ฝากงาน</span><span class="value">${formatThaiDate(job.created_at)}</span></div>
      <div class="info-row"><span class="label">วันที่ลูกค้าต้องการรับ</span><span class="value">${formatThaiDate(job.requested_pickup_date)} ${job.requested_pickup_time_slot} น.</span></div>
      ${job.confirmed_pickup_date ? `<div class="info-row"><span class="label">วันนัดที่ร้านยืนยัน</span><span class="value">${formatThaiDate(job.confirmed_pickup_date)} ${job.confirmed_pickup_time} น.</span></div>` : ""}
      ${job.is_urgent ? `<div class="urgent-tag" style="margin-top:6px;display:inline-block;">🚨 งานด่วน</div>` : ""}
    </div>
    ${images.length > 0 ? `
    <div class="modal-section">
      <h3>📷 รูปภาพ</h3>
      <div class="photo-grid-view">
        ${images.map((img) => `<img src="${img.signedUrl ?? ""}" alt="รูปงาน" />`).join("")}
      </div>
    </div>` : ""}
    <div class="modal-section" id="appointment-section"></div>
    <div class="modal-section" id="status-section">
      <h3>🔄 สถานะงาน</h3>
      <div id="status-buttons"></div>
    </div>
    <div class="modal-section" id="payment-section"></div>
    <div class="modal-section" id="notification-history-section"></div>
    ${isAdminOnly ? `
    <div class="modal-section">
      <h3>🗄️ จัดการงาน (เฉพาะผู้ดูแลระบบ)</h3>
      <button class="btn btn-danger" id="btn-archive-job">เก็บถาวรงานนี้ (Soft Delete)</button>
    </div>` : ""}
  `;
  document.getElementById("modal-close-btn").addEventListener("click", closeJobModal);
  currentStepperScrollTarget = isPendingConfirmation ? "appointment-section" : "status-section";
  renderAppointmentSection(job, isOwnerOrAdmin, isPendingConfirmation);
  renderStatusButtons(job, balance);
  renderPaymentSection(job, paymentTransactions, totalPaid, balance, isFullyPaid, isOwnerOrAdmin, isPendingConfirmation);
  renderNotificationHistorySection(customerNotifications, isOwnerOrAdmin, job.id);
  const archiveBtn = document.getElementById("btn-archive-job");
  if (archiveBtn) {
    archiveBtn.addEventListener("click", preventDoubleSubmit(async () => {
      const result = await showConfirmDialog({
        text: `ต้องการเก็บถาวรงาน ${job.job_number} ใช่หรือไม่? (งานจะไม่แสดงในรายการปกติอีกต่อไป)`,
        requireReason: true,
        confirmLabel: "เก็บถาวร",
      });
      if (!result.confirmed) return;
      try {
        await archiveJob({ accessToken: getAccessToken(), jobId, reason: result.reason });
        showToast("เก็บถาวรงานสำเร็จ", "success");
        await refreshJobs();
        closeJobModal();
      } catch (err) {
        showToast(err.message, "error");
      }
    }));
  }
}

// ============================================================================
// Notification History Section
// ============================================================================
function renderNotificationHistorySection(notifications, isOwnerOrAdmin, jobId) {
  const section = document.getElementById("notification-history-section");
  if (notifications.length === 0) {
    section.innerHTML = `
      <h3>📨 ประวัติการแจ้งเตือน LINE</h3>
      <div class="readonly-note">ยังไม่มีการแจ้งเตือนสำหรับงานนี้</div>
    `;
    return;
  }
  section.innerHTML = `
    <h3>📨 ประวัติการแจ้งเตือน LINE</h3>
    ${notifications.map((n) => {
      const statusInfo = NOTIFICATION_STATUS_LABELS[n.status] ?? { label: n.status, icon: "❔", color: "#999" };
      const typeLabel = NOTIFICATION_TYPE_LABELS[n.notification_type] ?? n.notification_type;
      return `
        <div class="payment-tx-card">
          <div class="payment-tx-top">
            <span>${typeLabel}</span>
            <span class="status-badge" style="background:${statusInfo.color}">${statusInfo.icon} ${statusInfo.label}</span>
          </div>
          <div class="payment-tx-meta">
            ${formatThaiDateTime(n.created_at)}
            ${n.status === "failed" && n.error_message ? `<br/>สาเหตุ: ${n.error_message}` : ""}
            ${n.retry_count > 0 ? `<br/>ลองส่งใหม่แล้ว ${n.retry_count} ครั้ง` : ""}
          </div>
          ${n.status === "failed" && isOwnerOrAdmin ? `<button class="btn btn-secondary btn-sm" data-retry-notif-id="${n.id}" style="margin-top:8px;">🔁 ลองส่งใหม่</button>` : ""}
        </div>
      `;
    }).join("")}
  `;
  if (isOwnerOrAdmin) {
    section.querySelectorAll("[data-retry-notif-id]").forEach((btn) => {
      btn.addEventListener("click", preventDoubleSubmit(async () => {
        const notifId = btn.getAttribute("data-retry-notif-id");
        btn.disabled = true;
        btn.textContent = "กำลังลองส่งใหม่...";
        try {
          await retryNotification({ accessToken: getAccessToken(), notificationId: notifId, notificationTable: "customer" });
          showToast("ส่งข้อความสำเร็จ", "success");
          openJobModal(jobId);
        } catch (err) {
          showToast(err.message, "error");
          btn.disabled = false;
          btn.textContent = "🔁 ลองส่งใหม่";
        }
      }));
    });
  }
}

// ============================================================================
// Appointment Section
// ============================================================================
function renderAppointmentSection(job, isOwnerOrAdmin, isPendingConfirmation) {
  const section = document.getElementById("appointment-section");
  if (!isOwnerOrAdmin) {
    if (isPendingConfirmation) {
      section.innerHTML = `<div class="warning-box">⏳ งานนี้รอการยืนยันนัดจากเจ้าของร้านหรือผู้ดูแลระบบ</div>`;
      return;
    }
    section.innerHTML = `
      <h3>💰 ราคาและวันนัด</h3>
      <div class="info-row"><span class="label">ราคาประเมิน</span><span class="value">${job.price_estimate != null ? job.price_estimate.toLocaleString() + " บาท" : "ยังไม่ระบุ"}</span></div>
      ${job.confirmed_pickup_date ? `<div class="info-row"><span class="label">วันนัดรับ</span><span class="value">${formatThaiDate(job.confirmed_pickup_date)} ${job.confirmed_pickup_time} น.</span></div>` : ""}
    `;
    return;
  }
  if (isPendingConfirmation) {
    section.innerHTML = `
      <h3>✅ ยืนยันรับงาน</h3>
      <label style="font-weight:600;">ราคาประเมิน (บาท)</label>
      <input type="number" min="0" step="0.01" class="price-input" id="price-estimate-input" placeholder="ยังไม่ระบุ" />
      <label style="font-weight:600;">เงินมัดจำ (บาท)</label>
      <div class="quick-percent-row">
        <button type="button" class="btn btn-secondary" id="btn-deposit-25">มัดจำ 25%</button>
        <button type="button" class="btn btn-secondary" id="btn-deposit-50">มัดจำ 50%</button>
      </div>
      <input type="number" min="0" step="0.01" class="price-input" id="deposit-amount-input" value="0" />
      <label style="font-weight:600;">วันที่ร้านยืนยัน</label>
      <input type="date" class="confirm-date-input" id="confirm-date-input" value="${job.requested_pickup_date}" />
      <label style="font-weight:600;">เวลาที่ร้านยืนยัน</label>
      <select class="confirm-time-select" id="confirm-time-select">
        ${PICKUP_TIME_SLOTS.map((t) => `<option value="${t}" ${t === job.requested_pickup_time_slot ? "selected" : ""}>${t} น.</option>`).join("")}
      </select>
      <button class="btn btn-primary btn-big-step" id="btn-confirm-appointment" style="margin-top:10px;">✅ ยืนยันรับงาน</button>
    `;
    function setDepositByPercent(percent) {
      const estEl = document.getElementById("price-estimate-input");
      const depositEl = document.getElementById("deposit-amount-input");
      const estimate = Number(estEl.value);
      if (!estEl.value || Number.isNaN(estimate) || estimate <= 0) {
        showToast("กรุณากรอกราคาประเมินก่อน", "error");
        return;
      }
      depositEl.value = Math.round(estimate * percent);
    }
    document.getElementById("btn-deposit-25").addEventListener("click", () => setDepositByPercent(0.25));
    document.getElementById("btn-deposit-50").addEventListener("click", () => setDepositByPercent(0.5));
    document.getElementById("btn-confirm-appointment").addEventListener("click", preventDoubleSubmit(async () => {
      const priceEstEl = document.getElementById("price-estimate-input");
      const depositEl = document.getElementById("deposit-amount-input");
      const confirmedDate = document.getElementById("confirm-date-input").value;
      const confirmedTime = document.getElementById("confirm-time-select").value;
      if (!confirmedDate || !confirmedTime) {
        showToast("กรุณาเลือกวันและเวลาให้ครบถ้วน", "error");
        return;
      }
      const priceEstimate = priceEstEl.value === "" ? null : Number(priceEstEl.value);
      const depositAmount = depositEl.value === "" ? 0 : Number(depositEl.value);
      if (
        (priceEstimate !== null && (Number.isNaN(priceEstimate) || priceEstimate < 0)) ||
        Number.isNaN(depositAmount) || depositAmount < 0
      ) {
        showToast("ราคาต้องเป็นตัวเลขที่ไม่ติดลบ", "error");
        return;
      }
      try {
        await setJobPricing({
          accessToken: getAccessToken(),
          jobId: job.id,
          priceEstimate,
          priceFinal: priceEstimate,
          depositAmount,
        });
        await confirmAppointment({
          accessToken: getAccessToken(),
          jobId: job.id,
          confirmedDate,
          confirmedTime,
          changeReason: null,
        });
        showToast("ยืนยันรับงานสำเร็จ", "success");
        await refreshJobs();
        closeJobModal();
      } catch (err) {
        showToast(err.message, "error");
      }
    }));
    return;
  }
  section.innerHTML = `
    <h3>💰 ราคาและวันนัด</h3>
    <label style="font-weight:600;">ราคาประเมิน (บาท)</label>
    <input type="number" min="0" step="0.01" class="price-input" id="price-estimate-input" value="${job.price_estimate ?? ""}" placeholder="ยังไม่ระบุ" />
    <label style="font-weight:600;">วันที่ร้านยืนยัน</label>
    <input type="date" class="confirm-date-input" id="confirm-date-input" value="${job.confirmed_pickup_date ?? job.requested_pickup_date}" />
    <label style="font-weight:600;">เวลาที่ร้านยืนยัน</label>
    <select class="confirm-time-select" id="confirm-time-select">
      ${PICKUP_TIME_SLOTS.map((t) => `<option value="${t}" ${t === job.confirmed_pickup_time ? "selected" : ""}>${t} น.</option>`).join("")}
    </select>
    <label style="font-weight:600;">เหตุผล (กรอกเฉพาะถ้าเปลี่ยนวันนัด)</label>
    <textarea class="note-input" id="reschedule-reason-input" placeholder="ระบุเหตุผล หากเปลี่ยนวันที่/เวลานัด..." style="min-height:50px;"></textarea>
    <button class="btn btn-primary" id="btn-save-price-and-appointment" style="margin-top:10px;">💾 บันทึก</button>
  `;
  document.getElementById("btn-save-price-and-appointment").addEventListener("click", preventDoubleSubmit(async () => {
    const priceEstEl = document.getElementById("price-estimate-input");
    const confirmedDate = document.getElementById("confirm-date-input").value;
    const confirmedTime = document.getElementById("confirm-time-select").value;
    const changeReason = document.getElementById("reschedule-reason-input").value.trim();
    if (!confirmedDate || !confirmedTime) {
      showToast("กรุณาเลือกวันและเวลาให้ครบถ้วน", "error");
      return;
    }
    const priceEstimate = priceEstEl.value === "" ? null : Number(priceEstEl.value);
    if (priceEstimate !== null && (Number.isNaN(priceEstimate) || priceEstimate < 0)) {
      showToast("ราคาต้องเป็นตัวเลขที่ไม่ติดลบ", "error");
      return;
    }
    const dateOrTimeChanged = confirmedDate !== job.confirmed_pickup_date || confirmedTime !== job.confirmed_pickup_time;
    if (dateOrTimeChanged && !changeReason) {
      showToast("กรุณาระบุเหตุผลที่เปลี่ยนวันนัด", "error");
      return;
    }
    try {
      await setJobPricing({
        accessToken: getAccessToken(),
        jobId: job.id,
        priceEstimate,
        priceFinal: priceEstimate,
        depositAmount: job.deposit_amount ?? 0,
      });
      if (dateOrTimeChanged) {
        await confirmAppointment({
          accessToken: getAccessToken(),
          jobId: job.id,
          confirmedDate,
          confirmedTime,
          changeReason,
        });
      }
      showToast("บันทึกสำเร็จ", "success");
      await refreshJobs();
      openJobModal(job.id);
    } catch (err) {
      showToast(err.message, "error");
    }
  }));
}

// ============================================================================
// Payment Section — 2 ปุ่มติ๊ก "ยังไม่ชำระ" / "ชำระแล้ว" (กดกลับได้ถ้าผิดพลาด)
// ============================================================================
function renderPaymentSection(job, transactions, totalPaid, balance, isFullyPaid, isOwnerOrAdmin, isPendingConfirmation) {
  const section = document.getElementById("payment-section");
  if (isPendingConfirmation) {
    section.innerHTML = "";
    return;
  }
  const hasPriceSet = job.price_estimate != null;
  const balanceHtml = hasPriceSet
    ? (isFullyPaid
        ? `<div class="balance-box"><div class="amount">0 บาท</div><div class="caption">ชำระครบแล้ว</div></div>`
        : `<div class="balance-box">
             <div class="amount">${balance.toLocaleString()} บาท</div>
             <div class="caption">ยอดคงเหลือ (ชำระแล้ว ${totalPaid.toLocaleString()} จาก ${job.price_estimate.toLocaleString()} บาท)</div>
           </div>`)
    : `<div class="warning-box">⚠️ ยังไม่ได้ระบุราคาประเมิน จึงยังคำนวณยอดคงเหลือไม่ได้</div>`;
  const activeTransactions = transactions.filter((tx) => !tx.is_voided);
  const transactionsHtml = transactions.length === 0
    ? ""
    : `<h3 style="font-size:0.95rem;margin-top:14px;">📜 ประวัติการชำระเงิน</h3>${transactions.map(renderPaymentTxCardHtml).join("")}`;
  section.innerHTML = `
    <h3>💳 การชำระเงิน</h3>
    <div class="payment-toggle-row">
      <button type="button" class="payment-toggle-btn ${!isFullyPaid ? "active-unpaid" : ""}" id="btn-mark-unpaid" ${(!isFullyPaid || !isOwnerOrAdmin) ? "disabled" : ""}>⭕ ยังไม่ชำระ</button>
      <button type="button" class="payment-toggle-btn ${isFullyPaid ? "active-paid" : ""}" id="btn-mark-paid" ${(!hasPriceSet || isFullyPaid) ? "disabled" : ""}>✅ ชำระแล้ว</button>
    </div>
    ${balanceHtml}
    ${transactionsHtml}
  `;
  if (hasPriceSet && !isFullyPaid) {
    document.getElementById("btn-mark-paid").addEventListener("click", preventDoubleSubmit(async () => {
      try {
        await recordPayment({
          accessToken: getAccessToken(),
          jobId: job.id,
          transactionType: "payment",
          amount: balance,
          paymentMethod: "cash",
          note: null,
          idempotencyKey: generateIdempotencyKey("pay"),
        });
        showToast("บันทึกชำระเงินสำเร็จ", "success");
        await refreshJobs();
        openJobModal(job.id);
      } catch (err) {
        showToast(err.message, "error");
      }
    }));
  }
  if (isFullyPaid && isOwnerOrAdmin) {
    document.getElementById("btn-mark-unpaid").addEventListener("click", preventDoubleSubmit(async () => {
      const result = await showConfirmDialog({
        text: "กดผิดใช่หรือไม่? ต้องการย้อนกลับเป็น \"ยังไม่ชำระ\" ใช่หรือไม่? (ระบบจะยกเลิกประวัติการรับเงินที่ยังไม่ถูกยกเลิกทั้งหมด)",
        requireReason: true,
        confirmLabel: "ยืนยันย้อนกลับ",
      });
      if (!result.confirmed) return;
      try {
        for (const tx of activeTransactions) {
          await voidPayment({ accessToken: getAccessToken(), transactionId: tx.id, voidReason: result.reason });
        }
        showToast("ย้อนกลับสำเร็จ", "success");
        await refreshJobs();
        openJobModal(job.id);
      } catch (err) {
        showToast(err.message, "error");
      }
    }));
  }
}
function renderPaymentTxCardHtml(tx) {
  return `
    <div class="payment-tx-card ${tx.is_voided ? "voided" : ""}">
      <div class="payment-tx-top">
        <span class="payment-tx-amount ${tx.transaction_type}">${tx.transaction_type === "refund" ? "-" : "+"}${tx.amount.toLocaleString()} บาท</span>
        ${tx.is_voided ? '<span class="voided-tag">ยกเลิกแล้ว</span>' : ""}
      </div>
      <div class="payment-tx-meta">
        ${PAYMENT_METHOD_LABELS[tx.payment_method] ?? tx.payment_method} • ${formatThaiDateTime(tx.received_at)} • โดย ${tx.shop_users?.full_name ?? "-"}
        ${tx.is_voided ? `<br/>เหตุผลยกเลิก: ${tx.void_reason ?? "-"} (โดย ${tx.voider?.full_name ?? "-"})` : ""}
      </div>
      ${tx.payment_evidence.length > 0 ? `
      <div class="payment-tx-evidence">
        ${tx.payment_evidence.map((ev) => `<img src="${ev.signedUrl ?? ""}" alt="หลักฐาน" />`).join("")}
      </div>` : ""}
    </div>
  `;
}

// ============================================================================
// Status Buttons
// ============================================================================
function renderStatusButtons(job, balance) {
  const container = document.getElementById("status-buttons");
  const simplified = getSimplifiedStatusKey(job.status);
  if (simplified === "cancelled" || simplified === "picked_up") {
    container.innerHTML = `<div class="readonly-note">ไม่มีการเปลี่ยนสถานะที่ทำได้ในขั้นตอนนี้</div>`;
    return;
  }
  if (simplified === "completed") {
    const hasBalance = job.price_estimate != null && balance != null && balance > 0;
    container.innerHTML = hasBalance
      ? `<button class="btn btn-success btn-big-step" id="btn-next-step">💰 จ่ายครบแล้ว + ลูกค้ารับแล้ว</button>
         <button class="btn btn-secondary btn-sm" id="btn-revert-step" style="margin-top:6px;">↩️ ย้อนกลับไปกำลังทำ</button>`
      : `<button class="btn btn-success btn-big-step" id="btn-next-step">📦 ลูกค้ารับแล้ว</button>
         <button class="btn btn-secondary btn-sm" id="btn-revert-step" style="margin-top:6px;">↩️ ย้อนกลับไปกำลังทำ</button>`;
    document.getElementById("btn-next-step").addEventListener("click", preventDoubleSubmit(async () => {
      try {
        if (hasBalance) {
          await recordPayment({
            accessToken: getAccessToken(),
            jobId: job.id,
            transactionType: "payment",
            amount: balance,
            paymentMethod: "cash",
            note: null,
            idempotencyKey: generateIdempotencyKey("pay"),
          });
        }
        await changeJobStatus({ accessToken: getAccessToken(), jobId: job.id, newStatus: "picked_up", reason: null });
        showToast("บันทึกสำเร็จ", "success");
        await refreshJobs();
        closeJobModal();
      } catch (err) {
        showToast(err.message, "error");
      }
    }));
    document.getElementById("btn-revert-step").addEventListener("click", preventDoubleSubmit(async () => {
      const result = await showConfirmDialog({
        text: "ต้องการย้อนกลับไปสถานะ \"รับเข้าระบบ (กำลังทำ)\" ใช่หรือไม่?",
        requireReason: false,
        confirmLabel: "ยืนยัน",
      });
      if (!result.confirmed) return;
      try {
        await changeJobStatus({ accessToken: getAccessToken(), jobId: job.id, newStatus: "in_progress", reason: null });
        showToast("เปลี่ยนสถานะสำเร็จ", "success");
        await refreshJobs();
        closeJobModal();
      } catch (err) {
        showToast(err.message, "error");
      }
    }));
    return;
  }
  if (job.status === "pending_confirmation") {
    container.innerHTML = `<div class="readonly-note">กรุณายืนยันรับงานในส่วนด้านบนก่อน จึงจะเปลี่ยนสถานะต่อได้</div>`;
    return;
  }
  container.innerHTML = `
    <button class="btn btn-success btn-big-step" id="btn-next-step">✅ งานเสร็จแล้ว</button>
    <button class="btn btn-secondary btn-sm" id="btn-cancel-step" style="margin-top:6px;color:var(--danger);border-color:var(--danger);">🚫 ยกเลิกงานนี้</button>
  `;
  document.getElementById("btn-next-step").addEventListener("click", preventDoubleSubmit(async () => {
    try {
      if (job.status === "waiting") {
        await changeJobStatus({ accessToken: getAccessToken(), jobId: job.id, newStatus: "in_progress", reason: null });
      }
      await changeJobStatus({ accessToken: getAccessToken(), jobId: job.id, newStatus: "completed", reason: null });
      showToast("เปลี่ยนสถานะสำเร็จ", "success");
      await refreshJobs();
      closeJobModal();
    } catch (err) {
      showToast(err.message, "error");
    }
  }));
  document.getElementById("btn-cancel-step").addEventListener("click", preventDoubleSubmit(async () => {
    const result = await showConfirmDialog({
      text: `ต้องการยกเลิกงาน ${job.job_number} ใช่หรือไม่?`,
      requireReason: true,
      confirmLabel: "ยกเลิกงาน",
    });
    if (!result.confirmed) return;
    try {
      await changeJobStatus({ accessToken: getAccessToken(), jobId: job.id, newStatus: "cancelled", reason: result.reason });
      showToast("เปลี่ยนสถานะสำเร็จ", "success");
      await refreshJobs();
      closeJobModal();
    } catch (err) {
      showToast(err.message, "error");
    }
  }));
}
function closeJobModal() {
  document.getElementById("job-modal-backdrop").classList.add("hidden");
  state.currentJobId = null;
}
document.getElementById("job-modal-backdrop").addEventListener("click", (e) => {
  if (e.target.id === "job-modal-backdrop") closeJobModal();
});

// ============================================================================
// Start
// ============================================================================
(async function start() {
  updateOfflineBanner();
  bindFilterInputs();
  showScreen("loading");
  const snapshot = await initSession();
  if (snapshot.isLoggedIn) {
    showScreen("dashboard");
    document.getElementById("header-user-role").textContent =
      { owner: "เจ้าของร้าน", admin: "ผู้ดูแลระบบ", assistant: "ผู้ช่วยร้าน" }[snapshot.appRole] ?? snapshot.appRole;
    await loadDashboardData();
    startAutoRefresh();
  } else {
    showScreen("login");
    await loadIdentities();
  }
})();
