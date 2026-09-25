import { z } from "zod";

/** 官方 client/configs 的验证配置；未返回配置与明确关闭必须区分。 */
export const captchaConfigSchema = z.discriminatedUnion("enabled", [
  z.object({ enabled: z.literal(false) }).passthrough(),
  z
    .object({
      enabled: z.literal(true),
      region: z.string().min(1),
      prefix: z.string().min(1),
      sceneId: z.string().min(1),
    })
    .passthrough(),
]);

export type CaptchaConfig = z.infer<typeof captchaConfigSchema>;

export function parseCaptchaConfig(raw: unknown): CaptchaConfig | null {
  if (raw == null) return null;
  const result = captchaConfigSchema.safeParse(raw);
  return result.success ? result.data : null;
}
