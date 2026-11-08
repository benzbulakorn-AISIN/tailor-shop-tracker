// shared/payment-evidence-upload.js
// อัปโหลดรูปหลักฐานการชำระเงินขึ้น Supabase Storage โดยตรงจาก Client โดยใช้
// Shop User JWT (RLS ของ Bucket "payment-evidence" อนุญาตเฉพาะ Shop Staff
// ที่ Active เท่านั้น ตามที่กำหนดไว้ใน Phase 2/3)

import { getSupabaseClient } from "./supabase-client.js";
import { compressImage, validateImageFile, generateRandomFileName } from "./utils.js";

/**
 * อัปโหลดรูปหลักฐานการชำระเงิน 1 ไฟล์ แล้วบันทึกลงตาราง payment_evidence
 * @param {object} params
 * @param {string} params.transactionId
 * @param {File} params.file
 * @param {string} params.accessToken
 * @param {string} params.uploadedByShopUserId
 */
export async function uploadPaymentEvidence({ transactionId, file, accessToken, uploadedByShopUserId }) {
  const validation = validateImageFile(file);
  if (!validation.valid) {
    throw new Error(validation.message);
  }

  const compressedBlob = await compressImage(file);
  const fileName = generateRandomFileName(file);
  const storagePath = `${transactionId}/${fileName}`;

  const supabase = getSupabaseClient(accessToken);

  const { error: uploadError } = await supabase.storage
    .from("payment-evidence")
    .upload(storagePath, compressedBlob, { contentType: "image/jpeg", upsert: false });

  if (uploadError) {
    throw new Error("อัปโหลดหลักฐานการชำระเงินไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
  }

  const { error: insertError } = await supabase.from("payment_evidence").insert({
    payment_transaction_id: transactionId,
    storage_path: storagePath,
    uploaded_by: uploadedByShopUserId,
  });

  if (insertError) {
    throw new Error("บันทึกข้อมูลหลักฐานไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
  }

  return { storagePath };
}
