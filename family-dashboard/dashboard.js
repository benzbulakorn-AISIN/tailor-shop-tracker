// family-dashboard/dashboard.js
// Logic หลักของ Family Dashboard — เวอร์ชันลดปุ่มสูงสุดสำหรับผู้สูงอายุ
//
// รอบนี้เพิ่ม:
// 1) Login แบบแป้นกด PIN (สไตล์ iPhone) ผ่าน shared/pin-pad.js — สร้างทับช่องพิมพ์ PIN เดิมจาก
//    โค้ดไฟล์นี้เอง (ไม่ต้องแก้ index.html) ใช้ loginWithPin()/Session/Remember Device เดิมทุกอย่าง
// 2) ปุ่ม "↩️ กดผิด เปิดงานกลับ" สำหรับงานที่กด "รับแล้ว/ปิดงาน" ผิด (เฉพาะเจ้าของร้าน/ผู้ดูแลระบบ)
// (คงการทำงานเดิมของรอบก่อนทั้งหมด)
import { listLoginIdentities } from "../shared/auth-client.js";
import {
  initSession, loginWithPin, logout, onSessionChange, getSessionSnapshot, getAccessToken,
} from "../shared/session.js";
import {
  showToast, preventDoubleSubmit, isValidPinFormat,
  formatThaiDate, formatThaiDateTime, getTodayBangkokISODate,
  generateIdempotencyKey, escapeHtml, toFriendlyErrorMessage,
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
import {
  computeDashboardCards, filterJobs, buildCalendarMonthGrid, groupJobsByConfirmedDate,
  sortJobsForOwner, getUrgencyTag, getEffectivePickupDate, getEffectivePickupTime, computeOwnerSummary,
} from "../shared/job-aggregation.js";
import { PICKUP_TIME_SLOTS, JOB_TYPES_FALLBACK } from "../shared/job-constants.js";
import { getSupabaseClient } from "../shared/supabase-client.js";
import { mountPinPad } from "../shared/pin-pad.js";

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
  received: { label: "รับเข้าระบบ", icon: "📋", color: "#1b2a49" },
  completed: { label: "เสร็จแล้ว", icon: "✅", color: "#1e8e3e" },
  picked_up: { label: "รับแล้ว/ปิดงาน", icon: "📦", color: "#5f6368" },
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

// Idempotency Key ที่คงที่ต่อ (งาน + ยอด): ถ้าบันทึกเงินสำเร็จแต่เปลี่ยนสถานะไม่สำเร็จ (หรือเน็ตหลุด)
// แล้วกดใหม่ จะใช้ Key เดิม -> Server ไม่สร้างรายการรับเงินซ้ำ
const pendingPaymentKeys = new Map();
function getStablePaymentKey(jobId, amount) {
  const id = `${jobId}:${amount}`;
  if (!pendingPaymentKeys.has(id)) pendingPaymentKeys.set(id, generateIdempotencyKey("pay"));
  return pendingPaymentKeys.get(id);
}
function clearStablePaymentKey(jobId, amount) {
  pendingPaymentKeys.delete(`${jobId}:${amount}`);
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
// Login Flow — แป้นกด PIN แบบ iPhone (ไม่เปิดแป้นพิมพ์มือถือ)
// ============================================================================
let selectedShopUserId = null;
let pinPad = null;

/** เรียกเมื่อกด PIN ครบ 6 หลัก — ใช้ loginWithPin()/Session/Remember Device เดิม ถ้า throw แป้นจะสั่น+ล้างตัวเลข */
async function attemptPinLogin(pin) {
  if (!selectedShopUserId) throw new Error("กรุณาเลือกชื่อผู้ใช้ก่อน");
  if (!isValidPinFormat(pin)) throw new Error("PIN ต้องเป็นตัวเลข 6 หลัก");
  try {
    await loginWithPin({
      shopUserId: selectedShopUserId,
      pin,
      rememberDevice: document.getElementById("remember-device-checkbox").checked,
      deviceLabel: navigator.userAgent.slice(0, 60),
    });
  } catch (err) {
    throw new Error(toFriendlyErrorMessage(err, "PIN ไม่ถูกต้อง กรุณาลองใหม่"));
  }
}

/** สร้างแป้นกด PIN ทับช่องพิมพ์ PIN เดิม (ทำครั้งเดียว) — ช่องพิมพ์เดิมถูกซ่อนไว้ ไม่ได้ลบ */
function ensurePinPad() {
  if (pinPad) return pinPad;
  const pinInputEl = document.getElementById("pin-input");
  const loginBtnEl = document.getElementById("btn-login");
  const pinSectionEl = document.getElementById("pin-section");
  const listEl = document.getElementById("identity-list");

  pinInputEl.style.display = "none";
  pinInputEl.setAttribute("aria-hidden", "true");
  pinInputEl.tabIndex = -1;
  loginBtnEl.style.display = "none"; // ไม่ต้องมีปุ่ม "เข้าสู่ระบบ" — ครบ 6 หลักแล้วเข้าเอง

  const mount = document.createElement("div");
  mount.id = "pin-pad-mount";
  mount.style.margin = "8px 0 12px";
  pinInputEl.parentNode.insertBefore(mount, pinInputEl);
  pinPad = mountPinPad(mount, { length: 6, onComplete: attemptPinLogin });

  // ปุ่มข้อความเล็ก "เปลี่ยนผู้ใช้"
  const changeBtn = document.createElement("button");
  changeBtn.type = "button";
  changeBtn.id = "btn-change-user";
  changeBtn.textContent = "เปลี่ยนผู้ใช้";
  changeBtn.setAttribute("aria-label", "เปลี่ยนผู้ใช้");
  changeBtn.style.cssText =
    "background:none;border:none;color:#1b2a49;text-decoration:underline;font-size:1rem;font-family:inherit;min-height:44px;padding:8px 4px;cursor:pointer;";
  changeBtn.addEventListener("click", () => {
    selectedShopUserId = null;
    pinSectionEl.classList.add("hidden");
    listEl.style.display = "";
    document.querySelectorAll(".identity-btn").forEach((b) => b.classList.remove("selected"));
    pinPad.reset();
  });
  pinSectionEl.insertBefore(changeBtn, pinSectionEl.firstChild);

  // สวิตช์ "จดจำอุปกรณ์": ขยายให้กดง่าย + คำเตือนด้านความปลอดภัย (ค่าเริ่มต้นปิด)
  const rememberEl = document.getElementById("remember-device-checkbox");
  rememberEl.style.width = "28px";
  rememberEl.style.height = "28px";
  rememberEl.style.flex = "none";
  const holder = rememberEl.closest("label") ?? rememberEl.parentElement;
  const hint = document.createElement("div");
  hint.style.cssText = "font-size:0.9rem;color:#5f6368;margin:4px 0 8px;";
  hint.textContent = "🔒 เปิดเฉพาะมือถือส่วนตัวของคุณเท่านั้น";
  holder.insertAdjacentElement("afterend", hint);

  return pinPad;
}

async function loadIdentities() {
  try {
    const { identities } = await listLoginIdentities();
    const sortedIdentities = sortIdentitiesForLogin(identities);
    const listEl = document.getElementById("identity-list");
    const pinSectionEl = document.getElementById("pin-section");
    ensurePinPad();
    listEl.innerHTML = "";
    listEl.style.display = "";
    selectedShopUserId = null;
    pinSectionEl.classList.add("hidden");
    pinPad.reset();
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
        listEl.style.display = "none"; // แสดงเฉพาะชื่อที่เลือก + ปุ่ม "เปลี่ยนผู้ใช้"
        pinSectionEl.classList.remove("hidden");
        pinPad.reset();
      });
      listEl.appendChild(btn);
    });
  } catch (err) {
    showToast(toFriendlyErrorMessage(err), "error");
  }
}

// (คงไว้เพื่อ Compatibility: ปุ่ม/ช่องพิมพ์ PIN เดิมถูกซ่อนแล้ว แต่ยังผูก Event ไว้เหมือนเดิม)
const handleLogin = preventDoubleSubmit(async () => {
  const pinInput = document.getElementById("pin-input");
  const pin = pinInput.value.trim();
  if (!selectedShopUserId) {
    showToast("กรุณาเลือกชื่อผู้ใช้ก่อน", "error");
    return;
  }
  if (!isValidPinFormat(pin)) {
    showToast("PIN ต้องเป็นตัวเลข 6 หลัก", "error");
    return;
  }
  try {
    await attemptPinLogin(pin);
    pinInput.value = "";
  } catch (err) {
    showToast(err.message, "error");
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
// Auto-refresh อัตโนมัติ (ทุก 20 วินาที) — ไม่รีเฟรชถ้ามีหน้าต่างรายละเอียดงานเปิดอยู่
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
// Header: ไอคอนแจ้งเตือน "LINE ส่งไม่สำเร็จ"
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
// Summary Cards
// ============================================================================
const CARD_DEFINITIONS = [
  // หน้าหลักเหลือ 2 ใบ: สิ่งที่เจ้าของร้านต้องทำจริง
  { key: "todo", label: "งานที่ต้องทำ", icon: "📋", group: "main", tone: "blue" },
  { key: "completedWaitingPickup", label: "งานเสร็จรอรับ", icon: "📦", group: "main", tone: "green" },
  // การ์ดอื่นย้ายไป "ดูเพิ่มเติม" (ยุบไว้)
  { key: "dueTomorrow", label: "งานพรุ่งนี้", icon: "📆", group: "more", tone: "neutral" },
  { key: "dueWithin3Days", label: "งานภายใน 3 วัน", icon: "⏱️", group: "more", tone: "neutral" },
];
function getAllCardData(jobs) {
  const base = computeDashboardCards(jobs);
  const owner = computeOwnerSummary(jobs); // todo = วันนี้ + เลยกำหนด (นับจากวันนัดที่ใช้จริง รวมงานเก่า)
  return { ...base, todo: owner.todo, completedWaitingPickup: owner.completedWaitingPickup };
}
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
  const cardData = getAllCardData(state.allJobs);
  const container = document.getElementById("summary-grid");
  container.innerHTML = "";

  const mainGrid = document.createElement("div");
  mainGrid.className = "summary-grid summary-grid-main";
  CARD_DEFINITIONS.filter((d) => d.group === "main").forEach((def) => {
    mainGrid.appendChild(buildSummaryCard(def, cardData));
  });
  container.appendChild(mainGrid);

  const moreDetails = document.createElement("details");
  moreDetails.className = "summary-more";
  moreDetails.open = !!CARD_DEFINITIONS.find((d) => d.group === "more" && d.key === state.activeCard);
  const moreSummary = document.createElement("summary");
  moreSummary.textContent = "ดูเพิ่มเติม";
  moreSummary.style.cssText = "min-height:44px;display:flex;align-items:center;cursor:pointer;font-weight:600;margin-top:8px;";
  const moreGrid = document.createElement("div");
  moreGrid.className = "summary-grid summary-grid-sub";
  CARD_DEFINITIONS.filter((d) => d.group === "more").forEach((def) => {
    moreGrid.appendChild(buildSummaryCard(def, cardData));
  });
  moreDetails.appendChild(moreSummary);
  moreDetails.appendChild(moreGrid);
  container.appendChild(moreDetails);
}
function getCardFilteredJobs() {
  if (state.showNotifFailedOnly) {
    const cardData = computeDashboardCards(state.allJobs);
    return cardData.notificationFailed ?? [];
  }
  if (!state.activeCard) return state.allJobs;
  const cardData = getAllCardData(state.allJobs);
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
  document.getElementById("search-input").placeholder = "🔎 ค้นหาเลขงาน ชื่อลูกค้า หรือเบอร์โทร";
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
  // ซ่อนงาน "รับแล้ว" เป็นค่าเริ่มต้น เว้นแต่เปิดสวิตช์ไว้ หรือเลือกสถานะ "รับแล้ว" ในตัวกรองเอง
  if (!state.showPickedUp && state.filters.status !== "picked_up") {
    jobs = jobs.filter((j) => j.status !== "picked_up");
  }
  if (state.selectedCalendarDate) {
    jobs = jobs.filter((j) => getEffectivePickupDate(j) === state.selectedCalendarDate);
  }
  jobs = filterJobs(jobs, state.filters);
  jobs = sortJobsForOwner(jobs); // เลยกำหนด -> วันนี้ -> วันนัดใกล้สุด -> ปิดงาน/ยกเลิกท้ายสุด

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
    const urgency = getUrgencyTag(job);
    const card = document.createElement("div");
    card.className = "job-card";
    card.innerHTML = `
      ${job.customers?.phone ? `<a href="tel:${escapeHtml(job.customers.phone)}" class="quick-call-btn" title="โทรหาลูกค้า" onclick="event.stopPropagation()">📞</a>` : ""}
      <div class="job-card-top">
        <div>
          <div class="job-number">${escapeHtml(job.job_number)}</div>
          <div class="customer-name">${escapeHtml(job.customers?.full_name ?? "-")}</div>
        </div>
        <span class="status-badge" style="background:${statusInfo.color}">${statusInfo.icon} ${statusInfo.label}</span>
      </div>
      <div class="job-card-meta">
        <span>✂️ ${escapeHtml(job.job_types?.label_th ?? job.job_type_other ?? "-")}</span>
        ${getEffectivePickupDate(job) ? `<span>📅 ${formatThaiDate(getEffectivePickupDate(job))} ${escapeHtml(getEffectivePickupTime(job).slice(0, 5))} น.</span>` : ""}
        ${urgency === "overdue" ? '<span class="urgent-tag">⚠️ เลยกำหนด</span>' : ""}
        ${urgency === "today" ? '<span class="urgent-tag" style="background:#e3e9f5;color:#1b2a49;">📅 วันนี้</span>' : ""}
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
    textEl.style.whiteSpace = "pre-line";
    textEl.style.fontSize = "1.15rem";
    textEl.style.lineHeight = "1.6";
    okBtn.style.minHeight = "56px";
    cancelBtn.style.minHeight = "52px";
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
// Event Delegation: ผูกที่ "job-modal-sheet" (Element แม่ที่ไม่ถูกแทนที่) ครั้งเดียวตอนเริ่มระบบ
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
  cancelled: { label: "ยกเลิกแล้ว", icon: "🚫", color: "#5f6368" },
};
const NOTIFICATION_TYPE_LABELS = {
  job_received: "รับคำขอฝากงาน",
  appointment_confirmed: "ยืนยันนัด",
  appointment_changed: "เปลี่ยนนัด",
  status_update: "แจ้งสถานะ",
  reminder: "แจ้งเตือน",
  other: "อื่น ๆ",
};
const RESCHEDULE_REASON_OPTIONS = ["งานต้องใช้เวลาเพิ่ม", "รอวัสดุ", "ร้านขอเลื่อนนัด", "อื่น ๆ"];
const LINE_EVENT_LABELS = {
  completed: "แจ้งงานเสร็จ",
  revoked: "แจ้งแก้ไข (ขออภัย)",
  appointment_changed: "แจ้งเปลี่ยนนัด",
  appointment_confirmed: "แจ้งยืนยันนัด",
  job_received: "แจ้งรับงาน",
};

// ผลการทำรายการ: แยก "บันทึกสำเร็จหรือไม่" ออกจาก "ส่ง LINE สำเร็จหรือไม่" (ใช้ Icon + ข้อความ ไม่ใช้สีอย่างเดียว)
function buildLineResultText(line) {
  if (!line || !line.event) return line?.note ? `ℹ️ ${line.note}` : "";
  const label = LINE_EVENT_LABELS[line.event] ?? "แจ้งลูกค้า";
  if (line.status === "sent") return `📨 ส่ง LINE สำเร็จ (${label})`;
  if (line.status === "pending") return `⏳ LINE กำลังส่ง (${label}) ดูสถานะในประวัติแจ้งเตือนด้านล่าง`;
  return `📵 ส่ง LINE ไม่สำเร็จ (${label}) กด "🔁 ลองส่งใหม่" ในประวัติแจ้งเตือนด้านล่างได้`;
}
function buildActionResult(savedText, line) {
  const lineText = buildLineResultText(line);
  const lineFailed = !!line && !!line.event && line.status !== "sent" && line.status !== "pending";
  return { savedText, lineText, warn: lineFailed };
}
function renderActionResultHtml(result) {
  if (!result) return "";
  const border = result.warn ? "#e65100" : "#1e8e3e";
  const bg = result.warn ? "#fff3e0" : "#e6f4ea";
  return `
    <div id="action-result" role="status" aria-live="polite"
         style="border:2px solid ${border};background:${bg};border-radius:14px;padding:12px 14px;margin:10px 0;font-size:1.05rem;font-weight:600;line-height:1.6;">
      <div>${escapeHtml(result.savedText)}</div>
      ${result.lineText ? `<div>${escapeHtml(result.lineText)}</div>` : ""}
    </div>`;
}
function getJobTotalPrice(job) {
  const total = job.price_final ?? job.price_estimate;
  return total == null ? null : Number(total);
}

async function openJobModal(jobId, actionResult = null) {
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
  const totalPrice = getJobTotalPrice(job);
  const balance = totalPrice != null ? Math.max(totalPrice - totalPaid, 0) : null;

  sheet.innerHTML = `
    <button class="modal-close-btn" id="modal-close-btn">✕ ปิด</button>
    <h2>${escapeHtml(job.job_number)} <span class="status-badge" style="background:${statusInfo.color}">${statusInfo.icon} ${statusInfo.label}</span></h2>
    ${renderActionResultHtml(actionResult)}
    ${buildStepperHtml(job.status)}
    <div class="modal-section" style="border-top:none;margin-top:0;padding-top:0;">
      <h3>👤 ข้อมูลลูกค้า</h3>
      <div class="info-row"><span class="label">ชื่อ</span><span class="value">${escapeHtml(job.customers?.full_name ?? "-")}</span></div>
      <div class="info-row"><span class="label">เบอร์โทร</span><span class="value">${escapeHtml(job.customers?.phone ?? "-")}</span></div>
      ${job.customers?.phone ? `<a href="tel:${escapeHtml(job.customers.phone)}" class="btn btn-secondary" style="margin-top:8px;">📞 โทรหาลูกค้า</a>` : ""}
    </div>
    <div class="modal-section" id="appointment-section"></div>
    <div class="modal-section" id="status-section">
      <h3>🔄 สถานะงาน</h3>
      <div id="status-buttons"></div>
    </div>
    <div class="modal-section">
      <h3>✂️ ข้อมูลงาน</h3>
      <div class="info-row"><span class="label">ประเภทงาน</span><span class="value">${escapeHtml(job.job_types?.label_th ?? job.job_type_other ?? "-")}</span></div>
      <div class="info-row"><span class="label">จำนวน</span><span class="value">${escapeHtml(quantityText)}</span></div>
      <div class="info-row"><span class="label">รายละเอียด</span><span class="value">${escapeHtml(job.description ?? "-")}</span></div>
      ${job.customer_note ? `<div class="info-row"><span class="label">หมายเหตุ (งานเก่า)</span><span class="value">${escapeHtml(job.customer_note)}</span></div>` : ""}
      <div class="info-row"><span class="label">วันที่ฝากงาน</span><span class="value">${formatThaiDate(job.created_at)}</span></div>
      ${job.is_urgent ? `<div class="urgent-tag" style="margin-top:6px;display:inline-block;">🚨 งานด่วน</div>` : ""}
    </div>
    ${images.length > 0 ? `
    <div class="modal-section">
      <h3>📷 รูปภาพ</h3>
      <div class="photo-grid-view">
        ${images.map((img) => `<img src="${escapeHtml(img.signedUrl ?? "")}" alt="รูปงาน" />`).join("")}
      </div>
    </div>` : ""}
    <div class="modal-section" id="payment-section"></div>
    <div class="modal-section" id="notification-history-section"></div>
    ${isAdminOnly ? `
    <div class="modal-section">
      <h3>🗄️ จัดการงาน (เฉพาะผู้ดูแลระบบ)</h3>
      <button class="btn btn-danger" id="btn-archive-job">เก็บถาวรงานนี้ (Soft Delete)</button>
    </div>` : ""}
  `;
  document.getElementById("modal-close-btn").addEventListener("click", closeJobModal);
  currentStepperScrollTarget = "status-section";

  renderAppointmentSection(job, isOwnerOrAdmin, totalPrice);
  renderStatusButtons(job, { balance, totalPrice, totalPaid });
  renderPaymentSection(job, paymentTransactions, { totalPaid, totalPrice, balance }, isOwnerOrAdmin);
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
        showToast(toFriendlyErrorMessage(err), "error");
      }
    }));
  }
}

// ============================================================================
// Notification History Section (ยุบไว้ จะเปิดเองเฉพาะเมื่อมีรายการส่งไม่สำเร็จ)
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
  const hasFailed = notifications.some((n) => n.status === "failed");
  section.innerHTML = `
    <details ${hasFailed ? "open" : ""}>
      <summary style="font-weight:700;font-size:1.05rem;min-height:44px;display:flex;align-items:center;cursor:pointer;">
        ${hasFailed ? "📵" : "📨"} ประวัติการแจ้งเตือน LINE (${notifications.length})
      </summary>
      ${notifications.map((n) => {
        const statusInfo = NOTIFICATION_STATUS_LABELS[n.status] ?? { label: n.status, icon: "❔", color: "#5f6368" };
        const typeLabel = NOTIFICATION_TYPE_LABELS[n.notification_type] ?? n.notification_type;
        return `
        <div class="payment-tx-card">
          <div class="payment-tx-top">
            <span>${escapeHtml(typeLabel)}</span>
            <span class="status-badge" style="background:${statusInfo.color}">${statusInfo.icon} ${escapeHtml(statusInfo.label)}</span>
          </div>
          <div class="payment-tx-meta">
            ${formatThaiDateTime(n.created_at)}
            ${n.status === "failed" && n.error_message ? `<br/>สาเหตุ: ${escapeHtml(n.error_message)}` : ""}
            ${n.retry_count > 0 ? `<br/>ลองส่งใหม่แล้ว ${n.retry_count} ครั้ง` : ""}
          </div>
          ${n.status === "failed" && isOwnerOrAdmin ? `<button class="btn btn-secondary btn-sm" data-retry-notif-id="${escapeHtml(n.id)}" style="margin-top:8px;">🔁 ลองส่งใหม่</button>` : ""}
        </div>`;
      }).join("")}
    </details>
  `;
  if (isOwnerOrAdmin) {
    section.querySelectorAll("[data-retry-notif-id]").forEach((btn) => {
      btn.addEventListener("click", preventDoubleSubmit(async () => {
        const notifId = btn.getAttribute("data-retry-notif-id");
        btn.disabled = true;
        btn.textContent = "กำลังลองส่งใหม่...";
        try {
          const res = await retryNotification({ accessToken: getAccessToken(), notificationId: notifId, notificationTable: "customer" });
          showToast(res?.already_sent ? "ข้อความนี้ส่งสำเร็จไปแล้ว ไม่ส่งซ้ำ" : "ส่งข้อความสำเร็จ", "success");
          await refreshJobs();
          openJobModal(jobId);
        } catch (err) {
          showToast(toFriendlyErrorMessage(err), "error");
          btn.disabled = false;
          btn.textContent = "🔁 ลองส่งใหม่";
        }
      }));
    });
  }
}

// ============================================================================
// Appointment Section — แสดงนัดรับให้เห็นทันที และแก้ได้ในกล่องที่ยุบไว้ (ปุ่มบันทึกปุ่มเดียว)
// ============================================================================
function renderAppointmentSection(job, isOwnerOrAdmin, totalPrice) {
  const section = document.getElementById("appointment-section");
  const currentDate = getEffectivePickupDate(job);
  const currentTime = getEffectivePickupTime(job).slice(0, 5);
  const isClosed = job.status === "picked_up" || job.status === "cancelled";
  const pickupNowHtml = currentDate
    ? `<div class="pickup-now" style="background:#e3e9f5;border-radius:14px;padding:12px 14px;font-size:1.15rem;font-weight:700;line-height:1.5;">📅 นัดรับ ${escapeHtml(formatThaiDate(currentDate))}${currentTime ? ` เวลา ${escapeHtml(currentTime)} น.` : ""}</div>`
    : `<div class="warning-box">⚠️ ยังไม่มีวันนัดรับ</div>`;
  const priceHtml = `<div class="info-row" style="margin-top:8px;"><span class="label">💰 ราคา</span><span class="value">${totalPrice != null ? escapeHtml(totalPrice.toLocaleString()) + " บาท" : "ยังไม่ระบุ"}</span></div>`;

  if (!isOwnerOrAdmin || isClosed) {
    section.innerHTML = `<h3>📅 นัดรับและราคา</h3>${pickupNowHtml}${priceHtml}`;
    return;
  }

  const timeOptions = [...PICKUP_TIME_SLOTS];
  if (currentTime && !timeOptions.includes(currentTime)) timeOptions.push(currentTime);
  timeOptions.sort();

  section.innerHTML = `
    <h3>📅 นัดรับและราคา</h3>
    ${pickupNowHtml}
    ${priceHtml}
    <details id="edit-appointment-details" style="margin-top:8px;">
      <summary style="font-weight:700;font-size:1.05rem;min-height:44px;display:flex;align-items:center;cursor:pointer;">✏️ แก้วันนัดหรือราคา</summary>
      <label style="font-weight:600;" for="confirm-date-input">วันที่นัดรับ</label>
      <input type="date" class="confirm-date-input" id="confirm-date-input" value="${escapeHtml(currentDate ?? "")}" />
      <label style="font-weight:600;" for="confirm-time-select">เวลานัดรับ</label>
      <select class="confirm-time-select" id="confirm-time-select">
        ${timeOptions.map((t) => `<option value="${escapeHtml(t)}" ${t === currentTime ? "selected" : ""}>${escapeHtml(t)} น.</option>`).join("")}
      </select>
      <div id="reschedule-compare" class="hidden" aria-live="polite"
           style="background:#fff8e1;border:2px solid #f9a825;border-radius:14px;padding:12px 14px;margin:10px 0;font-size:1.05rem;line-height:1.7;"></div>
      <div id="reschedule-reason-wrap" class="hidden">
        <label style="font-weight:600;" for="reschedule-reason-select">เหตุผล (ไม่บังคับ)</label>
        <select class="confirm-time-select" id="reschedule-reason-select">
          <option value="">— ไม่ระบุ —</option>
          ${RESCHEDULE_REASON_OPTIONS.map((r) => `<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`).join("")}
        </select>
      </div>
      <label style="font-weight:600;" for="price-estimate-input">ราคา (บาท)</label>
      <input type="number" min="0" step="0.01" inputmode="decimal" class="price-input" id="price-estimate-input" value="${escapeHtml(totalPrice ?? "")}" placeholder="ยังไม่ระบุ" />
      <button class="btn btn-primary" id="btn-save-price-and-appointment" style="margin-top:10px;" disabled>💾 บันทึก</button>
    </details>
  `;

  const dateEl = document.getElementById("confirm-date-input");
  const timeEl = document.getElementById("confirm-time-select");
  const priceEl = document.getElementById("price-estimate-input");
  const compareEl = document.getElementById("reschedule-compare");
  const reasonWrapEl = document.getElementById("reschedule-reason-wrap");
  const reasonEl = document.getElementById("reschedule-reason-select");
  const saveBtn = document.getElementById("btn-save-price-and-appointment");

  function readPrice() {
    return priceEl.value === "" ? null : Number(priceEl.value);
  }
  function getChangeState() {
    const dateChanged = !!dateEl.value && (dateEl.value !== currentDate || timeEl.value !== currentTime);
    const price = readPrice();
    const priceChanged = price !== totalPrice && !(price === null && totalPrice === null);
    return { dateChanged, priceChanged, price };
  }
  function refreshEditState() {
    const { dateChanged, priceChanged } = getChangeState();
    compareEl.classList.toggle("hidden", !dateChanged);
    reasonWrapEl.classList.toggle("hidden", !dateChanged);
    if (dateChanged) {
      compareEl.innerHTML = `
        <div>📅 วันเดิม: <b>${escapeHtml(formatThaiDate(currentDate))} ${escapeHtml(currentTime)} น.</b></div>
        <div>🆕 วันใหม่: <b>${escapeHtml(formatThaiDate(dateEl.value))} ${escapeHtml(timeEl.value)} น.</b></div>
        <div>📨 ระบบจะส่ง LINE แจ้งลูกค้าให้อัตโนมัติ</div>`;
    }
    saveBtn.disabled = !(dateChanged || priceChanged);
    saveBtn.textContent = dateChanged ? "💾 บันทึกวันนัดใหม่" : (priceChanged ? "💾 บันทึกราคา" : "💾 บันทึก");
  }
  [dateEl, timeEl, priceEl].forEach((el) => {
    el.addEventListener("input", refreshEditState);
    el.addEventListener("change", refreshEditState);
  });
  refreshEditState();

  saveBtn.addEventListener("click", preventDoubleSubmit(async () => {
    const { dateChanged, priceChanged, price } = getChangeState();
    if (!dateChanged && !priceChanged) return;
    if (priceChanged && price !== null && (Number.isNaN(price) || price < 0)) {
      showToast("ราคาต้องเป็นตัวเลขที่ไม่ติดลบ", "error");
      return;
    }
    if (dateChanged && (!dateEl.value || !timeEl.value)) {
      showToast("กรุณาเลือกวันและเวลาให้ครบถ้วน", "error");
      return;
    }
    saveBtn.disabled = true;
    let line = null;
    let savedParts = [];
    try {
      if (dateChanged) {
        const res = await confirmAppointment({
          accessToken: getAccessToken(),
          jobId: job.id,
          confirmedDate: dateEl.value,
          confirmedTime: timeEl.value,
          changeReason: reasonEl.value || null,
        });
        line = res?.line ?? null;
        savedParts.push("วันนัดใหม่");
      }
      if (priceChanged) {
        await setJobPricing({
          accessToken: getAccessToken(),
          jobId: job.id,
          priceEstimate: price,
          priceFinal: price,
          depositAmount: job.deposit_amount ?? 0,
        });
        savedParts.push("ราคา");
      }
      await refreshJobs();
      openJobModal(job.id, buildActionResult(`✅ บันทึก${savedParts.join("และ")}แล้ว`, line));
    } catch (err) {
      const prefix = savedParts.length > 0 ? `บันทึก${savedParts.join("และ")}แล้ว แต่ขั้นตอนถัดไปไม่สำเร็จ: ` : "ยังไม่ได้บันทึก: ";
      showToast(prefix + toFriendlyErrorMessage(err), "error");
      if (savedParts.length > 0) await refreshJobs();
      saveBtn.disabled = false;
    }
  }));
}

// ============================================================================
// Payment Section — สรุปยอด + ประวัติ (ยุบไว้)
// ============================================================================
function renderPaymentSection(job, transactions, totals, isOwnerOrAdmin) {
  const section = document.getElementById("payment-section");
  const { totalPaid, totalPrice, balance } = totals;
  const activeTransactions = transactions.filter((tx) => !tx.is_voided);
  const balanceHtml = totalPrice == null
    ? `<div class="warning-box">⚠️ ยังไม่ได้ระบุราคา จึงยังคำนวณยอดคงเหลือไม่ได้</div>`
    : (balance <= 0
        ? `<div class="balance-box"><div class="amount">0 บาท</div><div class="caption">✅ ชำระครบแล้ว</div></div>`
        : `<div class="balance-box">
             <div class="amount">${escapeHtml(balance.toLocaleString())} บาท</div>
             <div class="caption">ยอดคงเหลือ (ชำระแล้ว ${escapeHtml(totalPaid.toLocaleString())} จาก ${escapeHtml(totalPrice.toLocaleString())} บาท)</div>
           </div>`);
  const canVoid = isOwnerOrAdmin && activeTransactions.length > 0;
  section.innerHTML = `
    <h3>💳 การชำระเงิน</h3>
    ${balanceHtml}
    ${transactions.length > 0 ? `
    <details>
      <summary style="font-weight:700;font-size:1.05rem;min-height:44px;display:flex;align-items:center;cursor:pointer;">📜 ประวัติการชำระเงิน (${transactions.length})</summary>
      ${transactions.map(renderPaymentTxCardHtml).join("")}
      ${canVoid ? `<button type="button" class="btn btn-secondary btn-sm" id="btn-void-payments" style="margin-top:8px;color:var(--danger);border-color:var(--danger);">↩️ ยกเลิกรายการรับเงิน (ต้องระบุเหตุผล)</button>` : ""}
    </details>` : ""}
  `;
  if (canVoid) {
    document.getElementById("btn-void-payments").addEventListener("click", preventDoubleSubmit(async () => {
      const result = await showConfirmDialog({
        text: "ต้องการยกเลิกรายการรับเงินของงานนี้ใช่หรือไม่?\n(ระบบจะยกเลิกรายการรับเงินที่ยังไม่ถูกยกเลิกทั้งหมด และเก็บประวัติไว้)",
        requireReason: true,
        confirmLabel: "↩️ ยืนยันยกเลิกรายการรับเงิน",
      });
      if (!result.confirmed) return;
      try {
        for (const tx of activeTransactions) {
          await voidPayment({ accessToken: getAccessToken(), transactionId: tx.id, voidReason: result.reason });
        }
        await refreshJobs();
        openJobModal(job.id, buildActionResult("✅ ยกเลิกรายการรับเงินแล้ว", null));
      } catch (err) {
        showToast(toFriendlyErrorMessage(err), "error");
        await refreshJobs();
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
        ${escapeHtml(PAYMENT_METHOD_LABELS[tx.payment_method] ?? tx.payment_method)} • ${formatThaiDateTime(tx.received_at)} • โดย ${escapeHtml(tx.shop_users?.full_name ?? "-")}
        ${tx.is_voided ? `<br/>เหตุผลยกเลิก: ${escapeHtml(tx.void_reason ?? "-")} (โดย ${escapeHtml(tx.voider?.full_name ?? "-")})` : ""}
      </div>
      ${tx.payment_evidence.length > 0 ? `
      <div class="payment-tx-evidence">
        ${tx.payment_evidence.map((ev) => `<img src="${escapeHtml(ev.signedUrl ?? "")}" alt="หลักฐาน" />`).join("")}
      </div>` : ""}
    </div>
  `;
}

// ============================================================================
// เปิดงานกลับ (งานที่กด "รับแล้ว/ปิดงาน" ผิด) — เฉพาะเจ้าของร้าน/ผู้ดูแลระบบ
// เลือกสถานะที่ถูกต้อง 1 ข้อ แล้วกดยืนยันปุ่มเดียว (ไม่มีค่าเริ่มต้น เพื่อกันเลือกผิดโดยไม่ตั้งใจ)
// ============================================================================
function renderReopenPanel(job, money) {
  const container = document.getElementById("status-buttons");
  const customerName = job.customers?.full_name ?? "-";
  const paidNote = (money.totalPaid ?? 0) > 0
    ? `<div class="warning-box" style="margin:10px 0;">⚠️ งานนี้มีรายการรับเงินแล้ว ${escapeHtml(money.totalPaid.toLocaleString())} บาท ระบบจะ <b>ไม่</b> ยกเลิกเงินให้อัตโนมัติ ถ้ารับเงินผิดให้ยกเลิกรายการในส่วน "ประวัติการชำระเงิน" ด้านล่าง</div>`
    : "";
  const optionStyle = "display:flex;align-items:center;gap:10px;min-height:56px;font-size:1.1rem;cursor:pointer;";
  container.innerHTML = `
    <div class="readonly-note" style="font-weight:700;">↩️ เปิดงานกลับ: ${escapeHtml(job.job_number)} (${escapeHtml(customerName)})</div>
    <fieldset style="border:none;padding:0;margin:12px 0;">
      <legend style="font-weight:700;margin-bottom:6px;">ตอนนี้งานอยู่ในสถานะไหนจริง ๆ?</legend>
      <label style="${optionStyle}">
        <input type="radio" name="reopen-target" value="waiting" style="width:26px;height:26px;flex:none;" /> 📋 งานยังไม่เสร็จ (กลับไป "รับเข้าระบบ")
      </label>
      <label style="${optionStyle}">
        <input type="radio" name="reopen-target" value="completed" style="width:26px;height:26px;flex:none;" /> ✅ งานเสร็จแล้ว ลูกค้ายังไม่มารับ
      </label>
    </fieldset>
    <div id="reopen-hint" aria-live="polite" style="font-size:1rem;line-height:1.6;color:#5f6368;margin-bottom:8px;">กรุณาเลือก 1 ข้อ</div>
    ${paidNote}
    <button class="btn btn-primary btn-big-step" id="btn-confirm-reopen" disabled>↩️ ยืนยันเปิดงานกลับ</button>
    <button type="button" class="btn btn-secondary btn-sm" id="btn-reopen-back" style="margin-top:10px;">← กลับ</button>
  `;
  const hintEl = document.getElementById("reopen-hint");
  const confirmBtn = document.getElementById("btn-confirm-reopen");
  const getTarget = () => container.querySelector('input[name="reopen-target"]:checked')?.value ?? null;
  container.querySelectorAll('input[name="reopen-target"]').forEach((el) => {
    el.addEventListener("change", () => {
      const target = getTarget();
      confirmBtn.disabled = !target;
      hintEl.textContent = target === "waiting"
        ? "📨 ถ้าเคยแจ้งลูกค้าไปแล้วว่างานเสร็จ ระบบจะส่ง LINE ขออภัยให้อัตโนมัติ (ถ้าไม่เคยแจ้ง จะไม่ส่งอะไร)"
        : "📨 จะไม่ส่ง LINE ถึงลูกค้า";
    });
  });
  document.getElementById("btn-reopen-back").addEventListener("click", () => renderStatusButtons(job, money));
  confirmBtn.addEventListener("click", preventDoubleSubmit(async () => {
    const target = getTarget();
    if (!target) return;
    confirmBtn.disabled = true;
    try {
      const res = await changeJobStatus({
        accessToken: getAccessToken(), jobId: job.id, newStatus: target, reason: "กดรับแล้วผิด เปิดงานกลับ",
      });
      await refreshJobs();
      const savedText = target === "waiting"
        ? '✅ เปิดงานกลับเป็น "รับเข้าระบบ" แล้ว'
        : '✅ เปิดงานกลับเป็น "เสร็จแล้ว (รอลูกค้ารับ)" แล้ว';
      openJobModal(job.id, buildActionResult(savedText, res?.line ?? null));
    } catch (err) {
      showToast("ยังไม่ได้เปิดงานกลับ: " + toFriendlyErrorMessage(err), "error");
      confirmBtn.disabled = false;
    }
  }));
}

// ============================================================================
// Status Buttons — ขั้นตอนปกติ: รับเข้าระบบ → [✅ งานเสร็จแล้ว] → [💰 รับเงินและปิดงาน]
// ============================================================================
function renderStatusButtons(job, money) {
  const container = document.getElementById("status-buttons");
  const simplified = getSimplifiedStatusKey(job.status);
  const { balance, totalPrice, totalPaid } = money;
  const customerName = job.customers?.full_name ?? "-";
  const pickupText = getEffectivePickupDate(job)
    ? `${formatThaiDate(getEffectivePickupDate(job))} เวลา ${getEffectivePickupTime(job).slice(0, 5)} น.`
    : "-";

  if (simplified === "cancelled") {
    container.innerHTML = `<div class="readonly-note">🚫 งานนี้ถูกยกเลิกแล้ว</div>`;
    return;
  }
  if (simplified === "picked_up") {
    const role = getSessionSnapshot().appRole;
    const canReopen = role === "owner" || role === "admin";
    container.innerHTML = `
      <div class="readonly-note">📦 ลูกค้ารับงานแล้ว ปิดงานเรียบร้อย</div>
      ${canReopen ? `<button type="button" class="btn btn-secondary btn-sm" id="btn-reopen-step" style="margin-top:10px;">↩️ กดผิด เปิดงานกลับ</button>` : ""}
    `;
    if (canReopen) {
      document.getElementById("btn-reopen-step").addEventListener("click", () => renderReopenPanel(job, money));
    }
    return;
  }

  // ---------------- เสร็จแล้ว: รอลูกค้ามารับ ----------------
  if (simplified === "completed") {
    const hasBalance = totalPrice != null && balance != null && balance > 0;
    container.innerHTML = `
      <button class="btn btn-success btn-big-step" id="btn-next-step">${hasBalance ? "💰 รับเงินและปิดงาน" : "📦 ลูกค้ารับแล้ว"}</button>
      <button class="btn btn-secondary btn-sm" id="btn-revert-step" style="margin-top:10px;">↩️ กดผิด ย้อนกลับ</button>
    `;

    document.getElementById("btn-revert-step").addEventListener("click", preventDoubleSubmit(async () => {
      const result = await showConfirmDialog({
        text: `↩️ กดผิด ย้อนกลับ?\n\nเลขงาน: ${job.job_number}\nลูกค้า: ${customerName}\n\nงานจะกลับเป็น "📋 รับเข้าระบบ"\nถ้าเคยแจ้งลูกค้าว่างานเสร็จแล้ว ระบบจะส่ง LINE ขออภัยให้อัตโนมัติ`,
        requireReason: false,
        confirmLabel: "↩️ ยืนยันย้อนกลับ",
      });
      if (!result.confirmed) return;
      try {
        const res = await changeJobStatus({ accessToken: getAccessToken(), jobId: job.id, newStatus: "waiting", reason: "กดงานเสร็จผิด ย้อนกลับ" });
        await refreshJobs();
        openJobModal(job.id, buildActionResult("✅ ย้อนกลับเป็น \"รับเข้าระบบ\" แล้ว", res?.line ?? null));
      } catch (err) {
        showToast(toFriendlyErrorMessage(err), "error");
      }
    }));

    document.getElementById("btn-next-step").addEventListener("click", preventDoubleSubmit(async () => {
      // ไม่มียอดค้าง (หรือยังไม่ระบุราคา): ยืนยันครั้งเดียวแล้วปิดงาน
      if (!hasBalance) {
        const result = await showConfirmDialog({
          text: `📦 ยืนยันว่าลูกค้ารับงานแล้ว?\n\nเลขงาน: ${job.job_number}\nลูกค้า: ${customerName}${totalPrice == null ? "\n\n⚠️ ยังไม่ได้ระบุราคา (จะปิดงานโดยไม่บันทึกรับเงิน)" : ""}`,
          requireReason: false,
          confirmLabel: "📦 ยืนยันลูกค้ารับแล้ว",
        });
        if (!result.confirmed) return;
        try {
          await changeJobStatus({ accessToken: getAccessToken(), jobId: job.id, newStatus: "picked_up", reason: null });
          showToast("✅ ปิดงานเรียบร้อย", "success");
          await refreshJobs();
          closeJobModal();
        } catch (err) {
          showToast(toFriendlyErrorMessage(err), "error");
        }
        return;
      }

      // มียอดค้าง: เปิดขั้นตอนสั้นในหน้าจอเดียว (ยอดรวม/ชำระแล้ว/คงเหลือ + วิธีชำระ + ปุ่มยืนยันปุ่มเดียว)
      container.innerHTML = `
        <div class="info-row"><span class="label">ยอดรวม</span><span class="value">${escapeHtml(totalPrice.toLocaleString())} บาท</span></div>
        <div class="info-row"><span class="label">ชำระแล้ว</span><span class="value">${escapeHtml(totalPaid.toLocaleString())} บาท</span></div>
        <div class="balance-box"><div class="amount">${escapeHtml(balance.toLocaleString())} บาท</div><div class="caption">ยอดคงเหลือที่ต้องรับ</div></div>
        <fieldset style="border:none;padding:0;margin:12px 0;">
          <legend style="font-weight:700;margin-bottom:6px;">วิธีชำระเงิน</legend>
          <label style="display:flex;align-items:center;gap:10px;min-height:52px;font-size:1.1rem;cursor:pointer;">
            <input type="radio" name="pay-method" value="cash" checked style="width:26px;height:26px;" /> 💵 เงินสด
          </label>
          <label style="display:flex;align-items:center;gap:10px;min-height:52px;font-size:1.1rem;cursor:pointer;">
            <input type="radio" name="pay-method" value="transfer" style="width:26px;height:26px;" /> 📲 โอนเงิน
          </label>
        </fieldset>
        <button class="btn btn-success btn-big-step" id="btn-confirm-close">✅ ยืนยันรับเงินและปิดงาน</button>
        <button type="button" class="btn btn-secondary btn-sm" id="btn-pay-back" style="margin-top:10px;">← กลับ</button>
      `;
      document.getElementById("btn-pay-back").addEventListener("click", () => renderStatusButtons(job, money));
      const confirmBtn = document.getElementById("btn-confirm-close");
      confirmBtn.addEventListener("click", preventDoubleSubmit(async () => {
        const method = container.querySelector('input[name="pay-method"]:checked')?.value ?? "cash";
        confirmBtn.disabled = true;
        let paymentSaved = false;
        try {
          // Key คงที่ต่อ (งาน+ยอด): กดซ้ำ/Retry จะไม่สร้างรายการเงินซ้ำ (record-payment คืนรายการเดิม)
          await recordPayment({
            accessToken: getAccessToken(),
            jobId: job.id,
            transactionType: "payment",
            amount: balance,
            paymentMethod: method,
            note: null,
            idempotencyKey: getStablePaymentKey(job.id, balance),
          });
          paymentSaved = true;
          await changeJobStatus({ accessToken: getAccessToken(), jobId: job.id, newStatus: "picked_up", reason: null });
          clearStablePaymentKey(job.id, balance);
          showToast("✅ รับเงินและปิดงานเรียบร้อย", "success");
          await refreshJobs();
          closeJobModal();
        } catch (err) {
          if (paymentSaved) {
            showToast("บันทึกรับเงินแล้ว แต่ปิดงานไม่สำเร็จ กรุณากด \"✅ ยืนยันรับเงินและปิดงาน\" อีกครั้ง (ระบบจะไม่รับเงินซ้ำ)", "error");
          } else {
            showToast("ยังไม่ได้บันทึกรับเงิน: " + toFriendlyErrorMessage(err), "error");
          }
          confirmBtn.disabled = false;
        }
      }));
    }));
    return;
  }

  // ---------------- รับเข้าระบบ (รวมงานเก่าที่ยังเป็น pending_confirmation / waiting / in_progress) ----------------
  container.innerHTML = `
    <button class="btn btn-success btn-big-step" id="btn-next-step">✅ งานเสร็จแล้ว</button>
    <details style="margin-top:10px;">
      <summary style="min-height:44px;display:flex;align-items:center;cursor:pointer;">⚙️ ตัวเลือกพิเศษ</summary>
      <button class="btn btn-secondary btn-sm" id="btn-cancel-step" style="margin-top:6px;color:var(--danger);border-color:var(--danger);">🚫 ยกเลิกงานนี้</button>
    </details>
  `;
  document.getElementById("btn-next-step").addEventListener("click", preventDoubleSubmit(async () => {
    const result = await showConfirmDialog({
      text: `✅ ยืนยันว่างานเสร็จแล้ว?\n\nเลขงาน: ${job.job_number}\nลูกค้า: ${customerName}\nนัดรับ: ${pickupText}\n\nระบบจะส่ง LINE แจ้งลูกค้าอัตโนมัติ`,
      requireReason: false,
      confirmLabel: "✅ ยืนยันว่าเสร็จแล้ว",
    });
    if (!result.confirmed) return;
    try {
      const res = await changeJobStatus({ accessToken: getAccessToken(), jobId: job.id, newStatus: "completed", reason: null });
      await refreshJobs();
      openJobModal(job.id, buildActionResult("✅ บันทึกว่างานเสร็จแล้ว", res?.line ?? null));
    } catch (err) {
      showToast("ยังไม่ได้บันทึก: " + toFriendlyErrorMessage(err), "error");
    }
  }));
  document.getElementById("btn-cancel-step").addEventListener("click", preventDoubleSubmit(async () => {
    const result = await showConfirmDialog({
      text: `ต้องการยกเลิกงาน ${job.job_number} ใช่หรือไม่?`,
      requireReason: true,
      confirmLabel: "🚫 ยกเลิกงาน",
    });
    if (!result.confirmed) return;
    try {
      await changeJobStatus({ accessToken: getAccessToken(), jobId: job.id, newStatus: "cancelled", reason: result.reason });
      showToast("ยกเลิกงานแล้ว", "success");
      await refreshJobs();
      closeJobModal();
    } catch (err) {
      showToast(toFriendlyErrorMessage(err), "error");
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
