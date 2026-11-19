/**
 * TVC (Time-Value Contribution) service.
 *
 * Rewards earlier collection positions and applies the corresponding negative
 * adjustment to later positions. The circle midpoint has zero adjustment.
 *
 * Formula:
 *   weekly adjustment = gross_pot * annual_rate * (2 * position - (circle_size + 1)) / (10000 * 104)
 *
 * The annual rate is derived at tenure activation so the first/last slot
 * adjustment equals -/+ 50% of one member's contribution.
 */

import { env } from '../../config/env';

export interface TvcCalculation {
  grossPot: bigint;
  adjustment: bigint;  // signed, pence
  potAfterTvc: bigint; // gross + adjustment
  rateBps: number;
}

/**
 * Derive the annual TVC rate (basis points) required to make the first and
 * final collection positions equal to -/+ 50% of one member's contribution.
 *
 * For a weekly circle:
 *   endpoint adjustment = gross * annualRate * (circleSize - 1) / 104
 *   target adjustment   = contribution / 2
 *
 * The result is rounded to the nearest basis point. With equal contributions,
 * contribution size cancels algebraically, but it is deliberately included in
 * the derivation so the rate is tied to the actual contribution and circle.
 */
export function deriveTvcAnnualBps(
  contributionPence: bigint,
  circleSize: number,
): number {
  if (contributionPence <= 0n) {
    throw new Error('Contribution must be greater than zero.');
  }
  if (!Number.isInteger(circleSize) || circleSize < 2) {
    throw new Error('Circle size must be an integer of at least 2.');
  }

  const grossPotPence = contributionPence * BigInt(circleSize);
  const numerator = contributionPence * 10000n * 104n;
  const denominator = 2n * grossPotPence * BigInt(circleSize - 1);
  const rounded = (numerator + denominator / 2n) / denominator;
  const rateBps = Number(rounded);

  if (!Number.isSafeInteger(rateBps) || rateBps <= 0) {
    throw new Error('Derived TVC rate is outside the supported range.');
  }

  return rateBps;
}

/**
 * Calculate TVC for one payout.
 *
 * @param grossPotPence    The gross pool (e.g. £12,000 = 1_200_000n pence)
 * @param position         The slot number (1-CIRCLE_SIZE) — also the weekly cycle number
 * @param tvcAnnualBps     The annual TVC rate in basis points (e.g. 909 = 9.09% p.a.)
 */
export function calculateTvc(
  grossPotPence: bigint,
  position: number,
  tvcAnnualBps: number,
): TvcCalculation {
  if (position < 1 || position > env.CIRCLE_SIZE) {
    throw new Error(`Invalid position: ${position}. Must be 1-${env.CIRCLE_SIZE}.`);
  }

  // Each collection cycle is one week, so convert the annual rate to a weekly rate.
  // Double the centred slot offset to preserve integer arithmetic:
  //   adjustmentPence = grossPotPence * tvcAnnualBps * (2*position - (CIRCLE_SIZE + 1)) / (10000 * 104)
  // Early positions are negative; later positions are positive.

  const doubleOffset = 2 * position - (env.CIRCLE_SIZE + 1);
  const numerator = grossPotPence * BigInt(tvcAnnualBps) * BigInt(doubleOffset);
  const denominator = BigInt(10000 * 104); // annual rate converted to a weekly rate

  // Round half-up: add (denominator / 2) for positive, subtract for negative
  const half = denominator / 2n;
  const rounded = numerator >= 0n ? (numerator + half) / denominator : (numerator - half) / denominator;

  const adjustment = rounded;
  const potAfterTvc = grossPotPence + adjustment;

  return {
    grossPot: grossPotPence,
    adjustment,
    potAfterTvc,
    rateBps: tvcAnnualBps,
  };
}

/**
 * Calculate the platform fee on the post-TVC pot.
 *
 *   feePence = potAfterTvcPence * feeBps / 10000
 *   netPence = potAfterTvcPence - feePence
 */
export function calculateFee(
  potAfterTvcPence: bigint,
  feeBps: number,
): { fee: bigint; net: bigint; rateBps: number } {
  const numerator = potAfterTvcPence * BigInt(feeBps);
  const denominator = 10000n;
  const half = denominator / 2n;
  const fee = (numerator + half) / denominator;
  const net = potAfterTvcPence - fee;

  return { fee, net, rateBps: feeBps };
}