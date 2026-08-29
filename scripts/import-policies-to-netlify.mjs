import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { importPolicies } from '../netlify/lib/policy-store.mjs';

const args = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
};
const apply = args.includes('--apply');
const all = args.includes('--all');
const confirmedFullImport = args.includes('--confirm-full-import');
const source = valueAfter('--source') || 'data/policy-seed.json';
const requestedLimit = Number(valueAfter('--limit') || 5);

if (apply && all && !confirmedFullImport) throw new Error('全量写入必须同时提供 --confirm-full-import。');
if (!Number.isInteger(requestedLimit) || requestedLimit < 1) throw new Error('--limit 必须是正整数。');

const data = JSON.parse(await readFile(resolve(process.cwd(), source), 'utf8'));
const policies = Array.isArray(data) ? data : data.policies;
if (!Array.isArray(policies)) throw new Error('导入文件必须是 policies 数组，或包含 policies 数组的 JSON 对象。');
const selected = all ? policies : policies.slice(0, requestedLimit);
const result = await importPolicies(selected, { dryRun: !apply });

console.log(JSON.stringify({ source, mode: apply ? 'apply' : 'dry-run', selected: selected.length, ...result }, null, 2));
if (result.errors.length) process.exitCode = 1;
