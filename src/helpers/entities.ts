import { Address, BigInt, Bytes } from "@graphprotocol/graph-ts";
import { User, Protocol, Venue, Market, MarketGroup, TraderPosition } from '../../generated/schema';

const ZERO = BigInt.fromI32(0);
const ONE = BigInt.fromI32(1);
const SCALE = BigInt.fromString('1000000000000000000'); // 1e18

/**
 * Get or create a User entity
 * @param address - User address
 * @param timestamp - Current block timestamp
 * @returns User entity
 */
export function getOrCreateUser(address: Address, timestamp: BigInt): User {
  let id = address.toHexString();
  let user = User.load(id);

  if (user == null) {
    user = new User(id);
    user.address = address;
    user.totalOrdersPlaced = ZERO;
    user.totalVolume = ZERO;
    user.totalMarkets = ZERO;
    user.totalMarketGroups = ZERO;
    user.totalTradeCount = ZERO;
    user.totalMarketsTraded = ZERO;
    user.totalRealizedPnL = ZERO;
    user.firstSeenAt = timestamp;
    user.lastSeenAt = timestamp;
    user.save();

    // Increment protocol user count
    let protocol = getOrCreateProtocol();
    protocol.totalUsers = protocol.totalUsers.plus(ONE);
    protocol.save();
  } else {
    user.lastSeenAt = timestamp;
    user.save();
  }

  return user;
}

/**
 * Get or create the Protocol singleton entity
 * @returns Protocol entity
 */
export function getOrCreateProtocol(): Protocol {
  let id = '1';
  let protocol = Protocol.load(id);

  if (protocol == null) {
    protocol = new Protocol(id);
    protocol.totalVenues = ZERO;
    protocol.totalMarkets = ZERO;
    protocol.totalMarketGroups = ZERO;
    protocol.totalVolume = ZERO;
    protocol.totalFees = ZERO;
    protocol.totalUsers = ZERO;
    protocol.updatedAt = ZERO;
    protocol.save();
  }

  return protocol;
}

/**
 * Update a trader's position for a market outcome after a fill.
 *
 * Uses weighted average cost basis:
 * - BUY: newAvgPrice = (oldCostBasis + newCost) / (oldQty + newQty)
 * - SELL: realizedPnL += saleProceeds - (avgEntryPrice * qty / 1e18)
 *
 * @param traderId - Trader address (hex string, used as User entity ID)
 * @param marketId - Market ID (string)
 * @param outcome - Outcome index (0=YES, 1=NO)
 * @param side - 'BUY' or 'SELL'
 * @param qty - Token quantity
 * @param collateralAmount - Collateral cost (buy) or proceeds (sell) in raw units
 * @param timestamp - Block timestamp
 */
export function updateTraderPosition(
  traderId: string,
  marketId: string,
  outcome: BigInt,
  side: string,
  qty: BigInt,
  collateralAmount: BigInt,
  timestamp: BigInt,
): void {
  let id = traderId + '-' + marketId + '-' + outcome.toString();
  let position = TraderPosition.load(id);

  if (position == null) {
    position = new TraderPosition(id);
    position.trader = traderId;
    position.market = marketId;
    // Denormalize venue from market
    let market = Market.load(marketId);
    position.venue = market != null ? market.venue : '';
    position.outcome = outcome;
    position.quantity = ZERO;
    position.totalCostBasis = ZERO;
    position.avgEntryPrice = ZERO;
    position.realizedPnL = ZERO;
    position.totalCollateralIn = ZERO;
    position.totalCollateralOut = ZERO;
    position.buyCount = ZERO;
    position.sellCount = ZERO;
    position.firstTradeAt = timestamp;
    position.lastTradeAt = timestamp;
  }

  if (side == 'BUY') {
    // Buying: increase position, update weighted average cost
    let newTotalCost = position.totalCostBasis.plus(collateralAmount);
    let newQty = position.quantity.plus(qty);

    position.totalCostBasis = newTotalCost;
    position.quantity = newQty;
    position.totalCollateralIn = position.totalCollateralIn.plus(collateralAmount);
    position.buyCount = position.buyCount.plus(ONE);

    // Weighted average entry price: totalCostBasis * 1e18 / quantity
    if (newQty.gt(ZERO)) {
      position.avgEntryPrice = newTotalCost.times(SCALE).div(newQty);
    }
  } else {
    // Selling: decrease position, realize P&L
    // Cost basis of tokens sold = avgEntryPrice * qty / 1e18
    let costBasisSold = position.avgEntryPrice.times(qty).div(SCALE);
    // Realized P&L = sale proceeds - cost basis
    let pnl = collateralAmount.minus(costBasisSold);

    position.realizedPnL = position.realizedPnL.plus(pnl);
    position.totalCollateralOut = position.totalCollateralOut.plus(collateralAmount);
    position.sellCount = position.sellCount.plus(ONE);

    // Reduce position
    let newQty = position.quantity.minus(qty);
    if (newQty.le(ZERO)) {
      position.quantity = ZERO;
      position.totalCostBasis = ZERO;
    } else {
      position.quantity = newQty;
      // Reduce cost basis proportionally
      position.totalCostBasis = position.totalCostBasis.minus(costBasisSold);
    }

    // Update user's realized P&L aggregate
    let user = User.load(traderId);
    if (user != null) {
      user.totalRealizedPnL = user.totalRealizedPnL.plus(pnl);
      user.save();
    }
  }

  position.lastTradeAt = timestamp;
  position.save();
}

/**
 * Zero out a trader's positions for a market after CTF redemption.
 * Called when PayoutRedemption event fires on the CTF contract.
 *
 * For each outcome position the trader holds:
 * - Realized P&L -= costBasis (the cost of those tokens is now realized as a loss)
 * Then the total payout is added to the user's aggregate realized P&L.
 * Net effect for winning side: realizedPnL += (payout - costBasis)
 * Net effect for losing side: realizedPnL -= costBasis (payout contribution = 0)
 *
 * @param traderId - Trader address (hex string)
 * @param marketId - Market ID (string)
 * @param payout - Total collateral redeemed from CTF
 * @param timestamp - Block timestamp
 */
export function redeemTraderPosition(
  traderId: string,
  marketId: string,
  payout: BigInt,
  timestamp: BigInt,
): void {
  let totalCostBasisCleared = ZERO;

  // Zero out both outcome positions (0=YES, 1=NO)
  for (let i = 0; i < 2; i++) {
    let outcome = BigInt.fromI32(i);
    let id = traderId + '-' + marketId + '-' + outcome.toString();
    let position = TraderPosition.load(id);

    if (position != null && position.quantity.gt(ZERO)) {
      let costBasis = position.totalCostBasis;
      totalCostBasisCleared = totalCostBasisCleared.plus(costBasis);

      // Realize loss of costBasis on this position
      position.realizedPnL = position.realizedPnL.minus(costBasis);
      position.totalCollateralOut = position.totalCollateralOut.plus(
        // Attribute payout proportionally? No — we only know total payout.
        // For the losing outcome, payout = 0. For winning, payout = full amount.
        // Since we can't split, just track total on collateralOut at position level
        // by attributing the full payout to outcome 0 position if it exists.
        // Actually, simpler: just don't update collateralOut per-position here.
        // The important fields are quantity, costBasis, and realizedPnL.
        ZERO
      );
      position.quantity = ZERO;
      position.totalCostBasis = ZERO;
      position.lastTradeAt = timestamp;
      position.save();
    }
  }

  // Add payout as realized P&L on the user aggregate
  // Combined with the costBasis subtractions above, net effect:
  // user.totalRealizedPnL += (payout - totalCostBasisCleared)
  let user = User.load(traderId);
  if (user != null) {
    user.totalRealizedPnL = user.totalRealizedPnL.minus(totalCostBasisCleared).plus(payout);
    user.save();
  }
}
