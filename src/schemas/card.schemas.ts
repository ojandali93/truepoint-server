import { z } from 'zod';

export const identifyFromBase64Schema = z.object({
  image: z.string().min(100, 'Invalid base64 image data'),
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']).default('image/jpeg'),
});

export const identifyFromUrlSchema = z.object({
  imageUrl: z.string().url('Must be a valid image URL'),
});
