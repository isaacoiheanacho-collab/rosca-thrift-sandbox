/**
 * Sandbox saver provisioning.
 *
 * A branch can have exactly one trial tenant. That tenant has five saver
 * positions and completes after five weekly cycles. A completed or otherwise
 * non-filling tenant permanently consumes the branch's trial tenant position.
 *
 * Provisioning is serialized on the branch row so simultaneous saver
 * verifications cannot create competing tenants or allocate the same slot.
 */

import { withTransaction } from '../../db';
import { env } from '../../config/env';
import { logger } from '../../logger';
import { ConflictError, NotFoundError } from '../../errors';
import { record } from '../audit/audit.service';
import { usersRepository } from '../users/users.repository';
import { type TenantRow } from './tenants.repository';
import { deriveTvcAnnualBps } from '../payouts/tvc.service';

export interface ProvisionResult {
  tenantId: string;
  slotNumber: number;
  tenantActivated: boolean;
  createdNewTenant: boolean;
  alreadyProvisioned: boolean;
}

function pickRandomFreeSlot(used: number[]): number | null {
  const free = Array.from({ length: env.CIRCLE_SIZE }, (_, i) => i + 1).filter((n) => !used.includes(n));
  if (free.length === 0) return null;
  return free[Math.floor(Math.random() * free.length)]!;
}

export class ProvisioningService {
  async provisionUserToTenant(userId: string, branchId: string): Promise<ProvisionResult> {
    const user = await usersRepository.findById(userId);

    // Branch administrators and platform Super Admins never join saver circles.
    if (!user || user.role !== 'SAVER') {
      logger.debug({ userId, role: user?.role }, 'Skipping tenant provisioning for non-saver');
      return {
        tenantId: '',
        slotNumber: 0,
        tenantActivated: false,
        createdNewTenant: false,
        alreadyProvisioned: true,
      };
    }

    if (user.branch_id !== branchId) {
      throw new ConflictError(
        'Saver does not belong to the branch being provisioned',
        'PROVISION_BRANCH_MISMATCH',
      );
    }

    const result = await withTransaction(async (tx) => {
      // This row lock serializes every provisioning attempt within this branch,
      // while leaving other partners' branches independent.
      const branchRes = await tx.query<{ id: string }>(
        'SELECT id FROM branches WHERE id = $1 FOR UPDATE',
        [branchId],
      );
      if (!branchRes.rows[0]) throw new NotFoundError('Branch');

      // Re-check idempotency after acquiring the branch lock. A parallel request
      // for this same saver may have completed while this request was waiting.
      const existingMembership = await tx.query<{ tenant_id: string; slot_number: number }>(
        `SELECT tenant_id, slot_number
         FROM tenant_memberships
         WHERE user_id = $1 AND status != 'REMOVED'
         ORDER BY joined_at DESC
         LIMIT 1`,
        [userId],
      );

      if (existingMembership.rows[0]) {
        return {
          tenantId: existingMembership.rows[0].tenant_id,
          slotNumber: existingMembership.rows[0].slot_number,
          tenantActivated: false,
          createdNewTenant: false,
          alreadyProvisioned: true,
        };
      }

      let tenantRes = await tx.query<TenantRow>(
        `SELECT * FROM tenants
         WHERE branch_id = $1 AND status = 'FILLING'
         ORDER BY created_at ASC
         LIMIT 1
         FOR UPDATE`,
        [branchId],
      );
      let tenant = tenantRes.rows[0] ?? null;
      let createdNewTenant = false;

      if (!tenant) {
        const countRes = await tx.query<{ count: string }>(
          'SELECT COUNT(*)::text AS count FROM tenants WHERE branch_id = $1',
          [branchId],
        );
        const tenantCount = Number(countRes.rows[0]?.count ?? '0');

        if (tenantCount >= 1) {
          throw new ConflictError(
            'This sandbox branch has completed or used its one trial tenant. No further saver enrolment is available.',
            'SANDBOX_BRANCH_TRIAL_COMPLETED',
          );
        }

        const tenantName = 'Tenant 01';
        tenantRes = await tx.query<TenantRow>(
          `INSERT INTO tenants (branch_id, name, status)
           VALUES ($1, $2, 'FILLING')
           RETURNING *`,
          [branchId, tenantName],
        );
        tenant = tenantRes.rows[0]!;
        createdNewTenant = true;

        await record({
          actorId: null,
          action: 'TENANT_CREATED',
          entityType: 'tenant',
          entityId: tenant.id,
          metadata: { branchId, reason: 'auto-provisioning', tenantName },
        }, tx);
      }

      // Lock the tenant row before inspecting free positions. The branch lock
      // already serializes this workflow; this row lock also protects the
      // tenant's membership allocation against other tenant-scoped writers.
      const lockedTenantRes = await tx.query<TenantRow>(
        'SELECT * FROM tenants WHERE id = $1 FOR UPDATE',
        [tenant.id],
      );
      tenant = lockedTenantRes.rows[0]!;
      if (tenant.status !== 'FILLING') {
        throw new ConflictError(
          'This sandbox trial tenant is no longer accepting savers',
          'SANDBOX_TENANT_NOT_OPEN',
        );
      }

      const usedSlotsRes = await tx.query<{ slot_number: number }>(
        `SELECT slot_number FROM tenant_memberships
         WHERE tenant_id = $1 AND status != 'REMOVED'`,
        [tenant.id],
      );
      const used = usedSlotsRes.rows.map((row) => row.slot_number);
      const slot = pickRandomFreeSlot(used);

      if (slot === null) {
        throw new ConflictError(
          'The five saver positions in this sandbox tenant are already full',
          'SANDBOX_TENANT_FULL',
        );
      }

      const membershipRes = await tx.query<{ id: string; slot_number: number }>(
        `INSERT INTO tenant_memberships (tenant_id, user_id, slot_number)
         VALUES ($1, $2, $3)
         RETURNING id, slot_number`,
        [tenant.id, userId, slot],
      );
      const membership = membershipRes.rows[0]!;

      const memberCountRes = await tx.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM tenant_memberships
         WHERE tenant_id = $1 AND status != 'REMOVED'`,
        [tenant.id],
      );
      const memberCount = Number(memberCountRes.rows[0]?.count ?? '0');

      let activated = false;
      let tvcAnnualBps: number | null = null;

      if (memberCount === env.CIRCLE_SIZE) {
        tvcAnnualBps = deriveTvcAnnualBps(
          BigInt(env.CONTRIBUTION_PENCE),
          env.CIRCLE_SIZE,
        );

        await tx.query(
          `UPDATE tenants
           SET status = 'ACTIVE',
               activated_at = NOW(),
               current_tenure = 1,
               current_cycle = 1,
               cycle_started_at = NOW(),
               cycle_ends_at = NOW() + INTERVAL '7 days',
               cycle_contribution_deadline_at = NOW() + INTERVAL '5 days',
               cycle_payout_at = NOW() + INTERVAL '7 days',
               current_tenure_fee_bps = $2,
               current_tenure_tvc_bps = $3,
               tenure_started_at = NOW()
           WHERE id = $1 AND status = 'FILLING'`,
          [tenant.id, env.PLATFORM_FEE_BPS, tvcAnnualBps],
        );
        activated = true;
      }

      await record({
        actorId: null,
        action: 'TENANT_MEMBER_ASSIGNED',
        entityType: 'tenant_membership',
        entityId: membership.id,
        metadata: { tenantId: tenant.id, userId, slotNumber: slot },
      }, tx);

      if (activated) {
        await record({
          actorId: null,
          action: 'TENANT_ACTIVATED',
          entityType: 'tenant',
          entityId: tenant.id,
          metadata: {
            memberCount,
            feeBps: env.PLATFORM_FEE_BPS,
            tvcBps: tvcAnnualBps,
          },
        }, tx);
      }

      return {
        tenantId: tenant.id,
        slotNumber: slot,
        tenantActivated: activated,
        createdNewTenant,
        alreadyProvisioned: false,
      };
    });

    logger.info(
      { userId, branchId, ...result },
      result.alreadyProvisioned ? 'Saver already provisioned' : 'Saver provisioned to sandbox tenant',
    );

    return result;
  }
}

export const provisioningService = new ProvisioningService();
