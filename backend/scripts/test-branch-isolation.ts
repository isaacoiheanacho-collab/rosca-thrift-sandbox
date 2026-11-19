import 'dotenv/config';

/**
 * Sandbox branch isolation integration test.
 *
 * Exercises the real partner self-registration path (not Super Admin's
 * platform-only manual branch creation route), then provisions two separate
 * five-saver trial branches. It also verifies that a completed trial branch
 * rejects a sixth saver without blocking the other branch.
 *
 * Run against a disposable sandbox DB:
 *   yarn test:branch-isolation
 *
 * Required environment:
 *   SUPER_ADMIN_PHONE, TEST_SUPER_PASSWORD, DEV_OTP_OVERRIDE=000000
 */

const BASE = process.env.SMOKE_BASE ?? 'http://localhost:4005';
const SUPER_PHONE = process.env.SUPER_ADMIN_PHONE;
const SUPER_PASSWORD = process.env.TEST_SUPER_PASSWORD;
const DEV_OTP = process.env.DEV_OTP_OVERRIDE;

interface ApiResponse {
  ok?: boolean;
  data?: any;
  error?: { code?: string; message?: string };
}

async function api(
  method: string,
  path: string,
  opts: { body?: unknown; token?: string } = {},
): Promise<{ status: number; json: ApiResponse }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let json: ApiResponse;
  try {
    json = (await res.json()) as ApiResponse;
  } catch {
    json = {};
  }
  return { status: res.status, json };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  assert(SUPER_PHONE, 'SUPER_ADMIN_PHONE is required');
  assert(SUPER_PASSWORD, 'TEST_SUPER_PASSWORD is required');
  assert(DEV_OTP, 'DEV_OTP_OVERRIDE is required (use 000000 only in local test mode)');

  const stamp = Date.now();
  const superLogin = await api('POST', '/api/auth/login', {
    body: { phone: SUPER_PHONE, password: SUPER_PASSWORD },
  });
  assert(superLogin.status === 200 && superLogin.json.ok, 'Super Admin login failed');
  const superToken = superLogin.json.data.tokens.accessToken;

  const branches: Array<{ id: string; slug: string }> = [];

  // Register two independent community partners through public onboarding.
  for (let branchIndex = 1; branchIndex <= 2; branchIndex++) {
    const slug = `trial-partner-${stamp}-${branchIndex}`;
    const adminPhone = `+447700${String(stamp).slice(-6)}${String(branchIndex).padStart(2, '0')}`;

    const onboard = await api('POST', '/api/branches/onboard', {
      body: {
        branch: {
          slug,
          name: `Trial Partner ${branchIndex} ${stamp}`,
          contactEmail: `trial-partner-${stamp}-${branchIndex}@example.test`,
        },
        admin: {
          fullName: `Trial Partner Admin ${branchIndex}`,
          phone: adminPhone,
          password: 'PartnerPass1#',
        },
        consents: {
          terms: { accepted: true, version: '1.0.0' },
          privacy: { accepted: true, version: '1.0.0' },
        },
      },
    });
    assert(onboard.status === 201 && onboard.json.ok, `Partner ${branchIndex} onboarding failed: ${JSON.stringify(onboard.json)}`);

    const branchId = onboard.json.data.branchId as string;

    // Verify the partner's phone. BRANCH_ADMIN must not be provisioned as a saver.
    const adminVerify = await api('POST', '/api/auth/verify-phone', {
      body: { phone: adminPhone, code: DEV_OTP },
    });
    assert(adminVerify.status === 200 && adminVerify.json.ok, `Partner ${branchIndex} phone verification failed`);
    assert(adminVerify.json.data.user.role === 'BRANCH_ADMIN', 'Partner registration did not create BRANCH_ADMIN');

    const approve = await api('PATCH', `/api/super-admin/branches/${branchId}/onboarding/approve`, {
      token: superToken,
    });
    assert(approve.status === 200 && approve.json.ok, `Super Admin could not approve partner branch ${branchIndex}`);

    branches.push({ id: branchId, slug });
  }

  // Fill each branch independently with five phone-verified savers.
  let saverNumber = 0;

  for (const branch of branches) {
    for (let slot = 1; slot <= 5; slot++) {
      saverNumber += 1;
      const phone = `+447701${String(stamp).slice(-6)}${String(saverNumber).padStart(2, '0')}`;

      const register = await api('POST', '/api/auth/register', {
        body: {
          phone,
          password: 'SaverPass1#',
          fullName: `Isolation Saver ${saverNumber}`,
          branchSlug: branch.slug,
          consents: {
            terms: { accepted: true, version: '1.0.0' },
            privacy: { accepted: true, version: '1.0.0' },
          },
        },
      });
      assert(register.status === 201 && register.json.ok, `Saver ${saverNumber} registration failed: ${JSON.stringify(register.json)}`);

      const verify = await api('POST', '/api/auth/verify-phone', {
        body: { phone, code: DEV_OTP },
      });
      assert(verify.status === 200 && verify.json.ok, `Saver ${saverNumber} phone verification failed`);
      assert(verify.json.data.user.role === 'SAVER', 'Saver registration returned the wrong role');

    }

    const tenants = await api('GET', `/api/super-admin/tenants/by-branch/${branch.id}`, {
      token: superToken,
    });
    assert(tenants.status === 200 && tenants.json.ok, `Could not list tenants for ${branch.slug}`);
    assert(tenants.json.data.tenants.length === 1, `${branch.slug} should have exactly one tenant`);
    assert(tenants.json.data.tenants[0].status === 'ACTIVE', `${branch.slug} tenant should be ACTIVE`);
    assert(tenants.json.data.tenants[0].memberCount === 5, `${branch.slug} tenant should contain exactly five savers`);
  }

  // Register an additional saver against the first, already-completed trial branch.
  const completedBranch = branches[0]!;
  const sixthPhone = `+447702${String(stamp).slice(-6)}99`;
  const sixthRegister = await api('POST', '/api/auth/register', {
    body: {
      phone: sixthPhone,
      password: 'SaverPass1#',
      fullName: 'Sixth Trial Saver',
      branchSlug: completedBranch.slug,
      consents: {
        terms: { accepted: true, version: '1.0.0' },
        privacy: { accepted: true, version: '1.0.0' },
      },
    },
  });
  assert(sixthRegister.status === 201 && sixthRegister.json.ok, 'Sixth saver should be able to create an account before provisioning is attempted');

  const sixthVerify = await api('POST', '/api/auth/verify-phone', {
    body: { phone: sixthPhone, code: DEV_OTP },
  });
  assert(sixthVerify.status === 200 && sixthVerify.json.ok, 'Phone verification should not be blocked by a provisioning rejection');

  const sixthProvision = await api(
    'POST',
    `/api/super-admin/tenants/provision/${sixthRegister.json.data.userId}`,
    { token: superToken },
  );
  assert(
    sixthProvision.status === 409 && sixthProvision.json.error?.code === 'SANDBOX_BRANCH_TRIAL_COMPLETED',
    `Sixth saver should be rejected with SANDBOX_BRANCH_TRIAL_COMPLETED, got ${JSON.stringify(sixthProvision.json)}`,
  );

  // Confirm the second partner's completed tenant remains independent and intact.
  const secondBranchCheck = await api('GET', `/api/super-admin/tenants/by-branch/${branches[1]!.id}`, {
    token: superToken,
  });
  assert(secondBranchCheck.status === 200 && secondBranchCheck.json.data.tenants.length === 1, 'Second partner branch was affected by first branch completion');

  console.log('PASS: two community partners onboard independently');
  console.log('PASS: each branch has exactly one active five-saver tenant');
  console.log('PASS: sixth saver cannot enter a completed trial branch');
  console.log('PASS: completing one branch does not restrict another branch');
}

main().catch((error) => {
  console.error('FAIL: sandbox branch isolation test', error);
  process.exit(1);
});
