import seed from '../data/policy-seed.json' with { type: 'json' };

const POLICY_SEED_COUNT = 3;

export function policySeedPolicies() {
  if (!Array.isArray(seed?.policies) || seed.policies.length !== POLICY_SEED_COUNT) {
    throw new Error(`政策种子必须且只能包含 ${POLICY_SEED_COUNT} 条政策。`);
  }
  return JSON.parse(JSON.stringify(seed.policies));
}
