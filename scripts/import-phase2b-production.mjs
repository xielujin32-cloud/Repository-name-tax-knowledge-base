import process from 'node:process';
import { createInterface } from 'node:readline/promises';

export const PHASE_2B_PRODUCTION_IMPORT_URL = 'https://xielujin-tax-knowledge-base.netlify.app/api/admin/evidence/import-phase2b';
export const PHASE_2B_LOCAL_CONFIRMATION = 'IMPORT_PHASE2B_TWO_CANDIDATES';
const SERVER_CONFIRMATION = 'INGEST_PHASE2B_STA_TWO_URLS';

function safeDiagnosticValue(value, pattern) {
  const text = String(value || '').trim();
  return pattern.test(text) ? text : null;
}

export function createSafeNetworkDiagnostic(error, token) {
  const tokenText = String(token || '');
  let message = String(error?.message || '网络请求失败');
  if (tokenText) message = message.split(tokenText).join('[REDACTED]');
  message = message
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/ig, '$1[REDACTED]')
    .replace(/(bearer\s+)[^\s,;]+/ig, '$1[REDACTED]')
    .replace(/(request[ _-]?body|body)\s*[:=]\s*(?:\{.*?\}|[^\s,;]+)/ig, '$1=[REDACTED]')
    .replace(/[\r\n\t]/g, ' ')
    .slice(0, 240);
  const cause = error?.cause;
  return {
    error: 'network_request_failed',
    error_name: safeDiagnosticValue(error?.name, /^[A-Za-z0-9_.-]{1,120}$/) || 'Error',
    error_message: message,
    cause_code: safeDiagnosticValue(cause?.code, /^[A-Za-z0-9_.-]{1,120}$/),
    cause_errno: safeDiagnosticValue(cause?.errno, /^-?[0-9]{1,20}$/),
    cause_syscall: safeDiagnosticValue(cause?.syscall, /^[A-Za-z0-9_.-]{1,120}$/)
  };
}

export class Phase2BNetworkRequestError extends Error {
  constructor(diagnostic) {
    super('导入网络请求未完成。');
    this.name = 'Phase2BNetworkRequestError';
    this.diagnostic = diagnostic;
  }
}

export function parseArguments(argumentsList = process.argv.slice(2)) {
  if (argumentsList.length === 0) return { tokenSource: 'prompt' };
  if (argumentsList.length === 1 && argumentsList[0] === '--from-env') return { tokenSource: 'environment' };
  throw new Error('该工具不接受 URL、文件、政策内容或 ID 参数；仅允许可选 --from-env。');
}

export async function readHiddenSecret({ input = process.stdin, output = process.stdout, prompt = '请输入管理员 Token（输入不显示）：' } = {}) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    throw new Error('当前终端无法安全无回显输入 Token；请在本机交互式终端运行。');
  }
  output.write(prompt);
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const cleanup = () => {
      input.off('data', onData);
      input.setRawMode(false);
      input.pause();
    };
    const onData = (chunk) => {
      const text = chunk.toString('utf8');
      if (text === '\u0003') {
        cleanup();
        output.write('\n');
        reject(new Error('已取消。'));
      } else if (text === '\r' || text === '\n') {
        cleanup();
        output.write('\n');
        resolve(value);
      } else if (text === '\b' || text === '\u007f') {
        value = value.slice(0, -1);
      } else if (!/[\u0000-\u001f\u007f]/.test(text)) {
        value += text;
      }
    };
    input.on('data', onData);
  });
}

async function confirmLocally({ input = process.stdin, output = process.stdout } = {}) {
  const readline = createInterface({ input, output, terminal: true });
  try {
    const answer = await readline.question(`将仅导入两条固定 Phase 2B Candidate。输入 ${PHASE_2B_LOCAL_CONFIRMATION} 继续：`);
    if (answer !== PHASE_2B_LOCAL_CONFIRMATION) throw new Error('本地确认短语不匹配，未执行导入。');
  } finally {
    readline.close();
  }
}

function safeSummary(body) {
  return {
    execution: body.execution,
    allowlist_size: Number(body.allowlist_size || 0),
    source_id: body.source_id || null,
    collection_run_id: body.collection_run_id || null,
    snapshots_created: Number(body.snapshots_created || 0),
    candidates_created: Number(body.candidates_created || 0),
    candidates_skipped: Number(body.candidates_skipped || 0)
  };
}

/**
 * No command-line option can alter the production URL, request body, or
 * whitelist. The only credential is held in memory for this request.
 */
export async function executePhase2BProductionImport({ token, fetchImpl = fetch, endpoint = PHASE_2B_PRODUCTION_IMPORT_URL } = {}) {
  const authorizationToken = String(token || '').trim();
  if (!authorizationToken) throw new Error('管理员 Token 不能为空。');
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${authorizationToken}`,
        'content-type': 'application/json',
        'cache-control': 'no-store'
      },
      body: JSON.stringify({ apply: true, confirmation: SERVER_CONFIRMATION })
    });
  } catch (error) {
    throw new Phase2BNetworkRequestError(createSafeNetworkDiagnostic(error, authorizationToken));
  }
  let body = null;
  try { body = await response.json(); } catch { /* Never print raw response content. */ }
  if (!response.ok || !body) throw new Error(`导入未完成（HTTP ${response.status}）。`);
  if (!['completed', 'already_completed', 'in_progress'].includes(body.execution)) throw new Error('导入接口返回无效执行状态。');
  return safeSummary(body);
}

export async function runProductionImportCli({ argumentsList = process.argv.slice(2), environment = process.env, input = process.stdin, output = process.stdout, fetchImpl = fetch } = {}) {
  const options = parseArguments(argumentsList);
  let token = options.tokenSource === 'environment'
    ? String(environment.NETLIFY_TAXKB_ADMIN_TOKEN || '')
    : await readHiddenSecret({ input, output });
  try {
    await confirmLocally({ input, output });
    const result = await executePhase2BProductionImport({ token, fetchImpl });
    output.write(`执行状态：${result.execution}；新增 Snapshot：${result.snapshots_created}；新增 Candidate：${result.candidates_created}。\n`);
    return result;
  } finally {
    // JavaScript cannot guarantee memory zeroization, but this process does
    // not persist, log, or export the credential and drops its reference now.
    token = '';
  }
}

const isDirectExecution = process.argv[1] && new URL(`file:${process.argv[1].replace(/\\/g, '/')}`).href === import.meta.url;
if (isDirectExecution) {
  runProductionImportCli().catch((error) => {
    // Never include a response body, request headers, or Token in terminal output.
    if (error instanceof Phase2BNetworkRequestError) {
      process.stderr.write(`${JSON.stringify(error.diagnostic)}\n`);
    } else {
      process.stderr.write(`${error.message}\n`);
    }
    process.exitCode = 1;
  });
}
