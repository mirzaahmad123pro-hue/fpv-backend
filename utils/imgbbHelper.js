const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const BUCKET_NAME = process.env.SUPABASE_BUCKET || 'products';

async function uploadToSupabase(file) {
  if (!file) return null;

  try {
    let fileBuffer;
    if (file.buffer) {
      fileBuffer = file.buffer;
    } else if (file.path) {
      fileBuffer = fs.readFileSync(file.path);
    } else {
      return null;
    }

    const originalName = file.originalname || 'image.png';
    const fileName = `${Date.now()}-${originalName.replace(/\s+/g, '_')}`;
    const filePath = `uploads/${fileName}`;

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

    const { data: publicUrlData } = supabase.storage
      .from(BUCKET_NAME)
      .getPublicUrl(filePath);

    return publicUrlData.publicUrl;
  } catch (error) {
    console.error('Supabase storage upload failed:', error.message);
    throw error;
  }
}

module.exports = uploadToSupabase;
module.exports.uploadToImgBB = uploadToSupabase;
module.exports.uploadImageToImgBB = uploadToSupabase;
