const crypto = require('crypto');

async function uploadToSupabase(buffer, mimeType = 'image/jpeg') {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const bucket = 'product-images';

  if (!supabaseUrl || !serviceKey) {
    throw new Error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing in environment variables.');
  }

  // Generate unique filename
  const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.jpg`;
  const cleanUrl = supabaseUrl.replace(/\/$/, '');
  const uploadEndpoint = `${cleanUrl}/storage/v1/object/${bucket}/${filename}`;

  // Native Node.js fetch use karke upload karein
  const response = await fetch(uploadEndpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${serviceKey}`,
      'apikey': serviceKey,
      'Content-Type': mimeType,
      'x-upsert': 'true'
    },
    body: buffer
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Supabase Storage upload failed: ${response.status} ${errText}`);
  }

  // Return public CDN URL
  return `${cleanUrl}/storage/v1/object/public/${bucket}/${filename}`;
}

module.exports = {
  uploadToImgBB: uploadToSupabase, // purane code ko bina chhede Supabase par redirect kar diya
  uploadToSupabase
};
