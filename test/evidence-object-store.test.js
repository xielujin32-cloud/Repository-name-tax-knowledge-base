import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLocalEvidenceObjectStore, EVIDENCE_RAW_STORE_NAME } from '../src/evidence-object-store.js';

test('本地 taxkb-evidence-raw 对象层跨实例保存且拒绝覆盖', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taxkb-evidence-'));
  try {
    const first = createLocalEvidenceObjectStore({ rootDirectory: root });
    await first.putImmutable('raw-snapshots/snapshot-1/raw', '<html>原始证据</html>');
    const restarted = createLocalEvidenceObjectStore({ rootDirectory: root });
    assert.equal(await restarted.read('raw-snapshots/snapshot-1/raw'), '<html>原始证据</html>');
    await assert.rejects(() => restarted.putImmutable('raw-snapshots/snapshot-1/raw', '覆盖'), /不可覆盖/);
    assert.equal(EVIDENCE_RAW_STORE_NAME, 'taxkb-evidence-raw');
  } finally { await rm(root, { recursive: true, force: true }); }
});
