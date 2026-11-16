import { prisma } from '../../db/prisma.js';
import { env } from '../../config/env.js';
import { ApiError } from '../../utils/ApiError.js';

// Uploaded photos (service pictures) are kept in the database, not on disk: hosts like Render
// wipe the disk on every deploy, the database survives. They are served from /api/v1/media/:id.

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Detects the real type from the first bytes, so a renamed file cannot sneak in. */
export function sniffImageType(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

export const mediaUrl = (id) => `${env.PUBLIC_API_URL.replace(/\/$/, '')}/api/v1/media/${id}`;

export async function saveImage(buffer, userId) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new ApiError(400, 'NO_FILE', 'Choose a photo to upload');
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new ApiError(413, 'FILE_TOO_LARGE', 'The photo is too large. The limit is 5 MB.');
  }
  const mimeType = sniffImageType(buffer);
  if (!mimeType) {
    throw new ApiError(415, 'UNSUPPORTED_FILE', 'Only JPG, PNG or WebP photos are allowed');
  }
  const row = await prisma.media.create({
    data: { mimeType, sizeBytes: buffer.length, data: buffer, uploadedBy: userId },
    select: { id: true, mimeType: true, sizeBytes: true },
  });
  return { id: row.id, url: mediaUrl(row.id), mimeType: row.mimeType, sizeBytes: row.sizeBytes };
}

export const findImage = (id) =>
  prisma.media.findUnique({ where: { id }, select: { mimeType: true, data: true, createdAt: true } });
