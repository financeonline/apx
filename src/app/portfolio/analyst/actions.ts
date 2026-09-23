'use server';

import { revalidatePath } from 'next/cache';
import { askAdviser, getPortfolioContext } from '@/modules/portfolio';
import { done, fail, text } from '@/app/_lib/server-action';
import type { ActionResult } from '@/components/action-result';

/**
 * The adviser analyst's one write: a question. The resolver decides whose portfolio it is asked
 * over, the database re-checks that scope before the model is called, and the answer is recorded
 * with what the server observed (ADR-113).
 */
export async function askAdviserAction(_previous: ActionResult | null, form: FormData): Promise<ActionResult> {
  let requestId: string | undefined;
  try {
    const ctx = await getPortfolioContext();
    requestId = ctx.requestId;
    const question = text(form, 'question').trim();
    if (question.length === 0) return fail(new Error('Ask a question first.'), { requestId, action: 'portfolio.ask' });
    const result = await askAdviser(ctx, question);
    revalidatePath('/portfolio/analyst');
    return done(result.status === 'failed'
      ? 'The adviser analyst could not answer that. The question is recorded; try again in a moment.'
      : 'Answered.');
  } catch (error) {
    return fail(error, { requestId, action: 'portfolio.ask' });
  }
}
