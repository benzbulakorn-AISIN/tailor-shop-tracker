// shared/job-constants.js
// ค่าคงที่ที่ใช้ร่วมกันระหว่างฟอร์มลูกค้าและ Dashboard ฝั่งร้าน
// เหตุผลที่แยกไฟล์นี้ออกจาก utils.js: ลูกค้า (Role "customer") ไม่มีสิทธิ์อ่านตาราง
// app_settings ผ่าน RLS (เฉพาะ Shop Staff เท่านั้น) จึงต้องฝังรายการเวลานัดรับไว้
// ฝั่ง Client ตรงนี้ โดยค่าต้องตรงกับ app_settings.pickup_time_slots ที่ร้านตั้งไว้
// หากร้านเปลี่ยนช่วงเวลาในอนาคต ต้องแก้ไฟล์นี้ให้ตรงกันด้วย (จะปรับเป็นระบบอ่านจาก
// Edge Function สาธารณะได้ในภายหลังหากจำเป็น)

export const PICKUP_TIME_SLOTS = [
  "09:00", "10:00", "11:00", "12:00", "13:00",
  "14:00", "15:00", "16:00", "17:00", "18:00", "19:00",
];

// ต้องตรงกับ seed data ในตาราง job_types (code เป็นตัวเชื่อมหลัก)
export const JOB_TYPES_FALLBACK = [
  { code: "new_sewing", label_th: "ตัดเย็บใหม่", allow_custom_detail: false },
  { code: "resize", label_th: "แก้ขนาด", allow_custom_detail: false },
  { code: "reshape", label_th: "แก้ทรง", allow_custom_detail: false },
  { code: "cut_pants", label_th: "ตัดขากางเกง", allow_custom_detail: false },
  { code: "change_zipper", label_th: "เปลี่ยนซิป", allow_custom_detail: false },
  { code: "patch_repair", label_th: "ปะหรือซ่อม", allow_custom_detail: false },
  { code: "fix_sleeve", label_th: "แก้แขนเสื้อ", allow_custom_detail: false },
  { code: "fix_waist", label_th: "แก้เอว", allow_custom_detail: false },
  { code: "change_button", label_th: "เปลี่ยนกระดุม", allow_custom_detail: false },
  { code: "other", label_th: "อื่น ๆ", allow_custom_detail: true },
];

export const MAX_JOB_PHOTOS = 5;
