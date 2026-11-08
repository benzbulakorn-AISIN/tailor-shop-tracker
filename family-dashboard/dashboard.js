// family-dashboard/dashboard.js
// Logic หลักของ Family Dashboard (Phase 5-7 รวมกัน + ปรับปรุงความง่ายในการใช้งาน)
//
// สรุปการปรับปรุงรอบนี้:
// 1) ชื่อหน้า Login จัดเป็น 2 บรรทัดแบบตั้งใจ (ไม่ใช่ตกบรรทัดมั่วๆ)
// 2) รวมส่วน "ราคา" + "หมายเหตุภายใน" เป็นปุ่มเดียว "บันทึกข้อมูลงาน"
//    (ส่วนรับเงิน/ยืนยันนัด ยังคงแยกปุ่ม เพราะเป็นธุรกรรม/การแจ้งเตือนที่สำคัญ)
// 3) จำกัดปุ่ม "เก็บถาวรงาน" ให้เห็นเฉพาะ Role "admin" เท่านั้น (ซ่อนจาก Owner)
//    ⚠️ เป็นการซ่อนที่ชั้น UI เท่านั้น ไม่ได้เปลี่ยนสิทธิ์ที่ Edge Function/ฐานข้อมูล
// 4) ลดขั้นตอนเปลี่ยนสถานะ: ปุ่มเดินหน้า (waiting->in_progress->completed->picked_up)
//    กดครั้งเดียวจบไม่ต้องยืนยันซ้ำ ส่วนยกเลิกงาน/ย้อนกลับยังคงมี Confirm Dialog
//    เพิ่มแถบแสดงขั้นตอนเป็นภาพ (Stepper) ให้เห็นภาพรวมได้ทันที
// 5) เพิ่มปุ่มลัด: โทรหาลูกค้าจากหน้ารายการ, ชำระยอดคงเหลือทั้งหมด (เติมเลขให้อัตโนมัติ)

import { listLoginIdentities } from "../shared/auth-client.js";
import {
  initSession, loginWithPin, logout, onSessionChange, getSessionSnapshot, getAccessToken,
} from "../shared/session.js";
import {
  showToast, preventDoubleSubmit, isValidPinFormat,
  formatThaiDate, formatThaiDateTime, getTodayBangkokISODate,
  generateIdempotencyKey, validateImageFile,
  JOB_STATUS_DISPLAY, PAYMENT_STATUS_DISPLAY,
} from "../shared/utils.js";
import {
  fetchJobsWindow, fetchJobImages, fetchJobIdsWithFailedNotifications, attachFailedNotificationFlag,
  fetchJobPaymentTransactions, computeTotalPaid, fetchJobCustomerNotifications,
} from "../shared/shop-data-client.js";
import {
  confirmAppointment, changeJobStatus, addJobNote, archiveJob,
} from "../shared/shop-actions-client.js";
import { setJobPricing, recordPayment, voidPayment } from "../shared/payment-client.js";
import { uploadPaymentEvidence } from "../shared/payment-evidence-upload.js";
import { retryNotification } from "../shared/notification-client.js";
import { computeDashboardCards, filterJobs, buildCalendarMonthGrid, groupJobsByConfirmedDate } from "../shared/job-aggregation.js";
import { PICKUP_TIME_SLOTS, JOB_TYPES_FALLBACK } from "../shared/job-constants.js";
import { getSupabaseClient } from "../shared/supabase-client.js";

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
  } else {
    showScreen("login");
    loadIdentities();
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
// Summary Cards (Auto-scroll ไปที่รายการงานเมื่อกด Card)
// ============================================================================
const CARD_DEFINITIONS = [
  { key: "pendingConfirmation", label: "งานใหม่รอยืนยัน", icon: "🆕" },
  { key: "dueToday", label: "งานวันนี้", icon: "📅" },
  { key: "dueTomorrow", label: "งานพรุ่งนี้", icon: "📆" },
  { key: "dueWithin3Days", label: "งานภายใน 3 วัน", icon: "⏱️" },
  { key: "overdue", label: "งานเลยกำหนด", icon: "⚠️" },
  { key: "completedWaitingPickup", label: "เสร็จรอรับ", icon: "📦" },
  { key: "notificationFailed", label: "LINE ส่งไม่สำเร็จ", icon: "📵" },
];

function renderSummaryCards() {
  const cardData = computeDashboardCards(state.allJobs);
  const grid = document.getElementById("summary-grid");
  grid.innerHTML = "";

  CARD_DEFINITIONS.forEach((def) => {
    const jobs = cardData[def.key] ?? [];
    const card = document.createElement("div");
    card.className = "summary-card" + (state.activeCard === def.key ? " active" : "");
    card.innerHTML = `
      <div class="icon">${def.icon}</div>
      <div class="count">${jobs.length}</div>
      <div class="label">${def.label}</div>
    `;
    card.addEventListener("click", () => {
      state.activeCard = state.activeCard === def.key ? null : def.key;
      state.selectedCalendarDate = null;
      renderAll();
      document.getElementById("job-list-anchor")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    grid.appendChild(card);
  });
}

function getCardFilteredJobs() {
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
  document.getElementById("btn-clear-filters").addEventListener("click", () => {
    state.filters = { status: "", jobTypeId: "", dateFrom: "", dateTo: "", searchText: "" };
    document.getElementById("search-input").value = "";
    document.getElementById("filter-status").value = "";
    document.getElementById("filter-job-type").value = "";
    document.getElementById("filter-date-from").value = "";
    document.getElementById("filter-date-to").value = "";
    state.activeCard = null;
    state.selectedCalendarDate = null;
    renderAll();
  });
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
    let className = "calendar-cell";
    if (isoDate === today) className += " today";
    if (jobsOnDay.length > 0) className += " has-jobs";
    if (isoDate === state.selectedCalendarDate) className += " selected";
    cell.className = className;
    cell.innerHTML = `<div>${dayNum}</div>${jobsOnDay.length > 0 ? `<div class="dot-count">${jobsOnDay.length}</div>` : ""}`;
    cell.addEventListener("click", () => {
      state.selectedCalendarDate = state.selectedCalendarDate === isoDate ? null : isoDate;
      state.activeCard = null;
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
// Job List (เพิ่มปุ่มโทรด่วน)
// ============================================================================
function renderJobList() {
  let jobs = getCardFilteredJobs();

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
    const statusInfo = JOB_STATUS_DISPLAY[job.status] ?? { label: job.status, icon: "❔", color: "#999" };
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
// Status Stepper (ภาพรวมขั้นตอนงาน)
// ============================================================================
const STEPPER_SEQUENCE = ["pending_confirmation", "waiting", "in_progress", "completed", "picked_up"];
const STEPPER_LABELS = {
  pending_confirmation: "รอยืนยัน",
  waiting: "รอทำ",
  in_progress: "กำลังทำ",
  completed: "เสร็จแล้ว",
  picked_up: "รับแล้ว",
};

function buildStepperHtml(status) {
  if (status === "cancelled") {
    return `<div class="stepper-cancelled-box">🚫 งานนี้ถูกยกเลิกแล้ว</div>`;
  }
  const currentIndex = STEPPER_SEQUENCE.indexOf(status);
  return `
    <div class="status-stepper">
      ${STEPPER_SEQUENCE.map((s, idx) => {
        const done = idx < currentIndex;
        const active = idx === currentIndex;
        const icon = done ? "✅" : (active ? "🔵" : "⚪");
        return `<div class="stepper-item ${active ? "active" : ""} ${done ? "done" : ""}">
          <div class="stepper-icon">${icon}</div>
          <div>${STEPPER_LABELS[s]}</div>
        </div>`;
      }).join("")}
    </div>
  `;
}

// ============================================================================
// Job Detail Modal
// ============================================================================
const STATUS_NEXT_STEP = {
  waiting: { to: "in_progress", label: "▶️ เริ่มทำงาน", cls: "btn-purple" },
  in_progress: { to: "completed", label: "✅ งานเสร็จแล้ว", cls: "btn-success" },
  completed: { to: "picked_up", label: "📦 ลูกค้ารับแล้ว", cls: "btn-success" },
};

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
  const isAdminOnly = session.appRole === "admin"; // ข้อ 3: เก็บถาวรเฉพาะ Admin

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

  const statusInfo = JOB_STATUS_DISPLAY[job.status] ?? { label: job.status, icon: "❔", color: "#999" };
  const paymentInfo = PAYMENT_STATUS_DISPLAY[job.payment_status] ?? { label: job.payment_status, icon: "", color: "#999" };
  const quantityText = job.quantity_is_over_ten ? (job.quantity_note ?? "มากกว่า 10 ชิ้น") : `${job.quantity} ชิ้น`;
  const totalPaid = computeTotalPaid(paymentTransactions);
  const balance = job.price_final != null ? job.price_final - totalPaid : null;

  sheet.innerHTML = `
    <button class="modal-close-btn" id="modal-close-btn">✕</button>
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

    <div class="modal-section" id="job-info-section"></div>

    <div class="modal-section" id="payment-section"></div>

    <div class="modal-section" id="appointment-section"></div>

    <div class="modal-section" id="notification-history-section"></div>

    <div class="modal-section" id="status-section">
      <h3>🔄 สถานะงาน</h3>
      <div id="status-buttons"></div>
    </div>

    ${isAdminOnly ? `
    <div class="modal-section">
      <h3>🗄️ จัดการงาน (เฉพาะผู้ดูแลระบบ)</h3>
      <button class="btn btn-danger" id="btn-archive-job">เก็บถาวรงานนี้ (Soft Delete)</button>
    </div>` : ""}
  `;

  document.getElementById("modal-close-btn").addEventListener("click", closeJobModal);

  renderJobInfoSection(job, isOwnerOrAdmin);
  renderPaymentSection(job, paymentTransactions, totalPaid, balance, paymentInfo, isOwnerOrAdmin);
  renderAppointmentSection(job, isOwnerOrAdmin);
  renderNotificationHistorySection(customerNotifications, isOwnerOrAdmin, job.id);
  renderStatusButtons(job);

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
// Job Info Section (ข้อ 2: รวมราคา + หมายเหตุ เป็นปุ่มเดียว)
// ============================================================================
function renderJobInfoSection(job, isOwnerOrAdmin) {
  const section = document.getElementById("job-info-section");

  if (!isOwnerOrAdmin) {
    section.innerHTML = `
      <h3>💰 ราคา</h3>
      <div class="info-row"><span class="label">ราคาประเมิน</span><span class="value">${job.price_estimate != null ? job.price_estimate.toLocaleString() + " บาท" : "ยังไม่ระบุ"}</span></div>
      <div class="info-row"><span class="label">ราคาสรุปจริง</span><span class="value">${job.price_final != null ? job.price_final.toLocaleString() + " บาท" : "ยังไม่ระบุ"}</span></div>
      <div class="info-row"><span class="label">เงินมัดจำที่ต้องการ</span><span class="value">${(job.deposit_amount ?? 0).toLocaleString()} บาท</span></div>
      <div class="readonly-note">การแก้ไขราคาทำได้เฉพาะเจ้าของร้านและผู้ดูแลระบบเท่านั้น</div>

      <h3 style="margin-top:14px;">📝 หมายเหตุภายใน (ร้านเท่านั้น ลูกค้าไม่เห็น)</h3>
      <textarea class="note-input" id="note-input" placeholder="เพิ่มหมายเหตุ...">${job.internal_note ?? ""}</textarea>
      <button class="btn btn-secondary" id="btn-save-job-info" style="margin-top:8px;">บันทึกหมายเหตุ</button>
    `;
  } else {
    section.innerHTML = `
      <h3>💰 ราคา (แก้ไขได้)</h3>
      <label style="font-weight:600;">ราคาประเมิน (บาท)</label>
      <input type="number" min="0" step="0.01" class="price-input" id="price-estimate-input" value="${job.price_estimate ?? ""}" placeholder="ยังไม่ระบุ" />
      <label style="font-weight:600;">ราคาสรุปจริง (บาท)</label>
      <input type="number" min="0" step="0.01" class="price-input" id="price-final-input" value="${job.price_final ?? ""}" placeholder="ยังไม่ระบุ" />
      <label style="font-weight:600;">เงินมัดจำที่ต้องการ (บาท)</label>
      <div class="quick-percent-row">
        <button type="button" class="btn btn-secondary" id="btn-deposit-25">มัดจำ 25%</button>
        <button type="button" class="btn btn-secondary" id="btn-deposit-50">มัดจำ 50%</button>
      </div>
      <input type="number" min="0" step="0.01" class="price-input" id="deposit-amount-input" value="${job.deposit_amount ?? 0}" />

      <h3 style="margin-top:14px;">📝 หมายเหตุภายใน (ร้านเท่านั้น ลูกค้าไม่เห็น)</h3>
      <textarea class="note-input" id="note-input" placeholder="เพิ่มหมายเหตุ...">${job.internal_note ?? ""}</textarea>

      <button class="btn btn-primary" id="btn-save-job-info" style="margin-top:12px;">💾 บันทึกข้อมูลงาน</button>
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
  }

  document.getElementById("btn-save-job-info").addEventListener("click", preventDoubleSubmit(async () => {
    const noteEl = document.getElementById("note-input");

    try {
      if (isOwnerOrAdmin) {
        const estEl = document.getElementById("price-estimate-input");
        const finalEl = document.getElementById("price-final-input");
        const depositEl = document.getElementById("deposit-amount-input");

        const priceEstimate = estEl.value === "" ? null : Number(estEl.value);
        const priceFinal = finalEl.value === "" ? null : Number(finalEl.value);
        const depositAmount = depositEl.value === "" ? 0 : Number(depositEl.value);

        if (
          (priceEstimate !== null && (Number.isNaN(priceEstimate) || priceEstimate < 0)) ||
          (priceFinal !== null && (Number.isNaN(priceFinal) || priceFinal < 0)) ||
          Number.isNaN(depositAmount) || depositAmount < 0
        ) {
          showToast("ราคาต้องเป็นตัวเลขที่ไม่ติดลบ", "error");
          return;
        }

        await setJobPricing({
          accessToken: getAccessToken(),
          jobId: job.id,
          priceEstimate,
          priceFinal,
          depositAmount,
        });
      }

      await addJobNote({ accessToken: getAccessToken(), jobId: job.id, internalNote: noteEl.value });

      showToast("บันทึกข้อมูลงานสำเร็จ", "success");
      await refreshJobs();
      openJobModal(job.id);
    } catch (err) {
      showToast(err.message, "error");
    }
  }));
}

// ============================================================================
// Payment Section (เพิ่มปุ่มเติมยอดคงเหลืออัตโนมัติ)
// ============================================================================
let pendingEvidenceFile = null;

function renderPaymentSection(job, transactions, totalPaid, balance, paymentInfo, isOwnerOrAdmin) {
  const section = document.getElementById("payment-section");

  const balanceHtml = job.price_final != null
    ? `<div class="balance-box">
         <div class="amount">${balance.toLocaleString()} บาท</div>
         <div class="caption">ยอดคงเหลือ (ชำระแล้ว ${totalPaid.toLocaleString()} จาก ${job.price_final.toLocaleString()} บาท)</div>
       </div>`
    : `<div class="warning-box">⚠️ ยังไม่ได้ระบุราคาสรุปจริง จึงยังคำนวณยอดคงเหลือไม่ได้</div>`;

  const transactionsHtml = transactions.length === 0
    ? `<div class="readonly-note">ยังไม่มีประวัติการชำระเงิน</div>`
    : transactions.map((tx) => `
        <div class="payment-tx-card ${tx.is_voided ? "voided" : ""}">
          <div class="payment-tx-top">
            <span class="payment-tx-amount ${tx.transaction_type}">${tx.transaction_type === "refund" ? "-" : "+"}${tx.amount.toLocaleString()} บาท</span>
            ${tx.is_voided ? '<span class="voided-tag">ยกเลิกแล้ว</span>' : (isOwnerOrAdmin ? `<button class="btn btn-secondary btn-sm" data-void-tx-id="${tx.id}">ยกเลิกรายการ</button>` : "")}
          </div>
          <div class="payment-tx-meta">
            ${PAYMENT_METHOD_LABELS[tx.payment_method] ?? tx.payment_method} • ${formatThaiDateTime(tx.received_at)} • โดย ${tx.shop_users?.full_name ?? "-"}
            ${tx.note ? `<br/>หมายเหตุ: ${tx.note}` : ""}
            ${tx.is_voided ? `<br/>เหตุผลยกเลิก: ${tx.void_reason ?? "-"} (โดย ${tx.voider?.full_name ?? "-"})` : ""}
          </div>
          ${tx.payment_evidence.length > 0 ? `
          <div class="payment-tx-evidence">
            ${tx.payment_evidence.map((ev) => `<img src="${ev.signedUrl ?? ""}" alt="หลักฐาน" />`).join("")}
          </div>` : ""}
        </div>
      `).join("");

  const hasRemainingBalance = job.price_final != null && balance > 0;

  section.innerHTML = `
    <h3>💳 การชำระเงิน</h3>
    <div class="info-row"><span class="label">สถานะการชำระ</span><span class="value">${paymentInfo.icon} ${paymentInfo.label}</span></div>
    ${balanceHtml}
    ${transactionsHtml}

    <div style="margin-top:16px;">
      <h3 style="font-size:0.95rem;">➕ บันทึกรับเงิน</h3>
      ${hasRemainingBalance ? `<button type="button" class="btn btn-secondary" id="btn-fill-full-balance">ชำระยอดคงเหลือทั้งหมด (${balance.toLocaleString()} บาท)</button>` : ""}
      <input type="number" min="0.01" step="0.01" class="payment-amount-input" id="payment-amount-input" placeholder="จำนวนเงิน (บาท)" />
      <select class="payment-method-select" id="payment-method-select">
        <option value="cash">เงินสด</option>
        <option value="transfer">โอนเงิน</option>
        <option value="qr">QR Payment</option>
        <option value="other">อื่น ๆ</option>
      </select>
      <textarea class="note-input" id="payment-note-input" placeholder="หมายเหตุ (ถ้ามี)" style="min-height:60px;"></textarea>
      <div class="upload-evidence-btn" id="btn-pick-evidence">📷 แนบรูปหลักฐานการชำระเงิน (ถ้ามี)</div>
      <input type="file" id="payment-evidence-input" accept="image/jpeg,image/png,image/webp" class="hidden" />
      <div id="evidence-preview" style="margin-top:8px;"></div>
      <button class="btn btn-success" id="btn-record-payment" style="margin-top:10px;">บันทึกรับเงิน</button>
    </div>
  `;

  if (hasRemainingBalance) {
    document.getElementById("btn-fill-full-balance").addEventListener("click", () => {
      document.getElementById("payment-amount-input").value = balance;
    });
  }

  if (isOwnerOrAdmin) {
    section.querySelectorAll("[data-void-tx-id]").forEach((btn) => {
      btn.addEventListener("click", preventDoubleSubmit(async () => {
        const txId = btn.getAttribute("data-void-tx-id");
        const result = await showConfirmDialog({
          text: "ต้องการยกเลิกรายการนี้ใช่หรือไม่? (ระบบจะไม่ลบประวัติ แต่จะทำเครื่องหมายว่ายกเลิกแล้ว)",
          requireReason: true,
          confirmLabel: "ยกเลิกรายการ",
        });
        if (!result.confirmed) return;
        try {
          await voidPayment({ accessToken: getAccessToken(), transactionId: txId, voidReason: result.reason });
          showToast("ยกเลิกรายการสำเร็จ", "success");
          await refreshJobs();
          openJobModal(job.id);
        } catch (err) {
          showToast(err.message, "error");
        }
      }));
    });
  }

  pendingEvidenceFile = null;
  const evidenceInput = document.getElementById("payment-evidence-input");
  const evidencePreview = document.getElementById("evidence-preview");
  document.getElementById("btn-pick-evidence").addEventListener("click", () => evidenceInput.click());
  evidenceInput.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const validation = validateImageFile(file);
    if (!validation.valid) {
      showToast(validation.message, "error");
      e.target.value = "";
      return;
    }
    pendingEvidenceFile = file;
    evidencePreview.innerHTML = `<img src="${URL.createObjectURL(file)}" style="width:80px;height:80px;object-fit:cover;border-radius:10px;" />`;
  });

  document.getElementById("btn-record-payment").addEventListener("click", preventDoubleSubmit(async () => {
    const amountValue = Number(document.getElementById("payment-amount-input").value);
    const paymentMethod = document.getElementById("payment-method-select").value;
    const note = document.getElementById("payment-note-input").value.trim();

    if (!Number.isFinite(amountValue) || amountValue <= 0) {
      showToast("กรุณากรอกจำนวนเงินให้ถูกต้อง", "error");
      return;
    }

    const session = getSessionSnapshot();
    const idempotencyKey = generateIdempotencyKey("pay");

    try {
      const result = await recordPayment({
        accessToken: getAccessToken(),
        jobId: job.id,
        transactionType: "payment",
        amount: amountValue,
        paymentMethod,
        note,
        idempotencyKey,
      });

      if (pendingEvidenceFile) {
        try {
          await uploadPaymentEvidence({
            transactionId: result.transaction_id,
            file: pendingEvidenceFile,
            accessToken: getAccessToken(),
            uploadedByShopUserId: session.shopUserId,
          });
        } catch (evidenceErr) {
          showToast("บันทึกรายการสำเร็จ แต่แนบหลักฐานไม่สำเร็จ: " + evidenceErr.message, "error");
        }
      }

      showToast(result.message, "success");
      await refreshJobs();
      openJobModal(job.id);
    } catch (err) {
      showToast(err.message, "error");
    }
  }));
}

function renderAppointmentSection(job, isOwnerOrAdmin) {
  const section = document.getElementById("appointment-section");
  if (job.status !== "pending_confirmation" && !isOwnerOrAdmin) {
    section.innerHTML = "";
    return;
  }

  if (!isOwnerOrAdmin) {
    section.innerHTML = job.status === "pending_confirmation"
      ? `<div class="warning-box">⏳ งานนี้รอการยืนยันนัดจากเจ้าของร้านหรือผู้ดูแลระบบ</div>`
      : "";
    return;
  }

  const isReschedule = !!job.confirmed_pickup_date;
  section.innerHTML = `
    <h3>📅 ${isReschedule ? "เปลี่ยนวันนัดรับ" : "ยืนยันวันนัดรับ"}</h3>
    <label style="font-weight:600;">วันที่ร้านยืนยัน</label>
    <input type="date" class="confirm-date-input" id="confirm-date-input" value="${job.confirmed_pickup_date ?? job.requested_pickup_date}" />
    <label style="font-weight:600;">เวลาที่ร้านยืนยัน</label>
    <select class="confirm-time-select" id="confirm-time-select">
      ${PICKUP_TIME_SLOTS.map((t) => `<option value="${t}" ${t === job.confirmed_pickup_time ? "selected" : ""}>${t} น.</option>`).join("")}
    </select>
    ${isReschedule ? `
    <label style="font-weight:600;">เหตุผลที่เปลี่ยนวันนัด</label>
    <textarea class="note-input" id="reschedule-reason-input" placeholder="ระบุเหตุผล..." style="min-height:60px;"></textarea>` : ""}
    <button class="btn btn-primary" id="btn-confirm-appointment" style="margin-top:10px;">${isReschedule ? "บันทึกวันนัดใหม่" : "ยืนยันนัด"}</button>
  `;

  document.getElementById("btn-confirm-appointment").addEventListener("click", preventDoubleSubmit(async () => {
    const confirmedDate = document.getElementById("confirm-date-input").value;
    const confirmedTime = document.getElementById("confirm-time-select").value;
    const reasonInput = document.getElementById("reschedule-reason-input");
    const changeReason = reasonInput ? reasonInput.value.trim() : null;

    if (!confirmedDate || !confirmedTime) {
      showToast("กรุณาเลือกวันและเวลาให้ครบถ้วน", "error");
      return;
    }
    if (isReschedule && !changeReason) {
      showToast("กรุณาระบุเหตุผลที่เปลี่ยนวันนัด", "error");
      return;
    }

    try {
      await confirmAppointment({
        accessToken: getAccessToken(),
        jobId: job.id,
        confirmedDate,
        confirmedTime,
        changeReason,
      });
      showToast(isReschedule ? "เปลี่ยนวันนัดสำเร็จ" : "ยืนยันนัดสำเร็จ", "success");
      await refreshJobs();
      closeJobModal();
    } catch (err) {
      showToast(err.message, "error");
    }
  }));
}

// ============================================================================
// Status Buttons (ข้อ 5: ลดขั้นตอน — กดครั้งเดียวจบสำหรับเดินหน้า)
// ============================================================================
function renderStatusButtons(job) {
  const container = document.getElementById("status-buttons");
  const nextStep = STATUS_NEXT_STEP[job.status];
  const canCancel = job.status === "waiting" || job.status === "in_progress";
  const canRevert = job.status === "completed";

  if (!nextStep && !canCancel && !canRevert) {
    container.innerHTML = `<div class="readonly-note">ไม่มีการเปลี่ยนสถานะที่ทำได้ในขั้นตอนนี้</div>`;
    return;
  }

  let html = "";
  if (nextStep) {
    html += `<button class="btn ${nextStep.cls} btn-big-step" id="btn-next-step">${nextStep.label}</button>`;
  }
  if (canRevert) {
    html += `<button class="btn btn-secondary btn-sm" id="btn-revert-step" style="margin-top:6px;">↩️ ย้อนกลับไปกำลังทำ</button>`;
  }
  if (canCancel) {
    html += `<button class="btn btn-secondary btn-sm" id="btn-cancel-step" style="margin-top:6px;color:var(--danger);border-color:var(--danger);">🚫 ยกเลิกงานนี้</button>`;
  }
  container.innerHTML = html;

  if (nextStep) {
    document.getElementById("btn-next-step").addEventListener("click", preventDoubleSubmit(async () => {
      try {
        await changeJobStatus({ accessToken: getAccessToken(), jobId: job.id, newStatus: nextStep.to, reason: null });
        showToast("เปลี่ยนสถานะสำเร็จ", "success");
        await refreshJobs();
        closeJobModal();
      } catch (err) {
        showToast(err.message, "error");
      }
    }));
  }

  if (canRevert) {
    document.getElementById("btn-revert-step").addEventListener("click", preventDoubleSubmit(async () => {
      const result = await showConfirmDialog({
        text: "ต้องการย้อนกลับไปสถานะ \"กำลังทำ\" ใช่หรือไม่?",
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
  }

  if (canCancel) {
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
}

function closeJobModal() {
  document.getElementById("job-modal-backdrop").classList.add("hidden");
  state.currentJobId = null;
  pendingEvidenceFile = null;
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
  } else {
    showScreen("login");
    await loadIdentities();
  }
})();
