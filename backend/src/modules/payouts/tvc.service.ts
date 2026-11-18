/**
 * TVC (Time-Value Contribution) service.
 *
 * Rewards late collectors and penalizes early collectors to reflect the time
 * value of money. The circle midpoint has zero adjustment.
 *
 * Formula:
 *   monthly_rate = annual_rate_bps / 10000 / 12
 *   adjustment   = gross_pot * monthly_rate * (position - 6.5)
 *
 * Where position = the slot number (1-12), which is also the collection cycle.
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
 * @param position         The slot number (1-12) — also the cycle number
 * @param tvcAnnualBps     The annual TVC rate in basis points (e.g. 200 = 2% p.a.)
 */
export function calculateTvc(
  grossPotPence: bigint,
  position: number,
  tvcAnnualBps: number,
): TvcCalculation {
  if (position < 1 || position > env.CIRCLE_SIZE) {
    throw new Error(`Invalid position: ${position}. Must be 1-${env.CIRCLE_SIZE}.`);
  }

  // Monthly rate = annual BPS / 10000 / 12
  // We work in BPS * 100 to preserve integer math:
  //   adjustmentPence = grossPotPence * tvcAnnualBps * (position - 6.5) / (10000 * 12)
  //
  // (position - 6.5) is x.5, so we double it to keep integers:
  //   adjustmentPence = grossPotPence * tvcAnnualBps * (2*position - 13) / (10000 * 24)

  const doubleOffset = 2 * position - (env.CIRCLE_SIZE + 1); // centred on the configured circle midpoint
  const numerator = grossPotPence * BigInt(tvcAnnualBps) * BigInt(doubleOffset);
  const denominator = BigInt(10000 * 24); // annual rate converted to a monthly rate

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