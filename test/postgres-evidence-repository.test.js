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
