/**
 * Octopus Protocol — Unified Diamond Mapping
 *
 * Single mapping file for the Diamond proxy. All events from all facets
 * are emitted from one address and handled here.
 *
 * Replaces the legacy three-file split (exchange.ts, controller.ts, uma-adapter.ts).
 */

import { BigInt, log, Bytes, Address } from '@graphprotocol/graph-ts';
import {
  VenueCreated,
  VenueUpdated,
  VenuePaused,
  VenueUnpaused,
  VenueFeesUpdated,
  VenueOracleParamsUpdated,
  MarketCreated,
  MarketGroupCreated,
  MarketAddedToGroup,
  PlaceholderMarketsAdded,
  PlaceholderActivated,
  MarketGroupActivated,
  OrderPlaced,
  OrderCancelled,
  OrderExpired,
  OrderDeleted,
  OrderFilled,
  MintFill,
  MergeFill,
  TradeExecuted,
  FeesDistributed,
  TopOfBookChanged,
  MarketOrderExecuted,
  MarketSellExecuted,
  AssertionCreated,
  AssertionSettled,
  AssertionDisputed,
  RewardPaid,
  MarketResolved,
  MarketGroupResolved,
  WrappedCollateralRegistered,
  VenueAccessControlUpdated,
  VenueMarketCreationFeeUpdated,
  AccessControlDeployed,
  MarketTradingAccessControlSet,
  MarketTradingAccessControlRemoved,
  MarketTagsUpdated,
  MarketGroupTagsUpdated,
  MarketMetadataUpdated,
  MarketGroupMetadataUpdated,
  PositionSplit,
  PositionsMerged,
  PriceMarketCreatedPyth,
  PriceMarketResolvedPyth,
  ProtocolFeeBpsUpdated,
  OrderAutoCancelled,
  OpenMaxStalenessUpdated,
  OddMaki,
} from '../generated/OddMaki/OddMaki';
import { ERC20 } from '../generated/OddMaki/ERC20';
import { PayoutRedemption } from '../generated/ConditionalTokens/ConditionalTokens';
import {
  Venue,
  Market,
  MarketGroup,
  MarketGroupItem,
  User,
  Order,
  Trade,
  Fill,
  TopOfBook as TopOfBookEntity,
  FeeEvent,
  Question,
  Assertion,
  MarketTrader,
  AccessControlContract,
  MarketAccessControl,
  ConditionMarket,
  PriceMarket,
  PriceMarketSerie,
  OpenMaxStalenessConfig,
  OpenMaxStalenessUpdate,
} from '../generated/schema';
import { getOrCreateUser, getOrCreateProtocol, updateTraderPosition, redeemTraderPosition } from './helpers/entities';
import { generateId } from './helpers/utils';

const SCALE = BigInt.fromString('1000000000000000000'); // 1e18

/**
 * Track unique traders per market. Creates a MarketTrader entity on first trade
 * and increments market.uniqueTraders. Returns true if this is a new trader.
 */
function trackUniqueTrader(
  market: Market,
  traderAddress: string,
  timestamp: BigInt,
): boolean {
  let id = market.id + '-' + traderAddress;
  let existing = MarketTrader.load(id);
  if (existing != null) return false;

  let mt = new MarketTrader(id);
  mt.market = market.id;
  mt.trader = traderAddress;
  mt.firstTradeAt = timestamp;
  mt.save();

  market.uniqueTraders = market.uniqueTraders.plus(BigInt.fromI32(1));

  // Increment user's distinct markets traded count
  let user = User.load(traderAddress);
  if (user != null) {
    user.totalMarketsTraded = user.totalMarketsTraded.plus(BigInt.fromI32(1));
    user.save();
  }

  return true;
}

/**
 * Decode bytes32[] tags to string[]. Trims trailing null bytes from each tag.
 */
function decodeTags(tags: Bytes[]): string[] {
  let result: string[] = [];
  for (let i = 0; i < tags.length; i++) {
    let raw = tags[i];
    // Find the last non-null byte to trim trailing zeros
    let end = raw.length;
    while (end > 0 && raw[end - 1] == 0) {
      end--;
    }
    if (end > 0) {
      let trimmed = new Uint8Array(end);
      for (let j = 0; j < end; j++) {
        trimmed[j] = raw[j];
      }
      result.push(String.UTF8.decode(trimmed.buffer));
    } else {
      result.push('');
    }
  }
  return result;
}

// ============================================
// Price Market Series helpers
// ============================================

const PRICE_MARKET_TAG = 'price-market';
const SERIES_TAG_PREFIX = 'series:';

/**
 * Extract the series key from a tag set. Returns the seriesKey (without prefix)
 * iff the tags contain both "price-market" and a "series:<key>" tag, else null.
 */
function extractSeriesKey(tags: string[]): string | null {
  let hasPriceMarketTag = false;
  let seriesKey: string | null = null;
  for (let i = 0; i < tags.length; i++) {
    let t = tags[i];
    if (t == PRICE_MARKET_TAG) {
      hasPriceMarketTag = true;
    } else if (t.length > SERIES_TAG_PREFIX.length && t.startsWith(SERIES_TAG_PREFIX)) {
      seriesKey = t.substr(SERIES_TAG_PREFIX.length);
    }
  }
  if (!hasPriceMarketTag) return null;
  return seriesKey;
}

/**
 * Parse interval string like "5m", "15m", "1h", "4h", "1d" to seconds.
 * Returns BigInt.zero() if unparseable.
 */
function parseIntervalToSeconds(interval: string): BigInt {
  if (interval.length < 2) return BigInt.zero();
  let unit = interval.charAt(interval.length - 1);
  let numStr = interval.substr(0, interval.length - 1);
  // Verify numStr is all digits before BigInt.fromString (which traps on garbage input).
  for (let i = 0; i < numStr.length; i++) {
    let c = numStr.charCodeAt(i);
    if (c < 48 || c > 57) return BigInt.zero();
  }
  let n = BigInt.fromString(numStr);
  if (unit == 'm') return n.times(BigInt.fromI32(60));
  if (unit == 'h') return n.times(BigInt.fromI32(3600));
  if (unit == 'd') return n.times(BigInt.fromI32(86400));
  if (unit == 's') return n;
  return BigInt.zero();
}

/**
 * Compose the entity id for a PriceMarketSerie — venue-scoped so the same
 * seriesKey on different venues is treated as independent series.
 */
function seriesEntityId(venueId: string, seriesKey: string): string {
  return venueId + '-' + seriesKey;
}

/**
 * Get or create a PriceMarketSerie entity, parsing seriesKey "<asset>-<kind>-<interval>".
 */
function getOrCreatePriceMarketSerie(
  venueId: string,
  seriesKey: string,
  timestamp: BigInt,
): PriceMarketSerie {
  let entityId = seriesEntityId(venueId, seriesKey);
  let series = PriceMarketSerie.load(entityId);
  if (series != null) return series;

  series = new PriceMarketSerie(entityId);
  series.seriesKey = seriesKey;
  series.venue = venueId;
  // Parse "asset-kind-interval" — split on '-', take first/second/last so multi-token
  // assets are still safe (e.g. "wbtc-updown-5m"). Anything weird becomes empty.
  let parts = seriesKey.split('-');
  if (parts.length >= 3) {
    series.asset = parts[0];
    series.kind = parts[1];
    series.interval = parts[parts.length - 1];
  } else {
    series.asset = '';
    series.kind = '';
    series.interval = '';
  }
  series.intervalSeconds = parseIntervalToSeconds(series.interval);
  series.status = 'Active';
  series.tags = [];
  series.marketIds = [];
  series.createdAt = timestamp;
  series.updatedAt = timestamp;
  series.save();
  return series;
}

/**
 * Find the next-to-resolve unresolved market in a series (smallest closeTime among
 * markets with status != Resolved/Invalid). Returns the market id or null.
 */
function findNextCurrentMarket(series: PriceMarketSerie): string | null {
  let bestId: string | null = null;
  let bestCloseTime: BigInt = BigInt.zero();
  let marketIds = series.marketIds;
  for (let i = 0; i < marketIds.length; i++) {
    let mId = marketIds[i];
    let m = Market.load(mId);
    if (m == null) continue;
    if (m.status == 'Resolved' || m.status == 'Invalid') continue;
    let pm = PriceMarket.load(mId);
    if (pm == null) continue;
    if (bestId == null || pm.closeTime.lt(bestCloseTime)) {
      bestId = mId;
      bestCloseTime = pm.closeTime;
    }
  }
  return bestId;
}

/**
 * Recompute series.currentMarket, series.tags, and series.status based on member markets.
 * Call after any change that could affect which market is current (creation, tag change,
 * resolution).
 */
function refreshSeriesCurrent(series: PriceMarketSerie, timestamp: BigInt): void {
  let nextId = findNextCurrentMarket(series);
  if (nextId == null) {
    series.currentMarket = null;
    series.status = 'Resolved';
    // Leave tags as-is — last current's tags are the most recent filterable set
  } else {
    let nextIdStr = nextId as string;
    series.currentMarket = nextIdStr;
    series.status = 'Active';
    let current = Market.load(nextIdStr);
    if (current != null) series.tags = current.tags;
  }
  series.updatedAt = timestamp;
  series.save();
}

/**
 * Reconcile a market's membership in a PriceMarketSerie based on its current tags.
 * Handles: first attachment, series-key change, detachment. Updates marketIds on both
 * old and new series and refreshes currentMarket on whichever changed.
 */
function reconcileMarketSeries(market: Market, timestamp: BigInt): void {
  let newSeriesKey = extractSeriesKey(market.tags);
  let newEntityId: string | null = null;
  if (newSeriesKey != null) {
    newEntityId = seriesEntityId(market.venue, newSeriesKey as string);
  }
  let oldEntityId = market.priceSeries;

  if (newEntityId == oldEntityId) {
    // No membership change. Still refresh tags on current series if this is its current market.
    if (newEntityId != null) {
      let series = PriceMarketSerie.load(newEntityId as string);
      if (series != null && series.currentMarket == market.id) {
        series.tags = market.tags;
        series.updatedAt = timestamp;
        series.save();
      }
    }
    return;
  }

  // Detach from old series
  if (oldEntityId != null) {
    let oldSeries = PriceMarketSerie.load(oldEntityId as string);
    if (oldSeries != null) {
      let ids = oldSeries.marketIds;
      let filtered: string[] = [];
      for (let i = 0; i < ids.length; i++) {
        if (ids[i] != market.id) filtered.push(ids[i]);
      }
      oldSeries.marketIds = filtered;
      refreshSeriesCurrent(oldSeries, timestamp);
    }
    market.priceSeries = null;
  }

  // Attach to new series
  if (newSeriesKey != null) {
    let newSeries = getOrCreatePriceMarketSerie(
      market.venue,
      newSeriesKey as string,
      timestamp,
    );
    let ids = newSeries.marketIds;
    let exists = false;
    for (let i = 0; i < ids.length; i++) {
      if (ids[i] == market.id) {
        exists = true;
        break;
      }
    }
    if (!exists) {
      ids.push(market.id);
      newSeries.marketIds = ids;
    }
    market.priceSeries = newSeries.id;
    refreshSeriesCurrent(newSeries, timestamp);
  }

  // Persist the market's priceSeries back-pointer (the calling handler already
  // did its own market.save() before invoking reconcile, so we need to commit
  // the membership change explicitly).
  market.save();
}

// ============================================
// Venue Lifecycle
// ============================================

export function handleVenueCreated(event: VenueCreated): void {
  let venueId = event.params.venueId;
  let venue = new Venue(venueId.toString());

  venue.venueId = venueId;
  venue.operator = event.params.operator;
  venue.name = event.params.name;
  venue.metadata = event.params.metadata;

  // Initialize fee configuration (will be set via VenueFeesUpdated event, fired in same tx)
  venue.venueFeeBps = BigInt.fromI32(0);
  venue.creatorFeeBps = BigInt.fromI32(0);

  // marketCreationFee is set at creation but no event carries it. Read it directly
  // from storage via the Diamond. Falls back to 0 if the call reverts (shouldn't, but
  // defensive — the Diamond is the same address that emitted the event).
  let diamond = OddMaki.bind(event.address);
  let venueResult = diamond.try_getVenue(venueId);
  if (!venueResult.reverted) {
    venue.marketCreationFee = venueResult.value.marketCreationFee;
  } else {
    venue.marketCreationFee = BigInt.fromI32(0);
    log.warning('getVenue reverted while initializing marketCreationFee for venue {}', [
      venueId.toString(),
    ]);
  }

  // Initialize oracle configuration (will be set via VenueOracleParamsUpdated event)
  venue.umaRewardAmount = BigInt.fromI32(0);
  venue.umaMinBond = BigInt.fromI32(0);

  // Access control (initialized to zero address = public, updated via VenueAccessControlUpdated)
  venue.tradingAccessControl = Address.zero();
  venue.creationAccessControl = Address.zero();

  // Initial state
  venue.paused = false;

  // Initialize statistics
  venue.totalMarkets = BigInt.fromI32(0);
  venue.totalMarketGroups = BigInt.fromI32(0);
  venue.activeMarkets = BigInt.fromI32(0);
  venue.totalVolume = BigInt.fromI32(0);
  venue.totalFees = BigInt.fromI32(0);

  // Timestamps
  venue.createdAt = event.block.timestamp;
  venue.createdAtBlock = event.block.number;
  venue.updatedAt = event.block.timestamp;

  venue.save();

  // Update protocol statistics
  let protocol = getOrCreateProtocol();
  protocol.totalVenues = protocol.totalVenues.plus(BigInt.fromI32(1));
  protocol.updatedAt = event.block.timestamp;
  protocol.save();

  log.info('Venue {} created: operator={}, name={}', [
    venueId.toString(),
    event.params.operator.toHexString(),
    event.params.name,
  ]);
}

export function handleVenueUpdated(event: VenueUpdated): void {
  let venueId = event.params.venueId;
  let venue = Venue.load(venueId.toString());

  if (venue == null) {
    log.warning('Venue {} not found in VenueUpdated event', [
      venueId.toString(),
    ]);
    return;
  }

  venue.operator = event.params.operator;
  venue.name = event.params.name;
  venue.metadata = event.params.metadata;
  venue.updatedAt = event.block.timestamp;
  venue.save();

  log.info('Venue {} updated: name={}', [venueId.toString(), event.params.name]);
}

export function handleVenuePaused(event: VenuePaused): void {
  let venueId = event.params.venueId;
  let venue = Venue.load(venueId.toString());

  if (venue == null) {
    log.warning('Venue {} not found in VenuePaused event', [
      venueId.toString(),
    ]);
    return;
  }

  venue.paused = true;
  venue.updatedAt = event.block.timestamp;
  venue.save();

  log.info('Venue {} paused', [venueId.toString()]);
}

export function handleVenueUnpaused(event: VenueUnpaused): void {
  let venueId = event.params.venueId;
  let venue = Venue.load(venueId.toString());

  if (venue == null) {
    log.warning('Venue {} not found in VenueUnpaused event', [
      venueId.toString(),
    ]);
    return;
  }

  venue.paused = false;
  venue.updatedAt = event.block.timestamp;
  venue.save();

  log.info('Venue {} unpaused', [venueId.toString()]);
}

export function handleVenueFeesUpdated(event: VenueFeesUpdated): void {
  let venueId = event.params.venueId;
  let venue = Venue.load(venueId.toString());

  if (venue == null) {
    log.warning('Venue {} not found in VenueFeesUpdated event', [
      venueId.toString(),
    ]);
    return;
  }

  venue.venueFeeBps = event.params.venueFeeBps;
  venue.creatorFeeBps = event.params.creatorFeeBps;
  venue.updatedAt = event.block.timestamp;
  venue.save();

  log.info('Venue {} fees updated: venueFee={}, creatorFee={}', [
    venueId.toString(),
    event.params.venueFeeBps.toString(),
    event.params.creatorFeeBps.toString(),
  ]);
}

export function handleProtocolFeeBpsUpdated(
  event: ProtocolFeeBpsUpdated,
): void {
  log.info('Protocol fee updated to {} bps', [event.params.bps.toString()]);
}

export function handleVenueOracleParamsUpdated(
  event: VenueOracleParamsUpdated,
): void {
  let venueId = event.params.venueId;
  let venue = Venue.load(venueId.toString());

  if (venue == null) {
    log.warning('Venue {} not found in VenueOracleParamsUpdated event', [
      venueId.toString(),
    ]);
    return;
  }

  venue.umaRewardAmount = event.params.umaRewardAmount;
  venue.umaMinBond = event.params.umaMinBond;
  venue.updatedAt = event.block.timestamp;
  venue.save();

  log.info('Venue {} oracle params updated: reward={}, minBond={}', [
    venueId.toString(),
    event.params.umaRewardAmount.toString(),
    event.params.umaMinBond.toString(),
  ]);
}

export function handleVenueMarketCreationFeeUpdated(
  event: VenueMarketCreationFeeUpdated,
): void {
  let venueId = event.params.venueId;
  let venue = Venue.load(venueId.toString());

  if (venue == null) {
    log.warning('Venue {} not found in VenueMarketCreationFeeUpdated event', [
      venueId.toString(),
    ]);
    return;
  }

  venue.marketCreationFee = event.params.newFee;
  venue.updatedAt = event.block.timestamp;
  venue.save();

  log.info('Venue {} market creation fee updated: {}', [
    venueId.toString(),
    event.params.newFee.toString(),
  ]);
}

export function handleVenueAccessControlUpdated(
  event: VenueAccessControlUpdated,
): void {
  let venueId = event.params.venueId;
  let venue = Venue.load(venueId.toString());

  if (venue == null) {
    log.warning('Venue {} not found in VenueAccessControlUpdated event', [
      venueId.toString(),
    ]);
    return;
  }

  venue.tradingAccessControl = event.params.tradingAccessControl;
  venue.creationAccessControl = event.params.creationAccessControl;
  venue.updatedAt = event.block.timestamp;
  venue.save();

  log.info('Venue {} AC updated: trading={}, creation={}', [
    venueId.toString(),
    event.params.tradingAccessControl.toHexString(),
    event.params.creationAccessControl.toHexString(),
  ]);
}

// ============================================
// Market Creation (Enriched Event)
// ============================================

export function handleMarketCreated(event: MarketCreated): void {
  let marketId = event.params.marketId;
  let venueId = event.params.venueId;

  // Get or create user
  let user = getOrCreateUser(event.params.creator, event.block.timestamp);

  // Get venue
  let venue = Venue.load(venueId.toString());
  if (venue == null) {
    log.warning('Venue {} not found for market {}', [
      venueId.toString(),
      marketId.toString(),
    ]);
    return;
  }

  // Load or create market — may already exist as a stub from MarketAddedToGroup/PlaceholderMarketsAdded
  let market = Market.load(marketId.toString());
  if (market == null) {
    market = new Market(marketId.toString());
    market.marketId = marketId;
    market.groupId = BigInt.fromI32(0);
    market.totalOrders = BigInt.fromI32(0);
    market.totalVolume = BigInt.fromI32(0);
    market.totalFees = BigInt.fromI32(0);
    market.uniqueTraders = BigInt.fromI32(0);
    market.tags = [];
    market.isPriceMarket = false;
    market.createdAt = event.block.timestamp;
    market.createdAtBlock = event.block.number;
  }

  // All data available from the enriched event — no cross-event dependency
  market.venue = venueId.toString();
  market.creator = user.id;
  market.question = event.params.question;
  market.outcomes = event.params.outcomes;
  market.outcomeSlotCount = BigInt.fromI32(event.params.outcomes.length);
  market.conditionId = event.params.conditionId;
  market.collateralToken = event.params.collateralToken;
  market.tickSize = event.params.tickSize;
  market.protocolFeeBps = BigInt.fromI32(0); // Will be set once MarketRegistryData is readable; snapshotted at creation
  market.tags = decodeTags(event.params.tags);

  // Reverse lookup: conditionId → marketId (for CTF PayoutRedemption handler)
  let conditionMarket = new ConditionMarket(event.params.conditionId);
  conditionMarket.marketId = marketId.toString();
  conditionMarket.save();

  // Fetch collateral token decimals (one-time RPC call per market)
  let collateralContract = ERC20.bind(event.params.collateralToken);
  let decimalsResult = collateralContract.try_decimals();
  if (decimalsResult.reverted) {
    log.warning('Failed to fetch decimals for collateral token {}', [
      event.params.collateralToken.toHexString(),
    ]);
    market.collateralDecimals = 18; // Default to 18 if call fails
  } else {
    market.collateralDecimals = decimalsResult.value;
  }

  // Set group association if grouped market
  let groupId = event.params.groupId;
  if (groupId.gt(BigInt.fromI32(0))) {
    market.groupId = groupId;
    market.marketGroup = groupId.toString();
    market.status = 'Draft'; // Grouped markets start as Draft
  } else {
    market.groupId = BigInt.fromI32(0);
    market.status = 'Active'; // Standalone markets are immediately Active
  }

  market.save();

  // Attach to price market series if tags indicate one. The series' currentMarket
  // pointer is only fully resolvable after PriceMarketCreatedPyth fires (which sets
  // closeTime), so we just register membership here and let that handler refresh.
  reconcileMarketSeries(market, event.block.timestamp);

  // Update venue statistics
  venue.totalMarkets = venue.totalMarkets.plus(BigInt.fromI32(1));
  if (market.status == 'Active') {
    venue.activeMarkets = venue.activeMarkets.plus(BigInt.fromI32(1));
  }
  venue.updatedAt = event.block.timestamp;
  venue.save();

  // Update user statistics
  user.totalMarkets = user.totalMarkets.plus(BigInt.fromI32(1));
  user.save();

  // Update protocol statistics
  let protocol = getOrCreateProtocol();
  protocol.totalMarkets = protocol.totalMarkets.plus(BigInt.fromI32(1));
  protocol.updatedAt = event.block.timestamp;
  protocol.save();

  log.info(
    'Market {} created: venue={}, creator={}, question={}, groupId={}',
    [
      marketId.toString(),
      venueId.toString(),
      event.params.creator.toHexString(),
      event.params.question,
      groupId.toString(),
    ],
  );
}

// ============================================
// Market Group Lifecycle
// ============================================

export function handleMarketGroupCreated(event: MarketGroupCreated): void {
  let groupId = event.params.groupId;
  let venueId = event.params.venueId;

  // Get or create user
  let user = getOrCreateUser(event.params.creator, event.block.timestamp);

  // Get venue
  let venue = Venue.load(venueId.toString());
  if (venue == null) {
    log.warning('Venue {} not found for market group {}', [
      venueId.toString(),
      groupId.toString(),
    ]);
    return;
  }

  // Create market group
  let marketGroup = new MarketGroup(groupId.toString());
  marketGroup.groupId = groupId;
  marketGroup.venue = venueId.toString();
  marketGroup.creator = user.id;
  marketGroup.marketQuestion = event.params.question;

  // Market tracking
  marketGroup.totalMarkets = BigInt.fromI32(0);
  marketGroup.activeMarketCount = BigInt.fromI32(0);

  // UMA reward
  marketGroup.reward = event.params.reward;

  // Initial state
  marketGroup.status = 'Draft';
  marketGroup.resolvedMarketId = BigInt.fromI32(0);

  // Initialize stored market IDs array (needed because `markets` is @derivedFrom and inaccessible in handlers)
  marketGroup.marketIds = [];

  // Tags
  marketGroup.tags = decodeTags(event.params.tags);

  // Timestamps
  marketGroup.createdAt = event.params.timestamp;
  marketGroup.createdAtBlock = event.block.number;

  marketGroup.save();

  // Update venue statistics
  venue.totalMarketGroups = venue.totalMarketGroups.plus(BigInt.fromI32(1));
  venue.updatedAt = event.block.timestamp;
  venue.save();

  // Update user statistics
  user.totalMarketGroups = user.totalMarketGroups.plus(BigInt.fromI32(1));
  user.save();

  // Update protocol statistics
  let protocol = getOrCreateProtocol();
  protocol.totalMarketGroups = protocol.totalMarketGroups.plus(
    BigInt.fromI32(1),
  );
  protocol.updatedAt = event.block.timestamp;
  protocol.save();

  log.info('MarketGroup {} created: venue={}, creator={}, question={}', [
    groupId.toString(),
    venueId.toString(),
    event.params.creator.toHexString(),
    event.params.question,
  ]);
}

export function handleMarketAddedToGroup(event: MarketAddedToGroup): void {
  let groupId = event.params.groupId;
  let marketId = event.params.marketId;

  // Load market group
  let marketGroup = MarketGroup.load(groupId.toString());
  if (marketGroup == null) {
    log.warning('MarketGroup {} not found in MarketAddedToGroup event', [
      groupId.toString(),
    ]);
    return;
  }

  // Create MarketGroupItem first (needed for reverse link on market)
  let marketGroupItem = new MarketGroupItem(marketId.toString());
  marketGroupItem.market = marketId.toString();
  marketGroupItem.marketGroup = groupId.toString();
  marketGroupItem.marketName = event.params.marketName;
  marketGroupItem.isPlaceholder = false;
  marketGroupItem.createdAt = event.block.timestamp;
  marketGroupItem.save();

  // Load market — should already exist from MarketCreated (emitted first in the same tx)
  let market = Market.load(marketId.toString());
  if (market != null) {
    // Ensure group association is set
    market.groupId = groupId;
    market.marketGroup = groupId.toString();
    market.marketGroupItem = marketId.toString();
    // Inherit tags from the group
    market.tags = marketGroup.tags;
    market.save();
  }

  // Update market group: count + stored marketIds array
  marketGroup.activeMarketCount = marketGroup.activeMarketCount.plus(
    BigInt.fromI32(1),
  );
  let ids = marketGroup.marketIds;
  ids.push(marketId.toString());
  marketGroup.marketIds = ids;
  marketGroup.save();

  log.info('Market {} added to MarketGroup {}: name={}', [
    marketId.toString(),
    groupId.toString(),
    event.params.marketName,
  ]);
}

export function handlePlaceholderMarketsAdded(
  event: PlaceholderMarketsAdded,
): void {
  let groupId = event.params.groupId;
  let marketIds = event.params.marketIds;

  // Load market group
  let marketGroup = MarketGroup.load(groupId.toString());
  if (marketGroup == null) {
    log.warning('MarketGroup {} not found in PlaceholderMarketsAdded event', [
      groupId.toString(),
    ]);
    return;
  }

  // Process each placeholder market
  for (let i = 0; i < marketIds.length; i++) {
    let marketId = marketIds[i];

    // Create MarketGroupItem for placeholder first (needed for reverse link)
    let marketGroupItem = new MarketGroupItem(marketId.toString());
    marketGroupItem.market = marketId.toString();
    marketGroupItem.marketGroup = groupId.toString();
    marketGroupItem.marketName = ''; // Empty for placeholders
    marketGroupItem.isPlaceholder = true;
    marketGroupItem.createdAt = event.block.timestamp;
    marketGroupItem.save();

    // Load market — should already exist from MarketCreated
    let market = Market.load(marketId.toString());
    if (market != null) {
      market.groupId = groupId;
      market.marketGroup = groupId.toString();
      market.marketGroupItem = marketId.toString();
      market.status = 'Draft';
      market.save();
    }

    // Track in stored marketIds array
    let ids = marketGroup.marketIds;
    ids.push(marketId.toString());
    marketGroup.marketIds = ids;
  }

  marketGroup.save();

  log.info('Added {} placeholder markets to MarketGroup {}', [
    event.params.count.toString(),
    groupId.toString(),
  ]);
}

export function handlePlaceholderActivated(event: PlaceholderActivated): void {
  let groupId = event.params.groupId;
  let marketId = event.params.marketId;

  // Load market
  let market = Market.load(marketId.toString());
  if (market == null) {
    log.warning('Market {} not found in PlaceholderActivated event', [
      marketId.toString(),
    ]);
    return;
  }

  // Load market group item
  let marketGroupItem = MarketGroupItem.load(marketId.toString());
  if (marketGroupItem == null) {
    log.warning('MarketGroupItem {} not found in PlaceholderActivated event', [
      marketId.toString(),
    ]);
    return;
  }

  // Update market
  market.status = 'Active';
  market.question = event.params.marketQuestion;
  market.save();

  // Update market group item
  marketGroupItem.marketName = event.params.marketName;
  marketGroupItem.isPlaceholder = false;
  marketGroupItem.activatedAt = event.params.timestamp;
  marketGroupItem.save();

  // Update market group count
  let marketGroup = MarketGroup.load(groupId.toString());
  if (marketGroup != null) {
    marketGroup.activeMarketCount = marketGroup.activeMarketCount.plus(
      BigInt.fromI32(1),
    );
    marketGroup.save();
  }

  log.info('Placeholder market {} activated in MarketGroup {}: name={}', [
    marketId.toString(),
    groupId.toString(),
    event.params.marketName,
  ]);
}

export function handleMarketGroupActivated(event: MarketGroupActivated): void {
  let groupId = event.params.groupId;

  // Load market group
  let marketGroup = MarketGroup.load(groupId.toString());
  if (marketGroup == null) {
    log.warning('MarketGroup {} not found in MarketGroupActivated event', [
      groupId.toString(),
    ]);
    return;
  }

  marketGroup.status = 'Active';
  marketGroup.totalMarkets = BigInt.fromI32(marketGroup.marketIds.length);
  marketGroup.activatedAt = event.params.timestamp;
  marketGroup.save();

  // Activate non-placeholder child markets (mirrors on-chain behavior)
  // Use stored marketIds array (not @derivedFrom `markets` which is inaccessible in handlers)
  let storedIds = marketGroup.marketIds;
  for (let i = 0; i < storedIds.length; i++) {
    let market = Market.load(storedIds[i]);
    if (market == null) continue;

    let item = MarketGroupItem.load(storedIds[i]);
    if (item != null && !item.isPlaceholder) {
      market.status = 'Active';
      market.save();
    }
  }

  log.info('MarketGroup {} activated with {} markets', [
    groupId.toString(),
    event.params.marketCount.toString(),
  ]);
}

// ============================================
// Order Lifecycle
// ============================================

export function handleOrderPlaced(event: OrderPlaced): void {
  let orderId = event.params.orderId;
  let marketId = event.params.marketId;

  // Get or create user
  let user = getOrCreateUser(event.params.owner, event.block.timestamp);

  // Load market
  let market = Market.load(marketId.toString());
  if (market == null) {
    log.warning('Market {} not found for order {}', [
      marketId.toString(),
      orderId.toString(),
    ]);
    return;
  }

  // Create order
  let order = new Order(orderId.toString());
  order.orderId = orderId;
  order.market = marketId.toString();
  order.trader = user.id;
  order.outcome = event.params.outcomeId;
  order.side = event.params.side == 0 ? 'BUY' : 'SELL';
  order.tick = event.params.tick;
  order.amount = event.params.qty;
  order.filled = BigInt.fromI32(0);
  order.status = 'Active';
  order.deleted = false;
  order.createdAt = event.block.timestamp;
  order.createdAtBlock = event.block.number;
  order.save();

  // Update market statistics
  market.totalOrders = market.totalOrders.plus(BigInt.fromI32(1));
  market.save();

  // Update user statistics
  user.totalOrdersPlaced = user.totalOrdersPlaced.plus(BigInt.fromI32(1));
  user.save();

  log.info('Order {} placed: market={}, side={}, tick={}, qty={}', [
    orderId.toString(),
    marketId.toString(),
    order.side,
    event.params.tick.toString(),
    event.params.qty.toString(),
  ]);
}

export function handleOrderCancelled(event: OrderCancelled): void {
  let orderId = event.params.orderId;
  let order = Order.load(orderId.toString());

  if (order == null) {
    log.warning('Order {} not found in OrderCancelled event', [
      orderId.toString(),
    ]);
    return;
  }

  order.status = 'Cancelled';
  order.cancelledAt = event.block.timestamp;
  order.save();

  log.info('Order {} cancelled', [orderId.toString()]);
}

export function handleOrderExpired(event: OrderExpired): void {
  let orderId = event.params.orderId;
  let order = Order.load(orderId.toString());

  if (order == null) {
    log.warning('Order {} not found in OrderExpired event', [
      orderId.toString(),
    ]);
    return;
  }

  order.status = 'Expired';
  order.expiredAt = event.block.timestamp;
  order.save();

  log.info('Order {} expired: owner={}, qty={}', [
    orderId.toString(),
    event.params.owner.toHexString(),
    event.params.qty.toString(),
  ]);
}

export function handleOrderDeleted(event: OrderDeleted): void {
  let orderId = event.params.orderId;
  let order = Order.load(orderId.toString());

  if (order == null) {
    log.warning('Order {} not found in OrderDeleted event', [
      orderId.toString(),
    ]);
    return;
  }

  order.deleted = true;
  // If fully filled, mark as Filled
  if (order.filled.ge(order.amount)) {
    order.status = 'Filled';
  }
  order.save();

  log.info('Order {} deleted', [orderId.toString()]);
}

export function handleOrderAutoCancelled(event: OrderAutoCancelled): void {
  let orderId = event.params.orderId;
  let order = Order.load(orderId.toString());

  if (order == null) {
    log.warning('Order {} not found in OrderAutoCancelled event', [
      orderId.toString(),
    ]);
    return;
  }

  order.status = 'Cancelled';
  order.deleted = true;
  order.save();

  log.info('Order {} auto-cancelled (buyer-taker, unfunded remainder). Refunded: {}', [
    orderId.toString(),
    event.params.refundedCollateral.toString(),
  ]);
}

// ============================================
// Matching & Fills
// ============================================

export function handleOrderFilled(event: OrderFilled): void {
  let marketId = event.params.marketId;
  let market = Market.load(marketId.toString());

  if (market == null) {
    log.warning('Market {} not found in OrderFilled event', [
      marketId.toString(),
    ]);
    return;
  }

  // Load buy order
  let buyOrderId = event.params.buyOrderId;
  let buyOrder = Order.load(buyOrderId.toString());

  // Load sell order
  let sellOrderId = event.params.sellOrderId;
  let sellOrder = Order.load(sellOrderId.toString());

  // Compute collateral cost: qty * priceTick * tickSize / 1e18
  let tickSize = market.tickSize;
  let collateralCost = event.params.qty.times(event.params.priceTick).times(tickSize).div(SCALE);

  // Create market-level Trade entity (one per match)
  let tradeId = generateId([
    event.transaction.hash.toHexString(),
    event.logIndex.toString(),
  ]);

  let trade = new Trade(tradeId);
  trade.market = marketId.toString();
  trade.outcome = event.params.outcomeId;
  trade.tick = event.params.priceTick;
  trade.amount = event.params.qty;
  trade.cost = collateralCost;
  trade.tradeType = 'OrderFill';
  trade.buyTrader = buyOrder != null ? buyOrder.trader : '';
  trade.sellTrader = sellOrder != null ? sellOrder.trader : '';
  trade.timestamp = event.block.timestamp;
  trade.blockNumber = event.block.number;
  trade.transactionHash = event.transaction.hash;
  trade.save();

  // Create per-participant Fill entities (one per side)
  let buyFillId = generateId([
    event.transaction.hash.toHexString(),
    event.logIndex.toString(),
    'buy',
  ]);

  let buyFill = new Fill(buyFillId);
  buyFill.market = marketId.toString();
  buyFill.outcome = event.params.outcomeId;
  buyFill.side = 'BUY';
  buyFill.tick = event.params.priceTick;
  buyFill.amount = event.params.qty;
  buyFill.cost = collateralCost;
  buyFill.fees = BigInt.fromI32(0); // Tracked in FeesDistributed
  buyFill.trader = buyOrder != null ? buyOrder.trader : '';
  buyFill.tradeType = 'OrderFill';
  buyFill.timestamp = event.block.timestamp;
  buyFill.blockNumber = event.block.number;
  buyFill.transactionHash = event.transaction.hash;
  buyFill.save();

  let sellFillId = generateId([
    event.transaction.hash.toHexString(),
    event.logIndex.toString(),
    'sell',
  ]);

  let sellFill = new Fill(sellFillId);
  sellFill.market = marketId.toString();
  sellFill.outcome = event.params.outcomeId;
  sellFill.side = 'SELL';
  sellFill.tick = event.params.priceTick;
  sellFill.amount = event.params.qty;
  sellFill.cost = collateralCost;
  sellFill.fees = BigInt.fromI32(0);
  sellFill.trader = sellOrder != null ? sellOrder.trader : '';
  sellFill.tradeType = 'OrderFill';
  sellFill.timestamp = event.block.timestamp;
  sellFill.blockNumber = event.block.number;
  sellFill.transactionHash = event.transaction.hash;
  sellFill.save();

  // Update buy order filled amount and trader position
  if (buyOrder != null) {
    buyOrder.filled = buyOrder.filled.plus(event.params.qty);
    if (buyOrder.filled.ge(buyOrder.amount)) {
      buyOrder.status = 'Filled';
    } else if (buyOrder.filled.gt(BigInt.fromI32(0))) {
      buyOrder.status = 'PartiallyFilled';
    }
    buyOrder.save();

    trackUniqueTrader(market, buyOrder.trader, event.block.timestamp);
    updateTraderPosition(
      buyOrder.trader, marketId.toString(), event.params.outcomeId,
      'BUY', event.params.qty, collateralCost, event.block.timestamp,
    );

    // Update buyer user stats
    let buyUser = User.load(buyOrder.trader);
    if (buyUser != null) {
      buyUser.totalTradeCount = buyUser.totalTradeCount.plus(BigInt.fromI32(1));
      buyUser.totalVolume = buyUser.totalVolume.plus(event.params.qty);
      buyUser.save();
    }
  }

  // Update sell order filled amount and trader position
  if (sellOrder != null) {
    sellOrder.filled = sellOrder.filled.plus(event.params.qty);
    if (sellOrder.filled.ge(sellOrder.amount)) {
      sellOrder.status = 'Filled';
    } else if (sellOrder.filled.gt(BigInt.fromI32(0))) {
      sellOrder.status = 'PartiallyFilled';
    }
    sellOrder.save();

    trackUniqueTrader(market, sellOrder.trader, event.block.timestamp);
    updateTraderPosition(
      sellOrder.trader, marketId.toString(), event.params.outcomeId,
      'SELL', event.params.qty, collateralCost, event.block.timestamp,
    );

    // Update seller user stats
    let sellUser = User.load(sellOrder.trader);
    if (sellUser != null) {
      sellUser.totalTradeCount = sellUser.totalTradeCount.plus(BigInt.fromI32(1));
      sellUser.totalVolume = sellUser.totalVolume.plus(event.params.qty);
      sellUser.save();
    }
  }

  // Update market last trade prices (Normal fill = true price discovery)
  if (event.params.outcomeId.equals(BigInt.fromI32(0))) {
    market.lastPriceTick_0 = event.params.priceTick;
    market.lastTradeTimestamp_0 = event.block.timestamp;
  } else if (event.params.outcomeId.equals(BigInt.fromI32(1))) {
    market.lastPriceTick_1 = event.params.priceTick;
    market.lastTradeTimestamp_1 = event.block.timestamp;
  }
  market.lastTradeTimestamp = event.block.timestamp;
  market.lastTradeOutcome = event.params.outcomeId.toI32();

  // Update market statistics
  market.totalVolume = market.totalVolume.plus(event.params.qty);
  market.save();

  // Update venue statistics
  let venue = Venue.load(market.venue);
  if (venue != null) {
    venue.totalVolume = venue.totalVolume.plus(event.params.qty);
    venue.updatedAt = event.block.timestamp;
    venue.save();
  }

  // Update protocol statistics
  let protocol = getOrCreateProtocol();
  protocol.totalVolume = protocol.totalVolume.plus(event.params.qty);
  protocol.updatedAt = event.block.timestamp;
  protocol.save();

  log.info('OrderFilled: buy={}, sell={}, market={}, outcome={}, qty={}, tick={}', [
    buyOrderId.toString(),
    sellOrderId.toString(),
    marketId.toString(),
    event.params.outcomeId.toString(),
    event.params.qty.toString(),
    event.params.priceTick.toString(),
  ]);
}

export function handleMintFill(event: MintFill): void {
  let marketId = event.params.marketId;
  let market = Market.load(marketId.toString());

  if (market == null) {
    log.warning('Market {} not found in MintFill event', [
      marketId.toString(),
    ]);
    return;
  }

  // Load orders to get trader addresses
  let yesOrder = Order.load(event.params.yesOrderId.toString());
  let noOrder = Order.load(event.params.noOrderId.toString());

  // Compute collateral costs
  let tickSize = market.tickSize;
  let yesCost = event.params.qty.times(event.params.yesTick).times(tickSize).div(SCALE);
  let noCost = event.params.qty.times(event.params.noTick).times(tickSize).div(SCALE);

  // Create market-level Trade entities (one per outcome — two distinct acquisitions at different prices)
  let yesTradeId = generateId([
    event.transaction.hash.toHexString(),
    event.logIndex.toString(),
    '0',
  ]);

  let yesTrade = new Trade(yesTradeId);
  yesTrade.market = marketId.toString();
  yesTrade.outcome = BigInt.fromI32(0);
  yesTrade.tick = event.params.yesTick;
  yesTrade.amount = event.params.qty;
  yesTrade.cost = yesCost;
  yesTrade.tradeType = 'MintFill';
  yesTrade.buyTrader = yesOrder != null ? yesOrder.trader : '';
  yesTrade.timestamp = event.block.timestamp;
  yesTrade.blockNumber = event.block.number;
  yesTrade.transactionHash = event.transaction.hash;
  yesTrade.save();

  let noTradeId = generateId([
    event.transaction.hash.toHexString(),
    event.logIndex.toString(),
    '1',
  ]);

  let noTrade = new Trade(noTradeId);
  noTrade.market = marketId.toString();
  noTrade.outcome = BigInt.fromI32(1);
  noTrade.tick = event.params.noTick;
  noTrade.amount = event.params.qty;
  noTrade.cost = noCost;
  noTrade.tradeType = 'MintFill';
  noTrade.buyTrader = noOrder != null ? noOrder.trader : '';
  noTrade.timestamp = event.block.timestamp;
  noTrade.blockNumber = event.block.number;
  noTrade.transactionHash = event.transaction.hash;
  noTrade.save();

  // Create per-participant Fill entities (one per buyer)
  let yesFillId = generateId([
    event.transaction.hash.toHexString(),
    event.logIndex.toString(),
    '0',
  ]);

  let yesFill = new Fill(yesFillId);
  yesFill.market = marketId.toString();
  yesFill.outcome = BigInt.fromI32(0);
  yesFill.side = 'BUY';
  yesFill.tick = event.params.yesTick;
  yesFill.amount = event.params.qty;
  yesFill.cost = yesCost;
  yesFill.fees = BigInt.fromI32(0);
  yesFill.trader = yesOrder != null ? yesOrder.trader : '';
  yesFill.tradeType = 'MintFill';
  yesFill.timestamp = event.block.timestamp;
  yesFill.blockNumber = event.block.number;
  yesFill.transactionHash = event.transaction.hash;
  yesFill.save();

  let noFillId = generateId([
    event.transaction.hash.toHexString(),
    event.logIndex.toString(),
    '1',
  ]);

  let noFill = new Fill(noFillId);
  noFill.market = marketId.toString();
  noFill.outcome = BigInt.fromI32(1);
  noFill.side = 'BUY';
  noFill.tick = event.params.noTick;
  noFill.amount = event.params.qty;
  noFill.cost = noCost;
  noFill.fees = BigInt.fromI32(0);
  noFill.trader = noOrder != null ? noOrder.trader : '';
  noFill.tradeType = 'MintFill';
  noFill.timestamp = event.block.timestamp;
  noFill.blockNumber = event.block.number;
  noFill.transactionHash = event.transaction.hash;
  noFill.save();

  // Update YES order filled amount and trader position
  if (yesOrder != null) {
    yesOrder.filled = yesOrder.filled.plus(event.params.qty);
    if (yesOrder.filled.ge(yesOrder.amount)) {
      yesOrder.status = 'Filled';
    } else if (yesOrder.filled.gt(BigInt.fromI32(0))) {
      yesOrder.status = 'PartiallyFilled';
    }
    yesOrder.save();
    trackUniqueTrader(market, yesOrder.trader, event.block.timestamp);
    updateTraderPosition(
      yesOrder.trader, marketId.toString(), BigInt.fromI32(0),
      'BUY', event.params.qty, yesCost, event.block.timestamp,
    );

    let yesUser = User.load(yesOrder.trader);
    if (yesUser != null) {
      yesUser.totalTradeCount = yesUser.totalTradeCount.plus(BigInt.fromI32(1));
      yesUser.totalVolume = yesUser.totalVolume.plus(event.params.qty);
      yesUser.save();
    }
  }

  // Update NO order filled amount and trader position
  if (noOrder != null) {
    noOrder.filled = noOrder.filled.plus(event.params.qty);
    if (noOrder.filled.ge(noOrder.amount)) {
      noOrder.status = 'Filled';
    } else if (noOrder.filled.gt(BigInt.fromI32(0))) {
      noOrder.status = 'PartiallyFilled';
    }
    noOrder.save();
    trackUniqueTrader(market, noOrder.trader, event.block.timestamp);
    updateTraderPosition(
      noOrder.trader, marketId.toString(), BigInt.fromI32(1),
      'BUY', event.params.qty, noCost, event.block.timestamp,
    );

    let noUser = User.load(noOrder.trader);
    if (noUser != null) {
      noUser.totalTradeCount = noUser.totalTradeCount.plus(BigInt.fromI32(1));
      noUser.totalVolume = noUser.totalVolume.plus(event.params.qty);
      noUser.save();
    }
  }

  // MintFill IS price discovery — update last trade prices for both outcomes
  market.lastPriceTick_0 = event.params.yesTick;
  market.lastPriceTick_1 = event.params.noTick;
  market.lastTradeTimestamp = event.block.timestamp;
  market.lastTradeTimestamp_0 = event.block.timestamp;
  market.lastTradeTimestamp_1 = event.block.timestamp;
  market.lastTradeOutcome = 0; // Both outcomes traded; convention: report outcome 0

  // Update market statistics (count volume once, not per outcome)
  market.totalVolume = market.totalVolume.plus(event.params.qty);
  market.save();

  // Update venue statistics
  let mintVenue = Venue.load(market.venue);
  if (mintVenue != null) {
    mintVenue.totalVolume = mintVenue.totalVolume.plus(event.params.qty);
    mintVenue.updatedAt = event.block.timestamp;
    mintVenue.save();
  }

  // Update protocol statistics
  let protocol = getOrCreateProtocol();
  protocol.totalVolume = protocol.totalVolume.plus(event.params.qty);
  protocol.updatedAt = event.block.timestamp;
  protocol.save();

  log.info('MintFill: market={}, qty={}, yesTick={}, noTick={}', [
    marketId.toString(),
    event.params.qty.toString(),
    event.params.yesTick.toString(),
    event.params.noTick.toString(),
  ]);
}

export function handleMergeFill(event: MergeFill): void {
  let marketId = event.params.marketId;
  let market = Market.load(marketId.toString());

  if (market == null) {
    log.warning('Market {} not found in MergeFill event', [
      marketId.toString(),
    ]);
    return;
  }

  // Load orders to get trader addresses
  let yesOrder = Order.load(event.params.yesOrderId.toString());
  let noOrder = Order.load(event.params.noOrderId.toString());

  // Compute collateral proceeds
  let tickSize = market.tickSize;
  let yesProceeds = event.params.qty.times(event.params.yesTick).times(tickSize).div(SCALE);
  let noProceeds = event.params.qty.times(event.params.noTick).times(tickSize).div(SCALE);

  // MergeFill is NOT a market trade event (position exit, not purchase intent) — no Trade entities.
  // Create per-participant Fill entities for trader activity and P&L tracking.
  let yesFillId = generateId([
    event.transaction.hash.toHexString(),
    event.logIndex.toString(),
    '0',
  ]);

  let yesFill = new Fill(yesFillId);
  yesFill.market = marketId.toString();
  yesFill.outcome = BigInt.fromI32(0);
  yesFill.side = 'SELL';
  yesFill.tick = event.params.yesTick;
  yesFill.amount = event.params.qty;
  yesFill.cost = yesProceeds;
  yesFill.fees = BigInt.fromI32(0);
  yesFill.trader = yesOrder != null ? yesOrder.trader : '';
  yesFill.tradeType = 'MergeFill';
  yesFill.timestamp = event.block.timestamp;
  yesFill.blockNumber = event.block.number;
  yesFill.transactionHash = event.transaction.hash;
  yesFill.save();

  let noFillId = generateId([
    event.transaction.hash.toHexString(),
    event.logIndex.toString(),
    '1',
  ]);

  let noFill = new Fill(noFillId);
  noFill.market = marketId.toString();
  noFill.outcome = BigInt.fromI32(1);
  noFill.side = 'SELL';
  noFill.tick = event.params.noTick;
  noFill.amount = event.params.qty;
  noFill.cost = noProceeds;
  noFill.fees = BigInt.fromI32(0);
  noFill.trader = noOrder != null ? noOrder.trader : '';
  noFill.tradeType = 'MergeFill';
  noFill.timestamp = event.block.timestamp;
  noFill.blockNumber = event.block.number;
  noFill.transactionHash = event.transaction.hash;
  noFill.save();

  // Update YES order filled amount and trader position
  if (yesOrder != null) {
    yesOrder.filled = yesOrder.filled.plus(event.params.qty);
    if (yesOrder.filled.ge(yesOrder.amount)) {
      yesOrder.status = 'Filled';
    } else if (yesOrder.filled.gt(BigInt.fromI32(0))) {
      yesOrder.status = 'PartiallyFilled';
    }
    yesOrder.save();
    trackUniqueTrader(market, yesOrder.trader, event.block.timestamp);
    updateTraderPosition(
      yesOrder.trader, marketId.toString(), BigInt.fromI32(0),
      'SELL', event.params.qty, yesProceeds, event.block.timestamp,
    );

    let yesUser = User.load(yesOrder.trader);
    if (yesUser != null) {
      yesUser.totalTradeCount = yesUser.totalTradeCount.plus(BigInt.fromI32(1));
      yesUser.totalVolume = yesUser.totalVolume.plus(event.params.qty);
      yesUser.save();
    }
  }

  // Update NO order filled amount and trader position
  if (noOrder != null) {
    noOrder.filled = noOrder.filled.plus(event.params.qty);
    if (noOrder.filled.ge(noOrder.amount)) {
      noOrder.status = 'Filled';
    } else if (noOrder.filled.gt(BigInt.fromI32(0))) {
      noOrder.status = 'PartiallyFilled';
    }
    noOrder.save();
    trackUniqueTrader(market, noOrder.trader, event.block.timestamp);
    updateTraderPosition(
      noOrder.trader, marketId.toString(), BigInt.fromI32(1),
      'SELL', event.params.qty, noProceeds, event.block.timestamp,
    );

    let noUser = User.load(noOrder.trader);
    if (noUser != null) {
      noUser.totalTradeCount = noUser.totalTradeCount.plus(BigInt.fromI32(1));
      noUser.totalVolume = noUser.totalVolume.plus(event.params.qty);
      noUser.save();
    }
  }

  // MergeFill is NOT price discovery — do NOT update lastPriceTick

  // Update market statistics (count volume once, not per outcome)
  market.totalVolume = market.totalVolume.plus(event.params.qty);
  market.save();

  // Update venue statistics
  let mergeVenue = Venue.load(market.venue);
  if (mergeVenue != null) {
    mergeVenue.totalVolume = mergeVenue.totalVolume.plus(event.params.qty);
    mergeVenue.updatedAt = event.block.timestamp;
    mergeVenue.save();
  }

  // Update protocol statistics
  let protocol = getOrCreateProtocol();
  protocol.totalVolume = protocol.totalVolume.plus(event.params.qty);
  protocol.updatedAt = event.block.timestamp;
  protocol.save();

  log.info('MergeFill: market={}, qty={}, yesTick={}, noTick={}', [
    marketId.toString(),
    event.params.qty.toString(),
    event.params.yesTick.toString(),
    event.params.noTick.toString(),
  ]);
}

// ============================================
// TradeExecuted (timeseries hook — future candlestick data)
// ============================================

export function handleTradeExecuted(event: TradeExecuted): void {
  // Minimal handler for now. Trade entities are created by the fill-specific handlers
  // (handleOrderFilled, handleMintFill, handleMarketOrderExecuted).
  // TradeExecuted is the future hook for timeseries/candlestick entities.
  log.info(
    'TradeExecuted: market={}, outcome={}, fillId={}, tick={}, qty={}, cumVol={}',
    [
      event.params.marketId.toString(),
      event.params.outcomeId.toString(),
      event.params.fillId.toString(),
      event.params.priceTick.toString(),
      event.params.quantity.toString(),
      event.params.cumulativeVolume.toString(),
    ],
  );
}

// ============================================
// Fees
// ============================================

export function handleFeesDistributed(event: FeesDistributed): void {
  let marketId = event.params.marketId;
  let market = Market.load(marketId.toString());

  if (market == null) {
    log.warning('Market {} not found in FeesDistributed event', [
      marketId.toString(),
    ]);
    return;
  }

  // Create fee event
  let feeEventId = generateId([
    event.transaction.hash.toHexString(),
    event.logIndex.toString(),
  ]);

  let feeEvent = new FeeEvent(feeEventId);
  feeEvent.market = marketId.toString();
  feeEvent.fillId = event.params.fillId;
  feeEvent.protocolFee = event.params.protocolFee;
  feeEvent.venueFee = event.params.venueNetFee;
  feeEvent.creatorFee = event.params.creatorFee;
  feeEvent.operatorFee = event.params.operatorFee;
  feeEvent.totalFees = event.params.totalFee;
  feeEvent.timestamp = event.block.timestamp;
  feeEvent.blockNumber = event.block.number;
  feeEvent.transactionHash = event.transaction.hash;
  feeEvent.save();

  // Update market total fees
  market.totalFees = market.totalFees.plus(event.params.totalFee);
  market.save();

  // Update venue total fees
  let feeVenue = Venue.load(market.venue);
  if (feeVenue != null) {
    feeVenue.totalFees = feeVenue.totalFees.plus(event.params.totalFee);
    feeVenue.updatedAt = event.block.timestamp;
    feeVenue.save();
  }

  // Update protocol statistics
  let protocol = getOrCreateProtocol();
  protocol.totalFees = protocol.totalFees.plus(event.params.totalFee);
  protocol.updatedAt = event.block.timestamp;
  protocol.save();

  log.info('FeesDistributed: fillId={}, market={}, total={}', [
    event.params.fillId.toString(),
    marketId.toString(),
    event.params.totalFee.toString(),
  ]);
}

// ============================================
// Order Book State
// ============================================

export function handleTopOfBookChanged(event: TopOfBookChanged): void {
  let marketId = event.params.marketId;
  let outcomeId = event.params.outcomeId;
  let side = event.params.side == 0 ? 'BUY' : 'SELL';

  // Create unique ID for top of book
  let topOfBookId = generateId([
    marketId.toString(),
    outcomeId.toString(),
    side,
  ]);

  let topOfBook = TopOfBookEntity.load(topOfBookId);

  if (topOfBook == null) {
    topOfBook = new TopOfBookEntity(topOfBookId);
    topOfBook.market = marketId.toString();
    topOfBook.outcome = outcomeId;
    topOfBook.side = side;
  }

  topOfBook.topTick = event.params.bestTick;
  topOfBook.updatedAt = event.block.timestamp;
  topOfBook.updatedAtBlock = event.block.number;
  topOfBook.save();

  log.info('TopOfBook changed: market={}, outcome={}, side={}, tick={}', [
    marketId.toString(),
    outcomeId.toString(),
    side,
    event.params.bestTick.toString(),
  ]);
}

// ============================================
// Market Orders
// ============================================

export function handleMarketOrderExecuted(event: MarketOrderExecuted): void {
  let marketId = event.params.marketId;
  let market = Market.load(marketId.toString());

  if (market == null) {
    log.warning('Market {} not found in MarketOrderExecuted event', [
      marketId.toString(),
    ]);
    return;
  }

  // Get or create user
  let user = getOrCreateUser(event.params.buyer, event.block.timestamp);

  let baseId = generateId([
    event.transaction.hash.toHexString(),
    event.logIndex.toString(),
  ]);

  let tickSize = market.tickSize;
  let priceTick = tickSize.isZero()
    ? BigInt.fromI32(0)
    : event.params.avgPrice.div(tickSize);

  // Create market-level Trade entity
  let trade = new Trade(baseId);
  trade.market = marketId.toString();
  trade.outcome = event.params.outcomeId;
  trade.tick = priceTick;
  trade.amount = event.params.tokensReceived;
  trade.cost = event.params.collateralSpent;
  trade.tradeType = 'MarketOrder';
  trade.buyTrader = user.id;
  trade.avgPrice = event.params.avgPrice;
  trade.timestamp = event.block.timestamp;
  trade.blockNumber = event.block.number;
  trade.transactionHash = event.transaction.hash;
  trade.save();

  // Create per-participant Fill entity
  let fill = new Fill(baseId);
  fill.market = marketId.toString();
  fill.outcome = event.params.outcomeId;
  fill.side = 'BUY';
  fill.tick = priceTick;
  fill.amount = event.params.tokensReceived;
  fill.cost = event.params.collateralSpent;
  fill.fees = BigInt.fromI32(0); // Fees tracked separately
  fill.trader = user.id;
  fill.tradeType = 'MarketOrder';
  fill.avgPrice = event.params.avgPrice;
  fill.timestamp = event.block.timestamp;
  fill.blockNumber = event.block.number;
  fill.transactionHash = event.transaction.hash;
  fill.save();

  // Update market price from market order
  if (!tickSize.isZero()) {
    if (event.params.outcomeId.equals(BigInt.fromI32(0))) {
      market.lastPriceTick_0 = priceTick;
      market.lastTradeTimestamp_0 = event.block.timestamp;
    } else if (event.params.outcomeId.equals(BigInt.fromI32(1))) {
      market.lastPriceTick_1 = priceTick;
      market.lastTradeTimestamp_1 = event.block.timestamp;
    }
    market.lastTradeTimestamp = event.block.timestamp;
    market.lastTradeOutcome = event.params.outcomeId.toI32();
  }

  // Track unique trader
  trackUniqueTrader(market, user.id, event.block.timestamp);

  // Update trader position (market order cost is already in collateral units)
  updateTraderPosition(
    user.id, marketId.toString(), event.params.outcomeId,
    'BUY', event.params.tokensReceived, event.params.collateralSpent,
    event.block.timestamp,
  );

  // Update market statistics
  market.totalVolume = market.totalVolume.plus(event.params.tokensReceived);
  market.save();

  // Update venue statistics
  let buyVenue = Venue.load(market.venue);
  if (buyVenue != null) {
    buyVenue.totalVolume = buyVenue.totalVolume.plus(event.params.tokensReceived);
    buyVenue.updatedAt = event.block.timestamp;
    buyVenue.save();
  }

  // Update user statistics
  user.totalVolume = user.totalVolume.plus(event.params.tokensReceived);
  user.totalTradeCount = user.totalTradeCount.plus(BigInt.fromI32(1));
  user.save();

  // Update protocol statistics
  let protocol = getOrCreateProtocol();
  protocol.totalVolume = protocol.totalVolume.plus(
    event.params.tokensReceived,
  );
  protocol.updatedAt = event.block.timestamp;
  protocol.save();

  log.info(
    'MarketOrderExecuted: buyer={}, market={}, outcome={}, spent={}, received={}',
    [
      event.params.buyer.toHexString(),
      marketId.toString(),
      event.params.outcomeId.toString(),
      event.params.collateralSpent.toString(),
      event.params.tokensReceived.toString(),
    ],
  );
}

export function handleMarketSellExecuted(event: MarketSellExecuted): void {
  let marketId = event.params.marketId;
  let market = Market.load(marketId.toString());

  if (market == null) {
    log.warning('Market {} not found in MarketSellExecuted event', [
      marketId.toString(),
    ]);
    return;
  }

  // Get or create user
  let user = getOrCreateUser(event.params.seller, event.block.timestamp);

  let baseId = generateId([
    event.transaction.hash.toHexString(),
    event.logIndex.toString(),
  ]);

  let tickSize = market.tickSize;
  let priceTick = tickSize.isZero()
    ? BigInt.fromI32(0)
    : event.params.avgPrice.div(tickSize);

  // Create market-level Trade entity
  let trade = new Trade(baseId);
  trade.market = marketId.toString();
  trade.outcome = event.params.outcomeId;
  trade.tick = priceTick;
  trade.amount = event.params.tokensSold;
  trade.cost = event.params.collateralReceived;
  trade.tradeType = 'MarketOrder';
  trade.sellTrader = user.id;
  trade.avgPrice = event.params.avgPrice;
  trade.timestamp = event.block.timestamp;
  trade.blockNumber = event.block.number;
  trade.transactionHash = event.transaction.hash;
  trade.save();

  // Create per-participant Fill entity
  let fill = new Fill(baseId);
  fill.market = marketId.toString();
  fill.outcome = event.params.outcomeId;
  fill.side = 'SELL';
  fill.tick = priceTick;
  fill.amount = event.params.tokensSold;
  fill.cost = event.params.collateralReceived;
  fill.fees = BigInt.fromI32(0); // Fees tracked separately
  fill.trader = user.id;
  fill.tradeType = 'MarketOrder';
  fill.avgPrice = event.params.avgPrice;
  fill.timestamp = event.block.timestamp;
  fill.blockNumber = event.block.number;
  fill.transactionHash = event.transaction.hash;
  fill.save();

  // Update market price from market sell
  if (!tickSize.isZero()) {
    if (event.params.outcomeId.equals(BigInt.fromI32(0))) {
      market.lastPriceTick_0 = priceTick;
      market.lastTradeTimestamp_0 = event.block.timestamp;
    } else if (event.params.outcomeId.equals(BigInt.fromI32(1))) {
      market.lastPriceTick_1 = priceTick;
      market.lastTradeTimestamp_1 = event.block.timestamp;
    }
    market.lastTradeTimestamp = event.block.timestamp;
    market.lastTradeOutcome = event.params.outcomeId.toI32();
  }

  // Track unique trader
  trackUniqueTrader(market, user.id, event.block.timestamp);

  // Update trader position (market sell: tokens sold → collateral received)
  updateTraderPosition(
    user.id, marketId.toString(), event.params.outcomeId,
    'SELL', event.params.tokensSold, event.params.collateralReceived,
    event.block.timestamp,
  );

  // Update market statistics
  market.totalVolume = market.totalVolume.plus(event.params.tokensSold);
  market.save();

  // Update venue statistics
  let sellVenue = Venue.load(market.venue);
  if (sellVenue != null) {
    sellVenue.totalVolume = sellVenue.totalVolume.plus(event.params.tokensSold);
    sellVenue.updatedAt = event.block.timestamp;
    sellVenue.save();
  }

  // Update user statistics
  user.totalVolume = user.totalVolume.plus(event.params.tokensSold);
  user.totalTradeCount = user.totalTradeCount.plus(BigInt.fromI32(1));
  user.save();

  // Update protocol statistics
  let protocol = getOrCreateProtocol();
  protocol.totalVolume = protocol.totalVolume.plus(
    event.params.tokensSold,
  );
  protocol.updatedAt = event.block.timestamp;
  protocol.save();

  log.info(
    'MarketSellExecuted: seller={}, market={}, outcome={}, sold={}, received={}',
    [
      event.params.seller.toHexString(),
      marketId.toString(),
      event.params.outcomeId.toString(),
      event.params.tokensSold.toString(),
      event.params.collateralReceived.toString(),
    ],
  );
}

// ============================================
// Resolution
// ============================================

export function handleAssertionCreated(event: AssertionCreated): void {
  let assertionId = event.params.assertionId;
  let questionId = event.params.questionId;

  // Load or create question
  let question = Question.load(questionId.toHexString());
  if (question == null) {
    // Question may not exist yet — create a stub
    question = new Question(questionId.toHexString());
    question.questionId = questionId;
    question.conditionId = Bytes.empty();
    question.ancillaryData = Bytes.empty();
    question.liveness = BigInt.fromI32(7200); // Default 2 hours
    question.requiredBond = BigInt.fromI32(0);
    question.currency = Bytes.empty();
    question.reward = BigInt.fromI32(0);
    question.resolved = false;
    question.createdAt = event.block.timestamp;
  }

  // Create assertion
  let assertion = new Assertion(assertionId.toHexString());
  assertion.assertionId = assertionId;
  assertion.question = questionId.toHexString();
  assertion.asserter = event.params.asserter; // Now directly from event
  assertion.proposedOutcome = event.params.outcome;
  assertion.settled = false;
  assertion.disputed = false;
  assertion.createdAt = event.block.timestamp;
  assertion.save();

  // Set this as the active assertion (locks the market)
  question.activeAssertion = assertionId.toHexString();
  question.save();

  log.info('Assertion created: assertionId={}, questionId={}, outcome={}', [
    assertionId.toHexString(),
    questionId.toHexString(),
    event.params.outcome,
  ]);
}

export function handleAssertionSettled(event: AssertionSettled): void {
  let assertionId = event.params.assertionId;
  let assertion = Assertion.load(assertionId.toHexString());

  if (assertion == null) {
    log.warning('Assertion {} not found in AssertionSettled event', [
      assertionId.toHexString(),
    ]);
    return;
  }

  assertion.settled = true;
  assertion.result = event.params.result;
  assertion.settledAt = event.block.timestamp;
  assertion.save();

  let question = Question.load(assertion.question);
  if (question != null) {
    if (event.params.result) {
      // Assertion accepted — resolve question
      question.resolved = true;
      question.outcome = assertion.proposedOutcome;
      question.resolvedAt = event.block.timestamp;
    } else {
      // Assertion rejected — clear active assertion, allow re-assertion
      question.activeAssertion = null;
    }
    question.save();
  }

  log.info('Assertion settled: assertionId={}, result={}', [
    assertionId.toHexString(),
    event.params.result ? 'accepted' : 'rejected',
  ]);
}

export function handleAssertionDisputed(event: AssertionDisputed): void {
  let assertionId = event.params.assertionId;
  let assertion = Assertion.load(assertionId.toHexString());

  if (assertion == null) {
    log.warning('Assertion {} not found in AssertionDisputed event', [
      assertionId.toHexString(),
    ]);
    return;
  }

  assertion.disputed = true;
  assertion.save();

  log.info('Assertion disputed: assertionId={}', [
    assertionId.toHexString(),
  ]);
}

export function handleRewardPaid(event: RewardPaid): void {
  let assertionId = event.params.assertionId;
  let assertion = Assertion.load(assertionId.toHexString());

  if (assertion == null) {
    log.warning('Assertion {} not found in RewardPaid event', [
      assertionId.toHexString(),
    ]);
    return;
  }

  assertion.rewardPaid = event.params.reward;
  assertion.rewardRecipient = event.params.asserter;
  assertion.save();

  log.info('Reward paid: assertionId={}, asserter={}, reward={}', [
    assertionId.toHexString(),
    event.params.asserter.toHexString(),
    event.params.reward.toString(),
  ]);
}

export function handleMarketResolved(event: MarketResolved): void {
  let marketId = event.params.marketId;
  let market = Market.load(marketId.toString());

  if (market == null) {
    log.warning('Market {} not found in MarketResolved event', [
      marketId.toString(),
    ]);
    return;
  }

  // Determine resolved outcome index from outcome string
  let outcomes = market.outcomes;
  let outcomeIndex: i32 = -1;
  for (let i = 0; i < outcomes.length; i++) {
    if (outcomes[i] == event.params.outcome) {
      outcomeIndex = i;
      break;
    }
  }

  // Check if market was active before resolution
  let wasActive = market.status == 'Active';

  market.status = 'Resolved';
  if (outcomeIndex >= 0) {
    market.resolvedOutcome = outcomeIndex;
  }
  market.resolvedAt = event.block.timestamp;
  market.save();

  // Update venue statistics (decrease active markets only if market was Active)
  if (wasActive) {
    let venue = Venue.load(market.venue);
    if (venue != null) {
      venue.activeMarkets = venue.activeMarkets.minus(BigInt.fromI32(1));
      venue.updatedAt = event.block.timestamp;
      venue.save();
    }
  }

  // Rotate the price market series' current pointer if this market was its current.
  if (market.priceSeries != null) {
    let series = PriceMarketSerie.load(market.priceSeries as string);
    if (series != null) {
      refreshSeriesCurrent(series, event.block.timestamp);
    }
  }

  log.info('Market {} resolved: outcome={}', [
    marketId.toString(),
    event.params.outcome,
  ]);
}

export function handleMarketGroupResolved(event: MarketGroupResolved): void {
  let groupId = event.params.groupId;
  let winningMarketId = event.params.winningMarketId;

  // Load market group
  let marketGroup = MarketGroup.load(groupId.toString());
  if (marketGroup == null) {
    log.warning('MarketGroup {} not found in MarketGroupResolved event', [
      groupId.toString(),
    ]);
    return;
  }

  marketGroup.status = 'Resolved';
  marketGroup.resolvedMarketId = winningMarketId;
  marketGroup.resolvedAt = event.block.timestamp;
  marketGroup.save();

  log.info('MarketGroup {} resolved: winning market={}', [
    groupId.toString(),
    winningMarketId.toString(),
  ]);
}

// ============================================
// NegRisk
// ============================================

export function handleWrappedCollateralRegistered(
  event: WrappedCollateralRegistered,
): void {
  log.info('Wrapped collateral registered: underlying={}, wrapped={}', [
    event.params.underlyingCollateral.toHexString(),
    event.params.wrappedCollateral.toHexString(),
  ]);
}

// ============================================
// Tags
// ============================================

export function handleMarketTagsUpdated(event: MarketTagsUpdated): void {
  let marketId = event.params.marketId;
  let market = Market.load(marketId.toString());

  if (market == null) {
    log.warning('Market {} not found in MarketTagsUpdated event', [
      marketId.toString(),
    ]);
    return;
  }

  market.tags = decodeTags(event.params.tags);
  market.save();

  // Reconcile series membership in case the series tag was added, changed, or removed.
  reconcileMarketSeries(market, event.block.timestamp);

  log.info('Market {} tags updated', [marketId.toString()]);
}

export function handleMarketGroupTagsUpdated(
  event: MarketGroupTagsUpdated,
): void {
  let groupId = event.params.groupId;
  let marketGroup = MarketGroup.load(groupId.toString());

  if (marketGroup == null) {
    log.warning('MarketGroup {} not found in MarketGroupTagsUpdated event', [
      groupId.toString(),
    ]);
    return;
  }

  let newTags = decodeTags(event.params.tags);
  marketGroup.tags = newTags;
  marketGroup.save();

  log.info('MarketGroup {} tags updated', [groupId.toString()]);
}

// ============================================
// Metadata (MetadataFacet)
// ============================================

export function handleMarketMetadataUpdated(
  event: MarketMetadataUpdated,
): void {
  let marketId = event.params.marketId;
  let market = Market.load(marketId.toString());

  if (market == null) {
    log.warning('Market {} not found in MarketMetadataUpdated event', [
      marketId.toString(),
    ]);
    return;
  }

  market.metadataURI = event.params.metadataURI;
  market.save();

  log.info('Market {} metadata updated', [marketId.toString()]);
}

export function handleMarketGroupMetadataUpdated(
  event: MarketGroupMetadataUpdated,
): void {
  let groupId = event.params.groupId;
  let marketGroup = MarketGroup.load(groupId.toString());

  if (marketGroup == null) {
    log.warning(
      'MarketGroup {} not found in MarketGroupMetadataUpdated event',
      [groupId.toString()],
    );
    return;
  }

  marketGroup.metadataURI = event.params.metadataURI;
  marketGroup.save();

  log.info('MarketGroup {} metadata updated', [groupId.toString()]);
}

// ============================================
// Access Control
// ============================================

export function handleAccessControlDeployed(
  event: AccessControlDeployed,
): void {
  let acContract = new AccessControlContract(
    event.params.acContract.toHexString(),
  );
  acContract.deployer = event.params.deployer;
  acContract.acType = event.params.acType;
  acContract.deployedAt = event.block.timestamp;
  acContract.save();

  log.info('AccessControl deployed: type={}, contract={}, deployer={}', [
    event.params.acType,
    event.params.acContract.toHexString(),
    event.params.deployer.toHexString(),
  ]);
}

export function handleMarketTradingAccessControlSet(
  event: MarketTradingAccessControlSet,
): void {
  let marketId = event.params.marketId;
  let id = marketId.toString();

  let mac = MarketAccessControl.load(id);
  if (mac == null) {
    mac = new MarketAccessControl(id);
    mac.market = id;
  }

  mac.tradingAccessControl = event.params.acContract;
  mac.updatedAt = event.block.timestamp;
  mac.save();

  log.info('Market {} trading AC set: {}', [
    id,
    event.params.acContract.toHexString(),
  ]);
}

export function handleMarketTradingAccessControlRemoved(
  event: MarketTradingAccessControlRemoved,
): void {
  let marketId = event.params.marketId;
  let id = marketId.toString();

  let mac = MarketAccessControl.load(id);
  if (mac == null) {
    log.warning(
      'MarketAccessControl {} not found in MarketTradingAccessControlRemoved',
      [id],
    );
    return;
  }

  mac.tradingAccessControl = Address.zero();
  mac.updatedAt = event.block.timestamp;
  mac.save();

  log.info('Market {} trading AC removed', [id]);
}

// ============================================================
// Vault: user-initiated split / merge
// ============================================================

/**
 * User split collateral into YES+NO tokens directly via VaultFacet.splitPosition.
 * Model as two BUY position updates (outcome 0 and 1), each assigned half the cost.
 */
export function handlePositionSplit(event: PositionSplit): void {
  let trader = event.params.trader.toHexString();
  let marketId = event.params.marketId.toString();
  let amount = event.params.amount;
  let half = amount.div(BigInt.fromI32(2));
  let otherHalf = amount.minus(half);

  getOrCreateUser(event.params.trader, event.block.timestamp);

  updateTraderPosition(trader, marketId, BigInt.fromI32(0), 'BUY', amount, half, event.block.timestamp);
  updateTraderPosition(trader, marketId, BigInt.fromI32(1), 'BUY', amount, otherHalf, event.block.timestamp);

  log.info('PositionSplit: trader {} market {} amount {}', [trader, marketId, amount.toString()]);
}

/**
 * User merged YES+NO tokens back into collateral via VaultFacet.mergePositions.
 * Model as two SELL position updates (outcome 0 and 1), each receiving half the proceeds.
 */
export function handlePositionsMerged(event: PositionsMerged): void {
  let trader = event.params.trader.toHexString();
  let marketId = event.params.marketId.toString();
  let amount = event.params.amount;
  let half = amount.div(BigInt.fromI32(2));
  let otherHalf = amount.minus(half);

  getOrCreateUser(event.params.trader, event.block.timestamp);

  updateTraderPosition(trader, marketId, BigInt.fromI32(0), 'SELL', amount, half, event.block.timestamp);
  updateTraderPosition(trader, marketId, BigInt.fromI32(1), 'SELL', amount, otherHalf, event.block.timestamp);

  log.info('PositionsMerged: trader {} market {} amount {}', [trader, marketId, amount.toString()]);
}

// ============================================
// CTF Contract Events (ConditionalTokens data source)
// ============================================

export function handlePayoutRedemption(event: PayoutRedemption): void {
  let conditionId = event.params.conditionId;
  let redeemer = event.params.redeemer.toHexString();
  let payout = event.params.payout;

  // Look up market from conditionId
  let conditionMarket = ConditionMarket.load(conditionId);
  if (conditionMarket == null) {
    log.info('PayoutRedemption: unknown conditionId {}, skipping', [conditionId.toHexString()]);
    return;
  }

  let marketId = conditionMarket.marketId;

  getOrCreateUser(event.params.redeemer, event.block.timestamp);
  redeemTraderPosition(redeemer, marketId, payout, event.block.timestamp);

  log.info('PayoutRedemption: redeemer {} market {} payout {}', [redeemer, marketId, payout.toString()]);
}

// ============================================
// Price Market (Pyth) Handlers
// ============================================

export function handlePriceMarketCreatedPyth(event: PriceMarketCreatedPyth): void {
  let marketId = event.params.marketId;
  let market = Market.load(marketId.toString());
  if (market == null) {
    log.warning('Market {} not found for PriceMarketCreatedPyth', [marketId.toString()]);
    return;
  }

  // Flag market as price market
  market.isPriceMarket = true;

  // Create PriceMarket overlay entity
  let pm = new PriceMarket(marketId.toString());
  pm.market = marketId.toString();
  pm.provider = 'pyth';
  pm.feedId = event.params.pythFeedId;
  pm.strikePrice = event.params.strikePrice;
  pm.priceExpo = event.params.priceExpo;
  pm.openTime = event.params.openTime;
  pm.closeTime = event.params.closeTime;
  pm.resolutionWindow = event.params.resolutionWindow;

  // openPriceTime is not in the event; read it from the diamond.
  // Returns 0 for strike markets (explicit strike, no VAA captured).
  let diamond = OddMaki.bind(event.address);
  let pmCall = diamond.try_getPriceMarket(marketId);
  if (pmCall.reverted) {
    log.warning('getPriceMarket reverted for market {}, defaulting openPriceTime to 0', [
      marketId.toString(),
    ]);
    pm.openPriceTime = BigInt.zero();
  } else {
    pm.openPriceTime = pmCall.value.getOpenPriceTime();
  }

  pm.resolved = false;
  pm.save();

  market.priceMarket = pm.id;
  market.save();

  // Now that closeTime is set, recompute the series' currentMarket if this market
  // belongs to one. MarketCreated already registered membership; this is the first
  // moment we can correctly order by closeTime.
  if (market.priceSeries != null) {
    let series = PriceMarketSerie.load(market.priceSeries as string);
    if (series != null) {
      refreshSeriesCurrent(series, event.block.timestamp);
    }
  }

  log.info('PriceMarketCreatedPyth: market {} feed {} strikePrice {} closeTime {}', [
    marketId.toString(),
    event.params.pythFeedId.toHexString(),
    event.params.strikePrice.toString(),
    event.params.closeTime.toString(),
  ]);
}

export function handlePriceMarketResolvedPyth(event: PriceMarketResolvedPyth): void {
  let marketId = event.params.marketId;
  let pm = PriceMarket.load(marketId.toString());
  if (pm == null) {
    log.warning('PriceMarket {} not found for PriceMarketResolvedPyth', [marketId.toString()]);
    return;
  }

  pm.finalPrice = event.params.finalPrice;
  pm.outcome = event.params.outcome;
  pm.resolved = true;
  pm.resolvedAt = event.block.timestamp;
  pm.save();

  log.info('PriceMarketResolvedPyth: market {} finalPrice {} outcome {}', [
    marketId.toString(),
    event.params.finalPrice.toString(),
    event.params.outcome,
  ]);
}

export function handleOpenMaxStalenessUpdated(event: OpenMaxStalenessUpdated): void {
  let value = event.params.openMaxStaleness;
  let timestamp = event.block.timestamp;
  let blockNumber = event.block.number;

  let config = OpenMaxStalenessConfig.load('current');
  if (config == null) {
    config = new OpenMaxStalenessConfig('current');
  }
  config.value = value;
  config.updatedAt = timestamp;
  config.updatedAtBlock = blockNumber;
  config.save();

  let updateId =
    event.transaction.hash.toHexString() + '-' + event.logIndex.toString();
  let update = new OpenMaxStalenessUpdate(updateId);
  update.value = value;
  update.updatedAt = timestamp;
  update.updatedAtBlock = blockNumber;
  update.tx = event.transaction.hash;
  update.save();

  log.info('OpenMaxStalenessUpdated: value {} at block {}', [
    value.toString(),
    blockNumber.toString(),
  ]);
}
