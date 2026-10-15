import { z } from 'zod';

const ActionSchema = z
  .object({
    worker_id: z.string(),
    action: z.string(),
    dx: z.number().optional(),
    dy: z.number().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    mine_id: z.string().optional(),
  });

export const AiResponseSchema = z
  .object({
    actions: z.array(ActionSchema),
    messages: z.array(z.string()).optional().default([]),
    notes: z.string().optional().default(''),
    /** Short per-worker explanation. Not called "thinking" in the prompt: asking a model to dump its
     *  reasoning trace can trip provider safeguards. Older "thinking" key still accepted. */
    rationale: z.string().optional(),
    thinking: z.string().optional(),
  })
  .transform(({ rationale, thinking, ...rest }) => ({ ...rest, thinking: rationale ?? thinking ?? '' }));

export type AiResponse = z.output<typeof AiResponseSchema>;

/** Parse an AI response; tolerates surrounding prose or ```json fences. Throws with a readable message. */
export function parseAiResponse(raw: string): AiResponse {
  const text = raw.trim();
  const candidates = [text];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) candidates.push(fence[1]);
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));

  let lastErr = 'empty response';
  for (const c of candidates) {
    try {
      const parsed = AiResponseSchema.safeParse(JSON.parse(c));
      if (parsed.success) return parsed.data;
      lastErr = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    } catch (e) {
      lastErr = (e as Error).message;
    }
  }
  throw new Error(`invalid AI response: ${lastErr}`);
}
