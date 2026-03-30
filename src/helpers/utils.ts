import { BigInt } from "@graphprotocol/graph-ts";

/**
 * Convert tick to price
 * Price calculation logic based on your CLOB implementation
 * @param tick - Price tick from order book
 * @returns Price as BigInt
 */
export function tickToPrice(tick: BigInt): BigInt {
  // TODO: Implement tick to price conversion based on your formula
  // This is a placeholder - adjust based on your actual tick math
  return tick;
}

/**
 * Get day start timestamp for daily snapshots
 * @param timestamp - Current timestamp
 * @returns Day start timestamp
 */
export function getDayStartTimestamp(timestamp: BigInt): BigInt {
  let daySeconds = BigInt.fromI32(86400); // 24 * 60 * 60
  return timestamp.minus(timestamp.mod(daySeconds));
}

/**
 * Generate unique ID for entities
 * @param parts - Array of strings to concatenate
 * @returns Unique ID string
 */
export function generateId(parts: string[]): string {
  return parts.join("-");
}
