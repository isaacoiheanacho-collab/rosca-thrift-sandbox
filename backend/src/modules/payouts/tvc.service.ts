/**
 * TVC (Time-Value Contribution) service.
 *
 * Rewards earlier collection positions and applies the corresponding negative
 * adjustment to later positions. The circle midpoint has zero adjustment.
 *
 * Formula:
 *   cycle_rate = annual_rate_bps / 10000 / 52 (weekly cycle)
 *   adjustment   = gross_pot * weekly_rate * (circle_midpoint - position)
 *
 * Where position is the slot number and collection cycle; each cycle is one week.
 */

import { env } from '../../config/env';

export interface TvcCalculation {
  grossPot: bigint;
  adjustment: bigint;  // signed, pence
  potAfterTvc: bigint; // gross + adjustment
  rateBps: number;
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

  const doubleOffset = (env.CIRCLE_SIZE + 1) - 2 * position; // positive before midpoint, negative after
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