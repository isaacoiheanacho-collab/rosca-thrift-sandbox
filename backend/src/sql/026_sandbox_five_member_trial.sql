-- =============================================================================
-- 026_sandbox_five_member_trial.sql
-- Sandbox-only limits: five saver slots and five cycles.
-- This migration is intentionally confined to the sandbox database/repository.
-- =============================================================================

DO $$
DECLARE
  item RECORD;
  definition TEXT;
  replacement TEXT;
BEGIN
  FOR item IN
    SELECT c.conname, t.relname AS table_name, pg_get_constraintdef(c.oid) AS definition
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'c'
      AND n.nspname = 'public'
      AND t.relname IN (
        'tenants',
        'tenant_memberships',
        'contribution_intents',
        'contributions',
        'payout_intents',
        'platform_fee_intents',
        'tenure_renewals'
      )
      AND pg_get_constraintdef(c.oid) ~ '12'
  LOOP
    definition := item.definition;
    replacement := regexp_replace(definition, '\m12\M', '5', 'g');
    IF replacement <> definition THEN
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', item.table_name, item.conname);
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (%s)',
        item.table_name, item.conname, substring(replacement FROM 7));
    END IF;
  END LOOP;
END $$;

-- Prevent a second trial circle from being created for the same branch.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sandbox_one_tenant_per_branch
  ON tenants (branch_id);
