import { z } from "zod";

export const contentPartSchema = z
  .object({
    type: z.string(),
    text: z.string().optional(),
    image_url: z
      .object({
        url: z.string(),
        detail: z.string().optional(),
      })
      .optional(),
  })
  .passthrough();

export type ContentPartInput = z.infer<typeof contentPartSchema>;

export const messageContentSchema = z.union([
  z.string(),
  z.array(contentPartSchema),
]);
