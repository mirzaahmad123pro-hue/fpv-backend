// utils/imgbbHelper.js
//
// Uploads an in-memory image buffer to ImgBB and returns the permanent
// direct image URL ImgBB assigns it. That URL is what should be saved to
// the database — never a local file path and never the raw buffer.
//
// Requires: IMGBB_API_KEY in .env (get one free at https://api.imgbb.com)
// Requires packages: axios, form-data
//   npm install axios form-data

const axios = require('axios');
const FormData = require('form-data');

const IMGBB_UPLOAD_URL = 'https://api.imgbb.com/1/upload';

/**
 * Upload a single image buffer to ImgBB.
 * @param {Buffer} fileBuffer - raw image bytes, e.g. req.file.buffer
 * @returns {Promise<string>} the direct, permanent image URL from ImgBB
 * @throws {Error} if the API key is missing, the buffer is missing, or
 *                  the ImgBB request fails / returns no URL
 */
async function uploadToImgBB(fileBuffer) {
  if (!process.env.IMGBB_API_KEY) {
    throw new Error('IMGBB_API_KEY is not set in the environment.');
  }
  if (!fileBuffer || !Buffer.isBuffer(fileBuffer)) {
    throw new Error('uploadToImgBB requires a valid file buffer.');
  }

  const form = new FormData();
  form.append('image', fileBuffer.toString('base64'));

  try {
    const response = await axios.post(IMGBB_UPLOAD_URL, form, {
      params: { key: process.env.IMGBB_API_KEY },
      headers: form.getHeaders(),
      // Base64-encoded images are ~33% larger than the raw buffer, so
      // don't let axios's default body-size limits reject valid uploads.
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    });

    const url = response.data && response.data.data && response.data.data.url;
    if (!url) {
      throw new Error('ImgBB response did not include an image URL.');
    }
    return url;
  } catch (err) {
    const apiMessage = err.response && err.response.data && err.response.data.error
      ? err.response.data.error.message
      : null;
    throw new Error(`ImgBB upload failed: ${apiMessage || err.message}`);
  }
}

/**
 * Convenience helper for uploading several buffers in parallel.
 * Rejects as soon as any single upload fails.
 * @param {Buffer[]} fileBuffers
 * @returns {Promise<string[]>} array of URLs, in the same order as input
 */
async function uploadManyToImgBB(fileBuffers = []) {
  return Promise.all(fileBuffers.map(uploadToImgBB));
}

module.exports = { uploadToImgBB, uploadManyToImgBB };
