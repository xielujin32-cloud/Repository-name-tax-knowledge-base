import { dryRunChinaTaxPolicyPilot } from '../src/chinatax-evidence-collection.js';

// Local, read-only first-batch discovery. It performs GET requests only to
// fixed State Taxation Administration policy-library URLs and never opens a
// database or Netlify Blob store.
const result = await dryRunChinaTaxPolicyPilot();
console.log(JSON.stringify(result, null, 2));
