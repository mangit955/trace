import type { InvestigationId, TenantContext } from '@trace/domain';
import type { InvestigationReport } from './report.ts';

/**
 * Storage for the report an engineer was actually shown.
 *
 * Reasoning is not free and not deterministic. Regenerating a report to answer "why?" costs a live
 * model call — 40 seconds on a real Telegram thread — and, far worse, can return *different*
 * hypotheses, so the explanation would justify a conclusion the user never saw. A report is
 * therefore written once and read back, exactly like the evidence it cites.
 *
 * Declared here rather than in `@trace/domain` because `InvestigationReport` lives here: the port
 * belongs with the type it stores. `@trace/db` implements it alongside the domain repositories.
 */
export interface ReportRepository {
  save(ctx: TenantContext, report: InvestigationReport): Promise<void>;
  findFor(
    ctx: TenantContext,
    investigationId: InvestigationId,
  ): Promise<InvestigationReport | undefined>;
}
