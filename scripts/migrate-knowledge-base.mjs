import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ensurePolicySchema } from '../src/policy-schema.js';

const dataFile = resolve(process.cwd(), 'data', 'knowledge-base.json');
const data = JSON.parse(await readFile(dataFile, 'utf8'));
const result = ensurePolicySchema(data);

if (result.changed) await writeFile(dataFile, `${JSON.stringify(data, null, 2)}\n`, 'utf8');

console.log(`标准政策集合已就绪：${data.policies.length} 条；本次新增迁移：${result.additions} 条。`);
