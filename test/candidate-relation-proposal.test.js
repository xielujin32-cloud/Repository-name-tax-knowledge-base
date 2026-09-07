import test from 'node:test';
import assert from 'node:assert/strict';
import { CANDIDATE_RELATION_RULE_VERSION, proposeCandidateRelations } from '../src/candidate-relation-proposal.js';

const target = '国家税务总局关于测试事项的公告';

test('关系线索只接受目标文件与明确关系动作的组合', () => {
  const repealed = proposeCandidateRelations({ normalized_text: `《${target}》同时废止。` });
  assert.equal(repealed.length, 1);
  assert.equal(repealed[0].relation_type, 'repeals');
  assert.equal(repealed[0].rule_version, CANDIDATE_RELATION_RULE_VERSION);

  const interpreted = proposeCandidateRelations({ normalized_text: `本通知是对《${target}》第三条的解释。` });
  assert.equal(interpreted.length, 1);
  assert.equal(interpreted[0].relation_type, 'interprets');

  const implemented = proposeCandidateRelations({ normalized_text: `为贯彻执行《${target}》，现制定本办法。` });
  assert.equal(implemented.length, 1);
  assert.equal(implemented[0].relation_type, 'implements');

  const followed = proposeCandidateRelations({ normalized_text: `按照《${target}》的规定执行。` });
  assert.equal(followed.length, 1);
  assert.equal(followed[0].relation_type, 'implements');
});

test('实施细则名称、停止执行重复词和普通根据引用不生成 relation proposal', () => {
  const body = [
    '根据《中华人民共和国增值税暂行条例实施细则》的规定，现公告如下。',
    `《${target}》停止执行。`,
    `根据《${target}》的规定办理。`
  ].join('\n');
  const proposals = proposeCandidateRelations({ normalized_text: body });
  assert.deepEqual(proposals.map((item) => item.relation_type), ['repeals']);
  assert.equal(proposals[0].evidence[0].matched_term, '停止执行');
});

test('关系动作之后出现另一目标文件时，不把第一引用文件错误配对', () => {
  const proposals = proposeCandidateRelations({ normalized_text: `根据《${target}》制定本清单，自今日起实施，《另一份历史公告》同日停止执行。` });
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].relation_type, 'repeals');
  assert.equal(proposals[0].target_reference.title, '另一份历史公告');
});
