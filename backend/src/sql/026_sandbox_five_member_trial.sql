-- =============================================================================
-- 026_sandbox_five_member_trial.sql
-- Sandbox-only five-member / five-cycle limits.
--
-- Existing 12-slot constraints are retained for historical rows. These
-- additional NOT VALID constraints are enforced for new and updated rows,
-- without requiring old sandbox test data to be rewritten or deleted.
-- =============================================================================

BEGIN;

ALTER TABLE tenants
  ADD CONSTRAINT tenants_sandbox_five_cycle_check
  CHECK (current_cycle BETWEEN 0 AND 5) NOT VALID;

ALTER TABLE tenant_memberships
  ADD CONSTRAINT tenant_memberships_sandbox_five_slot_check
  CHECK (slot_number BETWEEN 1 AND 5) NOT VALID;

ALTER TABLE contribution_intents
  ADD CONSTRAINT contribution_intents_sandbox_five_cycle_check
  CHECK (cycle BETWEEN 1 AND 5) NOT VALID,
  ADD CONSTRAINT contribution_intents_sandbox_five_slot_check
  CHECK (slot_number BETWEEN 1 AND 5) NOT VALID;

ALTER TABLE contributions
  ADD CONSTRAINT contributions_sandbox_five_cycle_check
  CHECK (cycle BETWEEN 1 AND 5) NOT VALID,
  ADD CONSTRAINT contributions_sandbox_five_slot_check
  CHECK (slot_number BETWEEN 1 AND 5) NOT VALID;

ALTER TABLE platform_fee_intents
  ADD CONSTRAINT platform_fee_intents_sandbox_five_cycle_check
  CHECK (cycle BETWEEN 1 AND 5) NOT VALID;

ALTER TABLE payout_intents
  ADD CONSTRAINT payout_intents_sandbox_five_cycle_check
  CHECK (cycle BETWEEN 1 AND 5) NOT VALID,
  ADD CONSTRAINT payout_intents_sandbox_five_recipient_slot_check
  CHECK (recipient_slot BETWEEN 1 AND 5) NOT VALID;

ALTER TABLE tenure_renewals
  ADD CONSTRAINT tenure_renewals_sandbox_five_slot_check
  CHECK (slot_number BETWEEN 1 AND 5) NOT VALID;

-- The live sandbox inspection confirmed no branch currently has multiple
-- tenants, so this index can safely enforce one circle per branch going
-- forward. Production uses a separate database and repository.
CREATE UNIQUE INDEX uq_sandbox_one_tenant_per_branch
  ON tenants (branch_id);

COMMIT;
