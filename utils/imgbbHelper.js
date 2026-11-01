const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

// Supabase credentials (.env se uthayega)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Bucket ka naam jo tumne Supabase storage mein banaya hoga (jaise 'products', 'uploads', etc.)
const BUCKET_NAME = process.env.SUPABASE_BUCKET || 'products';

async function uploadToSupabase(file) {
  if (!file) return null;

  try {
    const fileBuffer = file.buffer || fs.readFileSync(file.path);
    const fileName = `${Date.now()}-${file.originalname || 'image.png'}`;
    const filePath = `uploads/${fileName}`;

    // Supabase Storage mein upload karein
    const { data, error } = await supabase.storage
      .from(BUCKET_NAME)
      .upload(filePath, fileBuffer, {
        contentType: file.mimetype || 'image/png',
        upsert: true
      });

    if (error) {
      console.error('Supabase upload error details:', error);
      throw error;
    }

    // Public URL hasil karein
    const { data: publicUrlData } = supabase.storage
      .from(BUCKET_NAME)
      .getPublicUrl(filePath);

    return publicUrlData.publicUrl;
  } catch (error) {
    console.error('Supabase storage upload failed:', error.message);
    return file.path || null;
  }
}

// Export taake har jagah kaam kare
module.exports = uploadToSupabase;
module.exports.uploadToImgBB = uploadToSupabase;
module.exports.uploadImageToImgBB = uploadToSupabase;
