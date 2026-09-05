import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

test('Evidence 审核页面使用运行时密码输入，不持久化管理员 Token', async () => {
  const html = await readFile(path.join(process.cwd(), 'public', 'evidence-review.html'), 'utf8');
  const script = await readFile(path.join(process.cwd(), 'public', 'evidence-review.js'), 'utf8');
  assert.match(html, /type="password"/);
  assert.match(script, /let adminToken = ''/);
  assert.match(script, /\/api\/admin\/evidence\/candidates/);
  assert.match(script, /authorization: `Bearer \$\{adminToken\}`/);
  assert.doesNotMatch(script, /localStorage|sessionStorage|NETLIFY_TAXKB_ADMIN_TOKEN/);
});
