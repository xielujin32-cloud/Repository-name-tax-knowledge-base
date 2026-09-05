import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NetlifyDB } from '@netlify/database-dev';
import { createLocalEvidenceObjectStore } from '../src/evidence-object-store.js';
import { createPostgresEvidenceRepository } from '../src/postgres-evidence-repository.js';

test('持久化 raw snapshot 在数据库层只能追加，不能更新或删除', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taxkb-postgres-evidence-'));
  const database = new NetlifyDB({ directory: path.join(root, 'database'), logger: () => {} });
  try {
    await database.start();
    await database.reset();
    await database.applyMigrations(path.join(process.cwd(), 'netlify', 'database', 'migrations'));
    const repository = createPostgresEvidenceRepository({
      pool: database,
      objectStore: createLocalEvidenceObjectStore({ rootDirectory: path.join(root, 'objects') })
    });
    const source = await repository.addSource({
      source_id: 'source-test', source_name: '官方测试来源', official_domain: 'example.gov.cn',
      source_type: 'policy-regulations', adapter_version: 'test', base_url: 'https://example.gov.cn/'
    });
    const run = await repository.createCollectionRun({ source_id: source.source_id });
    const snapshot = await repository.recordRawSnapshot({
      source_id: source.source_id, collection_run_id: run.collection_run_id,
      official_url: 'https://example.gov.cn/policy/1', raw_content: '<html>evidence</html>',
      normalized_text: 'evidence', parser_version: 'test', parse_result: { title: '测试政策' }
    });
    await assert.rejects(
      () => database.query('UPDATE raw_snapshots SET http_status=$1 WHERE snapshot_id=$2', [201, snapshot.snapshot_id]),
      /append-only evidence records/
    );
    await assert.rejects(
      () => database.query('DELETE FROM raw_snapshots WHERE snapshot_id=$1', [snapshot.snapshot_id]),
      /append-only evidence records/
    );
    await repository.close();
  } finally {
    await database.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('Level 3 审核通过只能创建一个 Policy 与 Policy Version，并保留审计链', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taxkb-postgres-review-'));
  const database = new NetlifyDB({ directory: path.join(root, 'database'), logger: () => {} });
  try {
    await database.start();
    await database.reset();
    await database.applyMigrations(path.join(process.cwd(), 'netlify', 'database', 'migrations'));
    const repository = createPostgresEvidenceRepository({
      pool: database,
      objectStore: createLocalEvidenceObjectStore({ rootDirectory: path.join(root, 'objects') }),
      id: (prefix) => `${prefix}-test`
    });
    const source = await repository.addSource({
      source_id: 'source-test', source_name: '官方测试来源', official_domain: 'example.gov.cn',
      source_type: 'policy-regulations', adapter_version: 'test', base_url: 'https://example.gov.cn/'
    });
    const run = await repository.createCollectionRun({ source_id: source.source_id });
    const snapshot = await repository.recordRawSnapshot({
      snapshot_id: 'snapshot-review', source_id: source.source_id, collection_run_id: run.collection_run_id,
      official_url: 'https://example.gov.cn/policy/review', raw_content: '<html>official body</html>',
      normalized_text: '官方正文', parser_version: 'test', parse_result: { title: '审核政策' }
    });
    const { candidate } = await repository.createCandidate({
      candidate_id: 'candidate-review', snapshot_id: snapshot.snapshot_id,
      parsed_fields: { title: '审核政策', document_no: '测试公告2026年第1号', issuing_authority: ['官方测试来源'], publish_date: '2026-01-01' }
    });
    const fields = { title: '审核政策', document_no: '测试公告2026年第1号', issuing_authority: ['官方测试来源'], publish_date: '2026-01-01', effective_date: '2026-01-02', expiry_date: null, tax_categories: [], topics: [], region: [], applicable_entities: [], keywords: ['审核政策'], summary: null, key_points: [], practical_guidance: null, related_policies: [] };
    const first = await repository.reviewCandidate(candidate.candidate_id, { action: 'approve', legal_status: 'effective', reviewer_id: 'reviewer-test', note: '已核验官方正文。', confirmed_fields: fields });
    assert.equal(first.execution, 'approve');
    assert.equal(first.candidate.verification_state, 'verified');
    assert.equal(first.candidate.legal_status, 'effective');
    assert.equal(first.review_decision.reviewer_id, 'reviewer-test');
    assert.equal(first.policy.current_policy_version_id, first.policy_version.policy_version_id);
    assert.deepEqual(await repository.counts(), { sources: 1, source_states: 1, collection_runs: 1, raw_snapshots: 1, candidates: 1, review_decisions: 1, policies: 1, policy_versions: 1, policy_relations: 0, audit_events: 1 });

    const second = await repository.reviewCandidate(candidate.candidate_id, { action: 'approve', legal_status: 'effective', reviewer_id: 'reviewer-test', confirmed_fields: fields });
    assert.equal(second.execution, 'already_approved');
    assert.equal(second.policy_version.policy_version_id, first.policy_version.policy_version_id);
    assert.deepEqual(await repository.counts(), { sources: 1, source_states: 1, collection_runs: 1, raw_snapshots: 1, candidates: 1, review_decisions: 1, policies: 1, policy_versions: 1, policy_relations: 0, audit_events: 1 });
    await repository.close();
  } finally {
    await database.stop();
    await rm(root, { recursive: true, force: true });
  }
});
