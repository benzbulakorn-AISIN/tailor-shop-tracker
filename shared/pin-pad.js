// shared/pin-pad.js
// แป้นกด PIN 6 หลักบนหน้าจอ (สไตล์ iPhone Passcode) สำหรับหน้า Login ฝั่งร้าน
//
// ความปลอดภัย:
// - PIN เก็บเป็นตัวแปรใน Closure ของไฟล์นี้เท่านั้น (ไม่ลง LocalStorage/SessionStorage/DOM Attribute)
// - ล้างตัวเลขทุกครั้งหลังตรวจสอบ ไม่ว่าสำเร็จหรือไม่
// - ไม่มี <input> จึงไม่เปิดแป้นพิมพ์โทรศัพท์ และ Password Manager/Autofill ไม่เก็บ PIN
// - สร้าง DOM ด้วย createElement/textContent ทั้งหมด (ไม่ใช้ innerHTML)

const STYLE_ID = "qe-pin-pad-style";

const CSS = `
.qe-pinpad { max-width: 320px; margin: 0 auto; text-align: center; font-family: inherit; }
.qe-pinpad-dots { display: flex; justify-content: center; gap: 16px; margin: 8px 0 12px; }
.qe-pinpad-dot {
  width: 20px; height: 20px; border-radius: 50%;
  border: 2px solid #1b2a49; background: transparent; box-sizing: border-box;
  transition: background 0.12s;
}
.qe-pinpad-dot.filled { background: #1b2a49; }
.qe-pinpad.error .qe-pinpad-dot { border-color: #c5221f; }
.qe-pinpad.error .qe-pinpad-dot.filled { background: #c5221f; }
.qe-pinpad-status {
  min-height: 52px; font-size: 1.05rem; line-height: 1.4; font-weight: 600;
  color: #1b2a49; display: flex; align-items: center; justify-content: center; padding: 0 4px;
}
.qe-pinpad-status.is-error { color: #c5221f; }
.qe-pinpad-keys {
  display: grid; grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px; margin-top: 4px;
}
.qe-pinpad-key {
  min-height: 68px; border-radius: 999px; border: 2px solid #c9d1e0; background: #ffffff;
  color: #1b2a49; font-family: inherit; font-size: 1.75rem; font-weight: 700;
  cursor: pointer; display: flex; flex-direction: column; align-items: center; justify-content: center;
  line-height: 1.1; padding: 0; -webkit-tap-highlight-color: transparent; touch-action: manipulation;
  user-select: none; -webkit-user-select: none;
}
.qe-pinpad-key:active:not(:disabled) { background: #e3e9f5; }
.qe-pinpad-key:disabled { opacity: 0.45; cursor: not-allowed; }
.qe-pinpad-key:focus-visible { outline: 4px solid #f4b400; outline-offset: 2px; }
.qe-pinpad-key .qe-pinpad-key-sub { font-size: 0.8rem; font-weight: 600; margin-top: 2px; }
.qe-pinpad-key.is-delete { border-color: transparent; background: transparent; font-size: 1.6rem; }
.qe-pinpad-key.is-delete:active:not(:disabled) { background: #e3e9f5; }
.qe-pinpad-spacer { visibility: hidden; }
@keyframes qe-pinpad-shake {
  0%, 100% { transform: translateX(0); }
  20% { transform: translateX(-9px); }
  40% { transform: translateX(9px); }
  60% { transform: translateX(-6px); }
  80% { transform: translateX(6px); }
}
.qe-pinpad-dots.shake { animation: qe-pinpad-shake 0.35s ease-in-out; }
@media (prefers-reduced-motion: reduce) {
  .qe-pinpad-dots.shake { animation: none; }
  .qe-pinpad-dot { transition: none; }
}
@media (max-width: 340px) {
  .qe-pinpad-keys { gap: 10px; }
  .qe-pinpad-key { min-height: 62px; font-size: 1.6rem; }
  .qe-pinpad-dots { gap: 12px; }
}
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

/**
 * ติดตั้งแป้นกด PIN ลงใน container
 * @param {HTMLElement} container
 * @param {object} options
 * @param {number} [options.length=6] จำนวนหลักของ PIN
 * @param {(pin: string) => Promise<void>} options.onComplete เรียกเมื่อกรอกครบ ถ้า throw = PIN ผิด/ผิดพลาด
 * @returns {{ reset: Function, setMessage: Function, isBusy: Function, destroy: Function }}
 */
export function mountPinPad(container, options = {}) {
  const {
    length = 6,
    onComplete,
    busyText = "⏳ กำลังเข้าสู่ระบบ...",
    idleText = "กรุณากด PIN 6 หลัก",
  } = options;

  ensureStyle();
  container.textContent = "";

  let digits = []; // PIN อยู่ในหน่วยความจำนี้เท่านั้น
  let busy = false;
  let destroyed = false;

  const root = document.createElement("div");
  root.className = "qe-pinpad";

  const dotsEl = document.createElement("div");
  dotsEl.className = "qe-pinpad-dots";
  dotsEl.setAttribute("role", "img");
  const dotEls = [];
  for (let i = 0; i < length; i++) {
    const dot = document.createElement("span");
    dot.className = "qe-pinpad-dot";
    dotsEl.appendChild(dot);
    dotEls.push(dot);
  }

  const statusEl = document.createElement("div");
  statusEl.className = "qe-pinpad-status";
  statusEl.setAttribute("role", "status");
  statusEl.setAttribute("aria-live", "polite");

  const keysEl = document.createElement("div");
  keysEl.className = "qe-pinpad-keys";
  const keyButtons = [];

  function makeKey({ label, sub, ariaLabel, className, onPress }) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "qe-pinpad-key" + (className ? ` ${className}` : "");
    if (ariaLabel) btn.setAttribute("aria-label", ariaLabel);
    const main = document.createElement("span");
    main.textContent = label;
    main.setAttribute("aria-hidden", "true");
    btn.appendChild(main);
    if (sub) {
      const subEl = document.createElement("span");
      subEl.className = "qe-pinpad-key-sub";
      subEl.textContent = sub;
      subEl.setAttribute("aria-hidden", "true");
      btn.appendChild(subEl);
    }
    btn.addEventListener("click", onPress);
    keyButtons.push(btn);
    return btn;
  }

  const layout = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "spacer", "0", "delete"];
  layout.forEach((k) => {
    if (k === "spacer") {
      const spacer = document.createElement("div");
      spacer.className = "qe-pinpad-spacer";
      spacer.setAttribute("aria-hidden", "true");
      keysEl.appendChild(spacer);
    } else if (k === "delete") {
      keysEl.appendChild(
        makeKey({
          label: "⌫",
          sub: "ลบ",
          ariaLabel: "ลบตัวเลขตัวล่าสุด",
          className: "is-delete",
          onPress: () => pressDelete(),
        }),
      );
    } else {
      keysEl.appendChild(
        makeKey({ label: k, ariaLabel: `เลข ${k}`, onPress: () => pressDigit(k) }),
      );
    }
  });

  root.appendChild(dotsEl);
  root.appendChild(statusEl);
  root.appendChild(keysEl);
  container.appendChild(root);

  function renderDots() {
    dotEls.forEach((dot, i) => dot.classList.toggle("filled", i < digits.length));
    dotsEl.setAttribute("aria-label", `กรอกแล้ว ${digits.length} จาก ${length} หลัก`);
  }

  function setMessage(text, isError = false) {
    statusEl.textContent = text ?? "";
    statusEl.classList.toggle("is-error", !!isError);
    root.classList.toggle("error", !!isError);
  }

  function setBusy(value) {
    busy = value;
    keyButtons.forEach((b) => { b.disabled = value; });
    root.setAttribute("aria-busy", value ? "true" : "false");
  }

  function shake() {
    dotsEl.classList.remove("shake");
    void dotsEl.offsetWidth; // บังคับ Reflow เพื่อให้ Animation เล่นซ้ำได้
    dotsEl.classList.add("shake");
    if (navigator.vibrate) navigator.vibrate(120);
  }

  function clearDigits() {
    digits = [];
    renderDots();
  }

  function pressDigit(d) {
    if (busy || destroyed || digits.length >= length) return;
    if (statusEl.classList.contains("is-error")) setMessage(idleText, false);
    digits.push(d);
    renderDots();
    if (digits.length === length) submit();
  }

  function pressDelete() {
    if (busy || destroyed || digits.length === 0) return;
    digits.pop(); // ลบทีละหลัก
    renderDots();
    if (statusEl.classList.contains("is-error")) setMessage(idleText, false);
  }

  async function submit() {
    let pin = digits.join("");
    setBusy(true); // ปิดการกดซ้ำระหว่างตรวจสอบ
    setMessage(busyText, false);
    try {
      await onComplete?.(pin);
      setMessage("", false);
    } catch (err) {
      setMessage(`⚠️ ${err?.message || "PIN ไม่ถูกต้อง กรุณาลองใหม่"}`, true);
      shake();
    } finally {
      pin = "";
      clearDigits(); // ล้างตัวเลขทุกครั้ง
      setBusy(false);
    }
  }

  // Physical Keyboard (Accessibility): 0-9 และ Backspace
  function onKeyDown(e) {
    if (destroyed || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!container.isConnected || container.getClientRects().length === 0) return; // ซ่อนอยู่
    const target = e.target;
    const tag = (target?.tagName ?? "").toLowerCase();
    // ข้ามเฉพาะช่องที่พิมพ์ข้อความได้จริง (ไม่รวม checkbox/radio/ปุ่ม เช่น สวิตช์ "จดจำอุปกรณ์")
    const nonTextInputs = ["checkbox", "radio", "button", "submit", "reset"];
    const isTextField = tag === "textarea" || tag === "select" ||
      (tag === "input" && !nonTextInputs.includes((target.type || "").toLowerCase()));
    if (isTextField) return;
    if (/^[0-9]$/.test(e.key)) {
      e.preventDefault();
      pressDigit(e.key);
    } else if (e.key === "Backspace") {
      e.preventDefault();
      pressDelete();
    }
  }
  document.addEventListener("keydown", onKeyDown);

  renderDots();
  setMessage(idleText, false);

  return {
    /** ล้างตัวเลข + ข้อความ (เช่น ตอนเปลี่ยนผู้ใช้) */
    reset(message = idleText) {
      clearDigits();
      setMessage(message, false);
    },
    setMessage,
    isBusy: () => busy,
    destroy() {
      destroyed = true;
      document.removeEventListener("keydown", onKeyDown);
      digits = [];
      container.textContent = "";
    },
  };
}
