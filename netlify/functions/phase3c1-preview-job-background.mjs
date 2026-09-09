import { createPostgresEvidenceRepository } from '../../src/postgres-evidence-repository.js';
import { createNetlifyBlobsEvidenceObjectStore } from '../../src/evidence-object-store.js';
import { runPhase3C1PreviewJob } from '../lib/phase3c1-preview-job.mjs';

export const config = { background: true };

export function createPhase3C1PreviewJobBackgroundHandler({ repositoryFactory = () => createPostgresEvidenceRepository({ objectStore: createNetlifyBlobsEvidenceObjectStore() }), previewJobRunner = runPhase3C1PreviewJob, dispatchToken = () => process.env.NETLIFY_PHASE3C1_PREVIEW_JOB_DISPATCH_TOKEN } = {}) {
  return async (request) => {
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    const expected = String(dispatchToken() || '');
    if (!expected || request.headers.get('x-phase3c1-preview-dispatch') !== expected) return new Response(null, { status: 401 });
    let body; try { body = await request.json(); } catch { return new Response(null, { status: 400 }); }
    if (!body || typeof body.job_id !== 'string' || !body.job_id.trim() || Object.keys(body).length !== 1) return new Response(null, { status: 400 });
    await previewJobRunner({ job_id: body.job_id, repository: repositoryFactory() });
    return new Response(null, { status: 204 });
  };
}

export default createPhase3C1PreviewJobBackgroundHandler();
