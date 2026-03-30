# OddMaki Subgraph Queries

A collection of GraphQL queries for the OddMaki Protocol subgraph. Use these in your frontend application or in the [Subgraph Studio Playground](https://thegraph.com/studio/subgraph/oddmaki/playground).

## Table of Contents

- [Basic Data](#basic-data) (Venues, Markets, Orders)
- [Filtering & Searching](#filtering--searching)
- [User Activity](#user-activity)
- [Statistics & Analytics](#statistics--analytics)
- [Advanced Patterns](#advanced-patterns)

---

## Basic Data

### Get All Venues
Retrieve a list of all venues with their basic configuration.

```graphql
query GetVenues {
  venues(first: 100) {
    id
    name
    operator
    totalMarkets
    venueFeeBps
    creatorFeeBps
  }
}
```

### Get Markets for a Venue
Fetch all markets belonging to a specific venue.

```graphql
query GetVenueMarkets($venueId: ID!) {
  venue(id: $venueId) {
    name
    markets(orderBy: createdAt, orderDirection: desc) {
      id
      question
      status
      outcomes
      totalVolume
    }
  }
}
```

### Get Market Details
Get comprehensive details for a single market, including its current status and resolution data.

```graphql
query GetMarketDetails($marketId: ID!) {
  market(id: $marketId) {
    question
    outcomes
    status
    collateralToken
    tickSize
    tags
    creator {
      id
    }
    venue {
      name
    }
    # Pricing
    lastPriceTick_0
    lastPriceTick_1
    lastTradeTimestamp
    # Resolution info
    resolvedOutcome
    resolvedAt
  }
}
```

### Get Order Book (Active Orders)
Retrieve active buy and sell orders for a market, sorted by price (tick).

```graphql
query GetOrderBook($marketId: ID!) {
  market(id: $marketId) {
    orders(
      where: { status: Active }
      orderBy: tick
      orderDirection: desc
    ) {
      id
      side      # BUY or SELL
      outcome   # Outcome index
      tick      # Price
      amount    # Initial amount
      filled    # Amount filled
      trader {
        id
      }
    }
  }
}
```

---

## Filtering & Searching

### Find Active Markets
Get only markets that are currently active (not resolved or invalid).

```graphql
query GetActiveMarkets {
  markets(where: { status: Active }) {
    id
    question
    totalVolume
    createdAt
  }
}
```

### Filter Orders by Trader
See all orders placed by a specific address.

```graphql
query GetUserOrders($userAddress: Bytes!) {
  orders(
    where: { trader: $userAddress }
    orderBy: createdAt
    orderDirection: desc
  ) {
    market {
      question
    }
    side
    outcome
    amount
    status
  }
}
```

---

## User Activity

### User Profile & Stats
Get high-level statistics for a user.

```graphql
query GetUserProfile($userId: ID!) {
  user(id: $userId) {
    totalOrdersPlaced
    totalVolume
    totalMarkets
    totalTradeCount
    totalRealizedPnL
    firstSeenAt
    lastSeenAt
  }
}
```

### User Trade History
Retrieve all fills (trade executions) for a user.

```graphql
query GetUserFills($userAddress: ID!) {
  user(id: $userAddress) {
    fills(orderBy: timestamp, orderDirection: desc, first: 50) {
      market {
        question
      }
      outcome
      side
      amount
      cost
      tick
      tradeType
      timestamp
    }
  }
}
```

### User Positions
Get open positions with P&L data.

```graphql
query GetUserPositions($userAddress: ID!) {
  traderPositions(
    where: { trader: $userAddress, quantity_gt: 0 }
    orderBy: lastTradeAt
    orderDirection: desc
  ) {
    market {
      question
      status
    }
    outcome
    quantity
    avgEntryPrice
    totalCostBasis
    realizedPnL
  }
}
```

---

## Statistics & Analytics

### Protocol Global Stats
Get total volume, fees, and usage counts for the entire protocol.

```graphql
query GetProtocolStats {
  protocol(id: "1") {
    totalVenues
    totalMarkets
    totalMarketGroups
    totalVolume
    totalFees
    totalUsers
  }
}
```

### Daily Venue Metrics
View daily volume and fee trends for a venue.

```graphql
query GetVenueDailyStats($venueId: ID!) {
  venueDailySnapshots(
    where: { venue: $venueId }
    orderBy: timestamp
    orderDirection: desc
  ) {
    timestamp
    dailyVolume
    dailyFees
    dailyActiveUsers
    cumulativeVolume
  }
}
```

### Top Markets by Volume
Find the most popular markets.

```graphql
query GetTopMarkets {
  markets(
    orderBy: totalVolume
    orderDirection: desc
    first: 5
  ) {
    question
    totalVolume
    totalFees
    uniqueTraders
  }
}
```

### Leaderboard
Top traders by volume or realized P&L.

```graphql
query GetLeaderboard {
  users(
    orderBy: totalVolume
    orderDirection: desc
    first: 20
  ) {
    id
    totalVolume
    totalTradeCount
    totalRealizedPnL
  }
}
```

---

## Advanced Patterns

### Market Depth / Top of Book
Efficiently get the best available price for each outcome in a market.

```graphql
query GetTopOfBook($marketId: ID!) {
  topOfBooks(where: { market: $marketId }) {
    outcome
    side
    topTick
    updatedAt
  }
}
```

### Full Market Audit
Retrieve all critical events (trades, fees) for a market to audit its history.

```graphql
query AuditMarket($marketId: ID!) {
  market(id: $marketId) {
    question
    trades(orderBy: timestamp, orderDirection: asc) {
      id
      tradeType
      outcome
      amount
      tick
      cost
      buyTrader { id }
      sellTrader { id }
      timestamp
      transactionHash
    }
    fees(orderBy: timestamp, orderDirection: asc) {
      totalFees
      protocolFee
      venueFee
      creatorFee
      operatorFee
    }
  }
}
```

### Market Group with Markets
Get a market group and all its child markets.

```graphql
query GetMarketGroup($groupId: ID!) {
  marketGroup(id: $groupId) {
    marketQuestion
    status
    totalMarkets
    activeMarketCount
    tags
    markets {
      id
      question
      status
      lastPriceTick_0
      marketGroupItem {
        marketName
        isPlaceholder
      }
    }
  }
}
```
