// shared/job-image-upload.js
// อัปโหลดรูปงานขึ้น Supabase Storage โดยตรงจาก Client โดยใช้ Customer JWT
// (RLS ของ Bucket "job-photos" และตาราง job_images อนุญาตให้ลูกค้าอัปโหลดรูป
// ของงานตัวเองได้อยู่แล้ว ตามที่กำหนดไว้ใน Phase 2)

import { getSupabaseClient } from "./supabase-client.js";
import { compressImage, validateImageFile, generateRandomFileName } from "./utils.js";

/**
 * อัปโหลดรูปภาพ 1 ไฟล์ขึ้น Storage แล้วบันทึกลงตาราง job_images
 * @param {object} params
 * @param {string} params.jobId
 * @param {File} params.file
 * @param {string} params.customerAccessToken
 * @param {string} params.customerId
 */
export async function uploadJobImage({ jobId, file, customerAccessToken, customerId }) {
  const validation = validateImageFile(file);
  if (!validation.valid) {
    throw new Error(validation.message);
  }

  const compressedBlob = await compressImage(file);
  const fileName = generateRandomFileName(file);
  const storagePath = `${jobId}/${fileName}`;

  const supabase = getSupabaseClient(customerAccessToken);

  const { error: uploadError } = await supabase.storage
    .from("job-photos")
    .upload(storagePath, compressedBlob, {
      contentType: "image/jpeg",
      upsert: false,
    });

  if (uploadError) {
    throw new Error("อัปโหลดรูปภาพไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
  }

  const { error: insertError } = await supabase.from("job_images").insert({
    job_id: jobId,
    storage_path: storagePath,
    image_type: "job_photo",
    uploaded_by_customer_id: customerId,
    file_size_bytes: compressedBlob.size,
  });

  if (insertError) {
    throw new Error("บันทึกข้อมูลรูปภาพไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
  }

  return { storagePath };
}

/**
 * อัปโหลดรูปหลายไฟล์ต่อเนื่องกัน พร้อมรายงานความคืบหน้าทีละไฟล์
 * @param {object} params
 * @param {string} params.jobId
 * @param {File[]} params.files
 * @param {string} params.customerAccessToken
 * @param {string} params.customerId
 * @param {(current: number, total: number) => void} [params.onProgress]
 */
export async function uploadJobImages({ jobId, files, customerAccessToken, customerId, onProgress }) {
  const results = [];
  for (let i = 0; i < files.length; i++) {
    onProgress?.(i + 1, files.length);
    const result = await uploadJobImage({
      jobId,
      file: files[i],
      customerAccessToken,
      customerId,
    });
    results.push(result);
  }
  return results;
}
