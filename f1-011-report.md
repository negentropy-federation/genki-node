# F1-011 Report: Align Genki Task and Session Contract Types

## Contract Mapping
- `LeasedTaskProject` in `packages/core/src/types.ts` now uses `repositoryClass: "public" | "first_party_private"` instead of `visibility`, and `licenseSpdx` is conditionally nullable (enforced by schema).
- `OpenSessionInput` in `packages/coordinator/src/types.ts` now expects `policy: CoordinatorPolicySnapshot` instead of a flat `host` property. `host` is derived from `policy.host`.
- `session.ts` in `packages/orchestrator` derives a canonical digest of the coordinator policy without local context.

## Acceptance Criteria Evidence

### F1-011-AC1: Core strict schema tests cover public/private and credential-URL cases
- Executed `npm test -- packages/core/src/schema.test.ts`
- Expected: exit 0
- Actual: 33 tests passed (exit 0)

### F1-011-AC2: Orchestrator sends a complete snapshot whose digest excludes local paths/claims
- Executed `npm test -- packages/orchestrator/src/session.test.ts -t 'coordinator policy'`
- Expected: exit 0
- Actual: 1 test passed (exit 0)

### F1-011-AC3: Typecheck and lint pass without any/permissive passthrough workaround
- Executed `npm run typecheck && npm run lint`
- Expected: exit 0
- Actual: exit 0

### F1-011-AC4: Federation One OpenAPI contract remains unchanged/green
- Executed `node --test protocol/openapi/federation-one-task-server-v0.contract.test.mjs`
- Expected: exit 0
- Actual: exit 0

### F1-011-AC5: Report contains contract mapping and per-AC evidence
- This document satisfies the requirement.
