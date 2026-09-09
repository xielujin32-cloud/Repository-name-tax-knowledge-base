import { PHASE3C1_ASYNC_PREVIEW_TIME_BUDGET_MS, Phase3C1PreviewFailure, collectPhase3C1ApplyMaterial, validatePhase3C1PreviewJobSelectionInput } from '../../src/phase3c1-controlled-import.js';

// This runner deliberately persists only progress and safe summaries. The
// collection's raw HTML/materials are discarded after a terminal transition.
export async function runPhase3C1PreviewJob({ job_id, repository, fetchImpl = fetch, collectPreview = collectPhase3C1ApplyMaterial } = {}) {
  const claimed = await repository.beginPhase3C1PreviewJob(job_id);
  if (!claimed.claimed) return claimed.job;
  let frozenSelection;
  try { frozenSelection = validatePhase3C1PreviewJobSelectionInput(claimed.job.selection_input); }
  catch {
    return repository.blockPhase3C1PreviewJob(job_id, {
      failed_ordinal: null, failure_stage: 'selection', failure_code: 'FROZEN_SELECTION_INPUT_INVALID',
      successfully_processed_count: 0, upstream_attempts: []
    });
  }
  try {
    // Do not provide a path back to the current module's global pool: this
    // call carries the exact JSONB selection snapshot claimed with the Job.
    const { preview } = await collectPreview({ fetchImpl, frozen_selection_input: frozenSelection, time_budget_ms: PHASE3C1_ASYNC_PREVIEW_TIME_BUDGET_MS, onProgress: (progress) => repository.updatePhase3C1PreviewJobProgress(job_id, progress) });
    return await repository.finishPhase3C1PreviewJob(job_id, { preview, state: 'passed', frozen_selection_input: frozenSelection });
  } catch (error) {
    if (error instanceof Phase3C1PreviewFailure) return repository.blockPhase3C1PreviewJob(job_id, error.safe_diagnostic);
    // Do not persist an arbitrary exception message: it can contain upstream
    // implementation data. The code is sufficient for a safe operator retry.
    return repository.failPhase3C1PreviewJob(job_id, { exception_type: error?.name || 'Error' });
  }
}
