-- =============================================================================
-- 027_sandbox_derived_tvc_rate.sql
-- Allow the sandbox's mathematically derived annual TVC rate.
--
-- The sandbox derives the rate from the contribution amount, circle size,
-- and cycle interval so the endpoint adjustment remains 50% of one
-- contribution. The resulting annualised basis-point rate can legitimately
-- exceed 10,000 (100%).
--
-- Keep the non-negative requirement, but do not impose an arbitrary
-- percentage ceiling on a derived rate.
-- =============================================================================

ALTER TABLE tenants
  DROP CONSTRAINT IF EXISTS tenants_current_tenure_tvc_bps_check;

ALTER TABLE tenants
  ADD CONSTRAINT tenants_current_tenure_tvc_bps_check
  CHECK (current_tenure_tvc_bps >= 0);
