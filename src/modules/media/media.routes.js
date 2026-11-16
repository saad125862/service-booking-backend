import express, { Router } from 'express';
import { z } from 'zod';
import { created } from '../../utils/response.js';
import { ApiError } from '../../utils/ApiError.js';
import { validate } from '../../middleware/validate.js';
import { findImage, MAX_IMAGE_BYTES, saveImage } from './media.service.js';

// Admin upload: the raw image bytes are the request body (Content-Type image/jpeg, image/png or
// image/webp), so no multipart parser is needed. Mounted under /admin, after requireAdmin.
export const uploadRoutes = Router();

uploadRoutes.post(
  '/image',
  express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: MAX_IMAGE_BYTES + 1024 }),
  async (req, res) => {
    // express.raw leaves the body as {} when the content type is not an allowed image type.
    if (!Buffer.isBuffer(req.body)) {
      throw new ApiError(415, 'UNSUPPORTED_FILE', 'Send the photo as image/jpeg, image/png or image/webp');
    }
    created(res, await saveImage(req.body, req.user.id));
  },
);

// Public: anyone with the link can view a service photo (they are shown to every customer).
export const mediaRoutes = Router();

mediaRoutes.get('/:id', validate({ params: z.object({ id: z.uuid() }) }), async (req, res) => {
  const image = await findImage(req.valid.params.id);
  if (!image) throw ApiError.notFound('Photo not found');
  res
    .set('Content-Type', image.mimeType)
    .set('Cache-Control', 'public, max-age=31536000, immutable')
    // helmet's default would block the app (another origin on the web) from showing the image.
    .set('Cross-Origin-Resource-Policy', 'cross-origin')
    .set('Content-Disposition', 'inline')
    .send(image.data);
});
