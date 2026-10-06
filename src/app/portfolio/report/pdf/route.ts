import { NextResponse } from 'next/server';
import { isMotionError } from '@/core/errors';
import { log } from '@/core/logging';
import { getPortfolioContext, loadPortfolioReport } from '@/modules/portfolio';
import { renderPortfolioPdf } from '@/modules/reporting';

export const dynamic = 'force-dynamic';

/**
 * The Portfolio Report as a PDF (ADR-149). The caller's own portfolio, composed now; a caller with
 * no portfolio gets the Command Centre's uniform 404. Nothing is stored or cached.
 */
export async function GET() {
  try {
    const ctx = await getPortfolioContext();
    if (ctx.organisations.length === 0) return new NextResponse(null, { status: 404 });
    const report = await loadPortfolioReport(ctx);
    const bytes = await renderPortfolioPdf(report);
    return new NextResponse(Buffer.from(bytes), {
      status: 200,
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `attachment; filename="portfolio-report-${report.today}.pdf"`,
        'cache-control': 'no-store',
      },
    });
  } catch (error) {
    if (isMotionError(error) && error.code === 'NOT_FOUND') return new NextResponse(null, { status: 404 });
    log.error('portfolio report pdf failed', { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json({ error: 'The report could not be produced just now.' }, { status: 500 });
  }
}
