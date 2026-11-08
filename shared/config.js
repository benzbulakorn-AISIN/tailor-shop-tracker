// shared/config.js
// ค่าตั้งค่าฝั่ง Client เท่านั้น (ปลอดภัยที่จะ Public ได้ทั้งหมด)
// ห้ามใส่ Service Role Key, Channel Secret, Channel Access Token, Admin/Bootstrap Secret
// หรือ Secret ใด ๆ ในไฟล์นี้เด็ดขาด เพราะไฟล์นี้ถูกโหลดลง Browser ของผู้ใช้ทุกคน
//
// วิธีใช้: แก้ค่าด้านล่างให้ตรงกับ Project จริงก่อน Deploy ทุกครั้ง
// ค่าทั้งหมดในไฟล์นี้เป็น Public Key อยู่แล้ว จึงไม่ใช่ความลับ หากหลุดไปก็ไม่เป็นอันตราย

export const APP_CONFIG = {
  // Supabase Project (Public: Anon Key ปลอดภัยที่จะเปิดเผย เพราะ RLS คุมสิทธิ์จริง)
  SUPABASE_URL: "https://itcajghewtxtudoaqaxa.supabase.co",
  SUPABASE_ANON_KEY: "__REPLACE_WITH_ANON_KEY__",

  // Base URL ของ Edge Functions (ปกติคือ SUPABASE_URL + /functions/v1)
  FUNCTIONS_BASE_URL: "https://itcajghewtxtudoaqaxa.supabase.co/functions/v1",

  // LINE LIFF (Public: LIFF ID ไม่ใช่ความลับ ต้องฝังใน Client เสมอ)
  // ยังไม่มีค่าจริงจนกว่าจะถึง Phase 8 (LINE Official Account Setup)
  LIFF_ID_CUSTOMER_FORM: "__REPLACE_WITH_LIFF_ID__",
  LIFF_ID_CUSTOMER_STATUS: "__REPLACE_WITH_LIFF_ID__",

  // โหมดจำลอง LIFF ชั่วคราว (ใช้ทดสอบฟอร์มก่อนมี LINE Official Account จริง)
  // ⚠️ ต้องเปลี่ยนเป็น false ก่อน Deploy ใช้งานจริงกับลูกค้า (ทำใน Phase 8)
  LIFF_MOCK_MODE: true,

  // Environment ปัจจุบัน ใช้ควบคุม Log Level / Debug UI เท่านั้น
  ENVIRONMENT: "development", // "development" | "production"

  // Timezone คงที่ของระบบ (แสดงผลเท่านั้น ไม่ใช้คำนวณ Business Logic ฝั่ง Client)
  DISPLAY_TIMEZONE: "Asia/Bangkok",
};
