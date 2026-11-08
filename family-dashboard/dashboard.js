// family-dashboard/dashboard.js
// Logic หลักของ Family Dashboard (Phase 5)

import { listLoginIdentities } from "../shared/auth-client.js";
import {
  initSession, loginWithPin, logout, onSessionChange, getSessionSnapshot, getAccessToken,
} from "../shared/session.js";
import {
  showToast, preventDoubleSubmit, isValidPinFormat,
  formatThaiDate, formatThaiTime, getTodayBangkokISODate,
  JOB_STATUS_DISPLAY, PAYMENT_STATUS_DISPLAY,
} from "../shared/utils.js";
import {
  fetchJobsWindow, fetchJobImages, fetchJobStatusHistory, fetchJobAppointments,
  fetchJobIdsWithFailedNotifications, attachFailedNotificationFlag,
} from "../shared/shop-data-client.js";
import {
  confirmAppointment, changeJobStatus, assignJob, addJobNote, archiveJob,
} from "../shared/shop-actions-client.js";
import { computeDashboardCards, filterJobs, buildCalendarMonthGrid, groupJobsByConfirmedDate } from "../shared/job-aggregation.js";
import { PICKUP_TIME_SLOTS, JOB_TYPES_FALLBACK } from "../shared/job-constants.js";
import { getSupabaseClient } from "../shared/supabase-client.js";

// ============================================================================
// State
// ============================================================================
const state = {
  allJobs: [],
  shopUsers: [], // [{id, full_name, role}]
  jobTypes: [],
  activeCard: null, // key ของ Card ที่กำลังเลือกอยู่
  filters: { status: "", jobTypeId: "", assignedTo: "", dateFrom: "", dateTo: "", searchText: "" },
  calendarYear: new Date().getFullYear(),
  calendarMonth: new Date().getMonth(), // 0-11
  selectedCalendarDate: null,
  currentJobId: null, // งานที่เปิด Modal อยู่
};

const shopUserMap = new Map(); // id -> {full_name, role}

function getShopUserName(id) {
  if (!id) return "ยังไม่มอบหมาย";
  return shopUserMap.get(id)?.full_name ?? "ไม่ทราบชื่อ";
}

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
    const listEl = document.getElementById("identity-list");
    const pinSectionEl = document.getElementById("pin-section");
    listEl.innerHTML = "";
    identities.forEach((identity) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "identity-btn";
      const roleLabel = { owner: "เจ้าของร้าน", admin: "ผู้ดูแลระบบ", assistant: "ผู้ช่วยร้าน" }[identity.role] ?? identity.role;
      btn.textContent = `${identity.full_name} (${roleLabel})`;
      btn.addEventListener("click", () => {
        selectedShopUserId = identity.id;
        document.getElementById("selected-name").textContent = identity.full_name;
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
    const [{ identities }, jobTypesResult] = await Promise.all([
      listLoginIdentities(),
      loadJobTypes(token),
    ]);
    state.shopUsers = identities;
    shopUserMap.clear();
    identities.forEach((u) => shopUserMap.set(u.id, u));
    document.getElementById("header-user-name").textContent =
      shopUserMap.get(getSessionSnapshot().shopUserId)?.full_name ?? "";

    populateAssigneeFilter();
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
// Summary Cards
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
function populateAssigneeFilter() {
  const select = document.getElementById("filter-assignee");
  // ลบตัวเลือกเดิม (คงไว้แค่ 2 ตัวแรก: ทั้งหมด / ยังไม่มอบหมาย)
  while (select.options.length > 2) select.remove(2);
  state.shopUsers.forEach((u) => {
    const opt = document.createElement("option");
    opt.value = u.id;
    opt.textContent = u.full_name;
    select.appendChild(opt);
  });
}

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
  document.getElementById("filter-assignee").addEventListener("change", (e) => {
    state.filters.assignedTo = e.target.value;
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
    state.filters = { status: "", jobTypeId: "", assignedTo: "", dateFrom: "", dateTo: "", searchText: "" };
    document.getElementById("search-input").value = "";
    document.getElementById("filter-status").value = "";
    document.getElementById("filter-job-type").value = "";
    document.getElementById("filter-assignee").value = "";
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
      <div class="job-card-top">
        <div>
          <div class="job-number">${job.job_number}</div>
          <div class="customer-name">${job.customers?.full_name ?? "-"}</div>
        </div>
        <span class="status-badge" style="background:${statusInfo.color}">${statusInfo.icon} ${statusInfo.label}</span>
      </div>
      <div class="job-card-meta">
        <span>✂️ ${job.job_types?.label_th ?? job.job_type_other ?? "-"}</span>
        <span>👤 ${getShopUserName(job.assigned_to)}</span>
        ${job.confirmed_pickup_date ? `<span>📅 ${formatThaiDate(job.confirmed_pickup_date)} ${job.confirmed_pickup_time ?? ""} น.</span>` : `<span>📅 ต้องการ ${formatThaiDate(job.requested_pickup_date)}</span>`}
        ${job.is_urgent ? '<span class="urgent-tag">🚨 ด่วน</span>' : ""}
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
// Job Detail Modal
// ============================================================================
const STATUS_TRANSITIONS = {
  pending_confirmation: [],
  waiting: [{ to: "in_progress", label: "เริ่มทำงาน", cls: "btn-purple" }, { to: "cancelled", label: "ยกเลิกงาน", cls: "btn-danger" }],
  in_progress: [{ to: "completed", label: "งานเสร็จแล้ว", cls: "btn-success" }, { to: "cancelled", label: "ยกเลิกงาน", cls: "btn-danger" }],
  completed: [{ to: "picked_up", label: "ลูกค้ารับแล้ว", cls: "btn-success" }, { to: "in_progress", label: "ย้อนกลับไปกำลังทำ", cls: "btn-secondary" }],
  picked_up: [],
  cancelled: [],
};

async function openJobModal(jobId) {
  state.currentJobId = jobId;
  const job = state.allJobs.find((j) => j.id === jobId);
  if (!job) return;

  const token = getAccessToken();
  const session = getSessionSnapshot();
  const isOwnerOrAdmin = session.appRole === "owner" || session.appRole === "admin";

  const sheet = document.getElementById("job-modal-sheet");
  sheet.innerHTML = `<div class="center-screen"><div class="spinner"></div><p>กำลังโหลด...</p></div>`;
  document.getElementById("job-modal-backdrop").classList.remove("hidden");

  let images = [];
  try {
    images = await fetchJobImages({ accessToken: token, jobId });
  } catch {
    images = [];
  }

  const statusInfo = JOB_STATUS_DISPLAY[job.status] ?? { label: job.status, icon: "❔", color: "#999" };
  const paymentInfo = PAYMENT_STATUS_DISPLAY[job.payment_status] ?? { label: job.payment_status, icon: "", color: "#999" };
  const quantityText = job.quantity_is_over_ten ? (job.quantity_note ?? "มากกว่า 10 ชิ้น") : `${job.quantity} ชิ้น`;

  sheet.innerHTML = `
    <button class="modal-close-btn" id="modal-close-btn">✕</button>
    <h2>${job.job_number} <span class="status-badge" style="background:${statusInfo.color}">${statusInfo.icon} ${statusInfo.label}</span></h2>

    <div class="modal-section">
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

    <div class="modal-section">
      <h3>💰 ราคาและการชำระเงิน</h3>
      <div class="info-row"><span class="label">ราคาประเมิน</span><span class="value">${job.price_estimate != null ? job.price_estimate + " บาท" : "ยังไม่ระบุ"}</span></div>
      <div class="info-row"><span class="label">ราคาสรุปจริง</span><span class="value">${job.price_final != null ? job.price_final + " บาท" : "ยังไม่ระบุ"}</span></div>
      <div class="info-row"><span class="label">เงินมัดจำ</span><span class="value">${job.deposit_amount ?? 0} บาท</span></div>
      <div class="info-row"><span class="label">สถานะการชำระเงิน</span><span class="value">${paymentInfo.icon} ${paymentInfo.label}</span></div>
      <div class="readonly-note">การบันทึกราคาและรับเงินจะเปิดใช้งานใน Phase ถัดไป</div>
    </div>

    <div class="modal-section" id="appointment-section"></div>

    <div class="modal-section" id="status-section">
      <h3>🔄 เปลี่ยนสถานะ</h3>
      <div id="status-buttons"></div>
    </div>

    <div class="modal-section">
      <h3>👥 ผู้รับผิดชอบ</h3>
      <select class="assign-select" id="assign-select">
        <option value="">-- ยังไม่มอบหมาย --</option>
        ${state.shopUsers.map((u) => `<option value="${u.id}" ${u.id === job.assigned_to ? "selected" : ""}>${u.full_name}</option>`).join("")}
      </select>
      <button class="btn btn-secondary" id="btn-save-assign">บันทึกผู้รับผิดชอบ</button>
    </div>

    <div class="modal-section">
      <h3>📝 หมายเหตุภายใน (ร้านเท่านั้น ลูกค้าไม่เห็น)</h3>
      <textarea class="note-input" id="note-input" placeholder="เพิ่มหมายเหตุ...">${job.internal_note ?? ""}</textarea>
      <button class="btn btn-secondary" id="btn-save-note" style="margin-top:8px;">บันทึกหมายเหตุ</button>
    </div>

    ${isOwnerOrAdmin ? `
    <div class="modal-section">
      <h3>🗄️ จัดการงาน (Owner/Admin)</h3>
      <button class="btn btn-danger" id="btn-archive-job">เก็บถาวรงานนี้ (Soft Delete)</button>
    </div>` : ""}
  `;

  document.getElementById("modal-close-btn").addEventListener("click", closeJobModal);

  // ---------------- Appointment Section ----------------
  renderAppointmentSection(job, isOwnerOrAdmin);

  // ---------------- Status Buttons ----------------
  renderStatusButtons(job);

  // ---------------- Assign ----------------
  document.getElementById("btn-save-assign").addEventListener("click", preventDoubleSubmit(async () => {
    const selectEl = document.getElementById("assign-select");
    try {
      await assignJob({ accessToken: getAccessToken(), jobId, shopUserId: selectEl.value || null });
      showToast("บันทึกผู้รับผิดชอบสำเร็จ", "success");
      await refreshJobs();
      closeJobModal();
    } catch (err) {
      showToast(err.message, "error");
    }
  }));

  // ---------------- Note ----------------
  document.getElementById("btn-save-note").addEventListener("click", preventDoubleSubmit(async () => {
    const noteEl = document.getElementById("note-input");
    try {
      await addJobNote({ accessToken: getAccessToken(), jobId, internalNote: noteEl.value });
      showToast("บันทึกหมายเหตุสำเร็จ", "success");
      await refreshJobs();
    } catch (err) {
      showToast(err.message, "error");
    }
  }));

  // ---------------- Archive (Owner/Admin) ----------------
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

  // Owner/Admin: แสดงฟอร์มยืนยัน/เปลี่ยนนัด เสมอ (ยืนยันครั้งแรกหรือเปลี่ยนนัดภายหลังก็ได้)
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

function renderStatusButtons(job) {
  const container = document.getElementById("status-buttons");
  const transitions = STATUS_TRANSITIONS[job.status] ?? [];

  if (transitions.length === 0) {
    container.innerHTML = `<div class="readonly-note">ไม่มีการเปลี่ยนสถานะที่ทำได้ในขั้นตอนนี้</div>`;
    return;
  }

  container.innerHTML = transitions.map((t, idx) =>
    `<button class="btn ${t.cls}" data-to-status="${t.to}" id="status-btn-${idx}">${t.label}</button>`,
  ).join("");

  transitions.forEach((t, idx) => {
    document.getElementById(`status-btn-${idx}`).addEventListener("click", preventDoubleSubmit(async () => {
      let reason = null;
      if (t.to === "cancelled") {
        const result = await showConfirmDialog({
          text: `ต้องการยกเลิกงาน ${job.job_number} ใช่หรือไม่?`,
          requireReason: true,
          confirmLabel: "ยกเลิกงาน",
        });
        if (!result.confirmed) return;
        reason = result.reason;
      } else {
        const result = await showConfirmDialog({
          text: `ต้องการเปลี่ยนสถานะเป็น "${t.label}" ใช่หรือไม่?`,
          requireReason: false,
          confirmLabel: "ยืนยัน",
        });
        if (!result.confirmed) return;
      }

      try {
        await changeJobStatus({ accessToken: getAccessToken(), jobId: job.id, newStatus: t.to, reason });
        showToast("เปลี่ยนสถานะสำเร็จ", "success");
        await refreshJobs();
        closeJobModal();
      } catch (err) {
        showToast(err.message, "error");
      }
    }));
  });
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
  } else {
    showScreen("login");
    await loadIdentities();
  }
})();
