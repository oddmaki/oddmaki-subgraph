# OddMaki Subgraph

[The Graph](https://thegraph.com/) subgraph for the [OddMaki Protocol](https://github.com/oddmaki/oddmaki-core) — indexes all on-chain events from the Diamond proxy into a queryable GraphQL API.

## Entities

| Entity | Description |
|---|---|
| `Venue` | Venue configuration, fees, access control, statistics |
| `Market` | Market lifecycle, outcomes, pricing, resolution |
| `MarketGroup` | Mutually exclusive market bundles (neg-risk) |
| `Order` | Limit orders with status tracking |
| `Trade` | Market-level trade events (fills, mints, merges, market orders) |
| `Fill` | Per-participant fill records with cost and fees |
| `TraderPosition` | Position tracking with P&L (entry price, realized P&L) |
| `TopOfBook` | Best bid/ask per outcome |
| `Question` / `Assertion` | UMA oracle resolution lifecycle |
| `PriceMarket` | Pyth price feed market overlay |
| `Protocol` | Protocol-wide aggregate statistics |
| `VenueDailySnapshot` | Daily venue analytics |

See [schema.graphql](./schema.graphql) for the full schema and [QUERIES.md](./QUERIES.md) for example queries.

## Networks

| Network | Manifest | Status |
|---|---|---|
| Base Sepolia | `subgraph.base-sepolia.yaml` | Deployed |
| Base Mainnet | `subgraph.yaml` | Pending |

See [docs/the-graph-network-deployment.md](./docs/the-graph-network-deployment.md) for the plan to publish to The Graph Network (GRT).

## Development

```bash
pnpm install
pnpm run codegen
pnpm run build
```

### Local Development (Anvil + Graph Node)

```bash
# Start Graph Node
pnpm run graph-node:up

# Deploy subgraph locally
pnpm run codegen && pnpm run build
pnpm run create-local && pnpm run deploy-local

# Query at http://localhost:8900/subgraphs/name/octopus-core/graphql
```

### Deploy to The Graph Studio

```bash
# Authenticate (one-time)
graph auth --studio <DEPLOY_KEY>

# Deploy to Base Sepolia
pnpm run deploy-base-sepolia

# Deploy to Base Mainnet
pnpm run deploy-base
```

## Related

- [oddmaki-core](https://github.com/oddmaki/oddmaki-core) — Smart contracts
- [oddmaki-sdk](https://github.com/oddmaki/oddmaki-sdk) — TypeScript SDK
- [oddmaki-venue-starter](https://github.com/oddmaki/oddmaki-venue-starter) — Venue starter template

## License

[MIT](./LICENSE)
