# The Graph Network Deployment — R&D

> Step-by-step assessment for migrating the OddMaki subgraph from **Subgraph Studio**
> to **The Graph Network** (the decentralized, GRT-based network).

Audience: protocol engineers preparing OddMaki for production.
Scope: Base Mainnet. The Studio testnet deployment on Base Sepolia stays as-is.

---

## 1. TL;DR

- The subgraph is **technically compatible** with The Graph Network — no unsupported
  features, no IPFS file data sources, no substreams, no non-deterministic mapping logic.
- Base Mainnet is a **fully supported chain** on the decentralized network (indexing rewards
  + query fees + arbitration). Base Sepolia is **not** — testnets stay in Studio.
- The publish transaction happens on **Arbitrum One**. It requires the owner wallet to hold
  **ETH on Arbitrum** (gas) and, if we want Indexers to pick us up quickly,
  **≥ 3,000 GRT on Arbitrum** for curation signal (plus a 1% curation tax).
- Blockers before we can publish:
  1. `subgraph.base.yaml` does not exist (the `deploy-base` script expects it).
  2. `networks.json` `base` section has placeholder contract addresses.
  3. Base Mainnet `startBlock` is not captured anywhere.
  4. Owner wallet strategy for the subgraph NFT is not decided.
  5. Treasury/budget for curation signal and ongoing query payments is not decided.
- Once (1)–(3) are resolved the publish flow itself is a ~15-minute operation: build,
  deploy to Studio, press "Publish", sign two Arbitrum transactions, optionally signal GRT.

---

## 2. What "The Graph Network" actually is

Studio and Network are **two different products** with overlapping tooling:

| | Subgraph Studio | The Graph Network |
|---|---|---|
| Who indexes | Single "upgrade indexer" run by Edge & Node | Any Indexer who decides your subgraph is worth it (incentivised by GRT rewards + query fees) |
| Query URL | `https://api.studio.thegraph.com/query/<NUM>/<slug>/<version>` | `https://gateway.thegraph.com/api/<API_KEY>/subgraphs/id/<SUBGRAPH_ID>` |
| Payment | Free, rate-limited, non-production | 100k free queries / month, then pay-per-query (credit card or GRT on Arbitrum) |
| Identity | Deploy key + slug | ERC-721 subgraph NFT minted on Arbitrum One, owned by the publisher wallet |
| Versioning | `--version-label vX.Y.Z` | Each new version is a new IPFS deployment hash bound to the NFT; curators can auto-migrate or pin a specific version |
| Supported chains | Broad | Narrower — governed by the [feature support matrix](https://github.com/graphprotocol/indexer/blob/main/docs/feature-support-matrix.md) |

Publishing does **not** move the subgraph out of Studio — the Studio deployment remains
as a staging / upgrade path. Publish mints an on-chain record that points at the same
IPFS build, so other Indexers can pick it up.

---

## 3. Current state of this repo

Snapshot as of `v0.14.0` (commit `ca16cce`, April 2026):

- `@graphprotocol/graph-cli@^0.98.1`, `@graphprotocol/graph-ts@^0.38.2`, `pnpm@10.13.1`
- Manifests: `subgraph.base-sepolia.yaml` (live on Studio), `subgraph.yaml` (local template)
- Schema: 21 entities, event-sourced, 8 immutable / 13 mutable
- Mappings: single `src/mapping.ts` (~2.2k lines, AssemblyScript)
- CI: `.github/workflows/deploy.yml` deploys via `workflow_dispatch` and tags
  `deploy/<network>/vX.Y.Z` on success
- README "Networks" table marks Base Mainnet as **Pending**

### Features used in the manifest

| Manifest feature | Used? | Network-supported? |
|---|---|---|
| `specVersion: 0.0.5` | Yes | Yes |
| `ethereum/events` data source | Yes (2 sources) | Yes |
| `apiVersion: 0.0.7` | Yes | Yes |
| Grafting | No | Yes (if we ever add it) |
| Non-fatal errors | No | Yes |
| File data sources (IPFS / Arweave) | No | Yes |
| Full-text search | No | **No indexing rewards** — avoid |
| IPFS mapping operations (`ipfs.cat`, `ipfs.map`) | No | **No indexing rewards** — avoid |
| Substreams | No | Yes (mainnet / Optimism) |

Conclusion: nothing in the manifest disqualifies us from indexing rewards.

---

## 4. Chain support

From [The Graph feature support matrix](https://github.com/graphprotocol/indexer/blob/main/docs/feature-support-matrix.md):

- **Base Mainnet** (`eip155:8453`) — indexing rewards + query fees + arbitration: **Yes**
- **Base Sepolia** — not on the decentralized network; stays in Studio for testing

We only publish the **Base Mainnet** deployment to the network.

---

## 5. What we're missing (pre-publish checklist)

### 5.1 Repo-level gaps

- [ ] **`subgraph.base.yaml`** — does not exist. `package.json` line 13 already expects
      it (`pnpm run deploy-base`). Create it from `subgraph.base-sepolia.yaml` with:
  - `network: base`
  - real mainnet OddMaki Diamond address
  - real mainnet ConditionalTokens address
  - Base Mainnet `startBlock` (earliest of Diamond-deployed block and CTF-deployed block)
- [ ] **`networks.json`** — the `base` section has zero-address placeholders.
      Populate with real mainnet contract addresses so
      `graph-cli` can sanity-check the manifest.
- [ ] **README networks table** — flip Base Mainnet from `Pending` to `Deployed` only after
      the publish succeeds.
- [ ] **Contract deployment** — confirm OddMaki Diamond and ConditionalTokens are actually
      deployed on Base Mainnet. Without those we can't populate (1) or (2).

### 5.2 Off-repo gaps

- [ ] **Owner wallet decision** — the subgraph NFT lives on Arbitrum One and governs
      future publishes, transfers and deprecation. Options:
  - A single EOA (fast, risky for a production resource).
  - A multisig (Gnosis Safe on Arbitrum One). **Recommended** for anything production.
  - Important: the wallet that publishes is the owner. Plan this *before* the first
    publish — transferring later is possible but costs gas and creates an audit event.
- [ ] **ETH on Arbitrum One** — publish + (optional) signal are two separate transactions.
      Budget a small amount (low single-digit USD at typical Arbitrum gas prices).
- [ ] **GRT on Arbitrum One** — curation signal is optional but strongly recommended.
      The docs recommend ≥ 3,000 GRT to attract ~3 Indexers, with a 1% curation tax.
- [ ] **Billing plan** — decide whether queries will be paid via credit card (Stripe,
      monthly invoice) or GRT on Arbitrum. The gateway bills per API key; 100k queries/mo
      are free.
- [ ] **Production API key** — created in Studio → API Keys. Needs spending cap and domain
      / subgraph restrictions before being embedded in any frontend.
- [ ] **Subgraph metadata** — display name, description, image, website, categories, source
      code link. These are signed into the publish transaction and are what curators /
      indexers see in Graph Explorer. Prepare them in Studio before pressing Publish.

### 5.3 Operational gaps

- [ ] **Upgrade policy** — who bumps versions, and do we want curators auto-migrating or
      pinning? Default "auto-migrate" is friendliest for consumers; pinning gives us the
      ability to stage breaking schema changes.
- [ ] **Monitoring** — who watches indexing progress, error rates, and the query volume on
      the gateway once we're live?
- [ ] **Runbook for a bad deploy** — if a published version has a mapping bug we can't
      un-publish, we can only push a new version. The rollback = "publish the previous
      good IPFS hash as a new version". Document this.

---

## 6. Step-by-step deployment plan

### Phase 0 — preconditions (off-repo)

1. Deploy OddMaki Diamond + ConditionalTokens to **Base Mainnet**. Record the two
   addresses and the earliest deployment block.
2. Decide owner wallet. If multisig, deploy the Safe on Arbitrum One **before** the
   publish — the wallet that signs the publish transaction becomes the NFT owner.
3. Fund the owner wallet with ETH (for gas) and, if we're signalling, GRT on Arbitrum One.
   GRT can be bridged from Ethereum Mainnet via the Arbitrum Bridge or acquired on
   Uniswap / Coinbase / Binance.

### Phase 1 — prepare the repo

4. Create `subgraph.base.yaml`:
   - Copy `subgraph.base-sepolia.yaml`.
   - Replace `network: base-sepolia` with `network: base` in both data sources.
   - Replace both `address:` fields with the real Base Mainnet addresses from step 1.
   - Replace both `startBlock:` values with the real mainnet deployment block.
5. Update `networks.json` `base` section with the same addresses (keeps
   `graph build` consistent).
6. `pnpm install && pnpm codegen && pnpm build subgraph.base.yaml` locally to confirm the
   manifest compiles and ABIs resolve.
7. Open a PR. Review the diff — especially addresses and startBlock — because these are
   impossible to change after publish without re-deploying.

### Phase 2 — deploy to Studio (staging)

8. Make sure a Base-Mainnet-targeted Studio subgraph exists. If Studio currently has a
   `base-sepolia`-targeted subgraph under the slug `oddmaki`, create a new Studio
   subgraph slug (e.g. `oddmaki` in the production Studio account) whose target chain
   is set to Base. Studio subgraphs are per-slug, and the slug is what the CLI
   authenticates against.
9. Authenticate the CLI against Studio with the production deploy key:
   ```bash
   graph auth <PRODUCTION_DEPLOY_KEY>
   ```
10. Deploy via the existing script (CI or local):
    ```bash
    VERSION=v1.0.0 pnpm run deploy-base
    ```
    This uploads the build to IPFS and registers the version in Studio.
11. Wait for Studio's upgrade indexer to fully sync. Spot-check the temporary Studio query
    URL against known-good on-chain events (first Venue, first Market, a known trade).
    **Do not proceed to publish until sync is clean** — you cannot un-publish, and every
    publish costs gas.

### Phase 3 — publish to the decentralized network

12. In Studio, open the subgraph dashboard → **Publish**. Connect the owner wallet.
    Alternatively, from the repo:
    ```bash
    graph publish subgraph.base.yaml \
      --protocol-network arbitrum-one
    ```
    (CLI ≥ 0.73.0 — we're on 0.98.1, so this works.) The CLI opens a browser window for
    wallet connection and metadata entry.
13. Fill in metadata: display name (`OddMaki Protocol`), description, image URL, website,
    source code URL, categories (DeFi / prediction-markets). Metadata is written to IPFS
    and referenced by the publish tx.
14. Sign two Arbitrum One transactions:
    - **Mint** the subgraph NFT (first-time publish only).
    - **Publish version** pointing the NFT at the IPFS deployment hash from Phase 2.
15. (Optional but recommended) Signal curation in the same flow: sign a third transaction
    that bonds GRT to the subgraph. 1% curation tax applies. ≥ 3,000 GRT is the docs-
    recommended minimum to attract ~3 Indexers.

### Phase 4 — go-live

16. Create the production API key in Studio → **API Keys → Create API Key**:
    - Set a monthly USD spending cap.
    - Under **Security**, restrict to authorised domains (e.g. `app.oddmaki.xyz`) and
      assign the subgraph so the key can't be used against unrelated subgraphs.
17. Construct the production query URL:
    ```
    https://gateway.thegraph.com/api/<API_KEY>/subgraphs/id/<SUBGRAPH_ID>
    ```
    `<SUBGRAPH_ID>` is the NFT ID returned by the publish transaction. Prefer bearer-token
    auth via the `Authorization` header for server-side consumers.
18. Swap the frontend / SDK / backend services off the Studio URL onto the gateway URL.
    Keep the Studio URL as a staging endpoint for future releases.
19. Fund the gateway billing balance (credit card or GRT on Arbitrum) once we're within
    sight of the 100k free-query monthly quota.
20. Update `README.md` → Base Mainnet status `Pending` → `Deployed`, add the subgraph ID
    and Graph Explorer URL.

### Phase 5 — ongoing operations

21. **New versions**: every `pnpm run deploy-base` produces a new IPFS build. To make it
    live on the decentralized network, run `graph publish` (or press Publish in Studio)
    again. Curators who signalled with auto-migrate follow automatically; pinned curators
    do not.
22. **Breaking schema changes**: publish as a new version but consider pinning curators
    to the previous version until consumers migrate.
23. **Rollback**: re-publish the previous good IPFS hash as a new version — there is no
    un-publish.
24. **Monitoring**: watch Graph Explorer for indexer count, allocation size, query volume
    per API key, and indexing error rates.

---

## 7. Risks and open questions

- **Address immutability** — the data-source address in the manifest cannot be changed
  after the subgraph is deployed to that version. A Diamond facet upgrade does not change
  the Diamond proxy address, so we're fine as long as we index the proxy (we do). A full
  proxy migration would require a new subgraph version and, if the new proxy is deployed
  at a new block, a new `startBlock`.
- **Grafting readiness** — if we ever need to retroactively fix historical data, we'd graft
  onto a healthy block. The network supports grafting, but it's worth verifying grafting
  eligibility *before* the first production incident.
- **Arbitrum ownership** — losing the key of the owner wallet means losing the ability to
  publish new versions. Multisig strongly recommended.
- **Deploy key rotation** — the Studio deploy key used by CI also gates publishes (via
  Studio's Publish button). If we rotate it, update the `GRAPH_DEPLOY_KEY` secret in the
  GitHub environment for the `base` target.
- **Indexer incentives** — without signal, the Sunrise upgrade indexer covers us but query
  latency and redundancy may suffer. Signal before we cut over production traffic.
- **Query cost at scale** — model expected monthly query volume against the gateway's
  per-query price. 100k free may be consumed quickly once the frontend and any public
  integrations are live.
- **Feature drift** — if we ever add `fullTextSearch` or `ipfs.cat` / `ipfs.map`, we lose
  indexing rewards. Keep the mapping deterministic and event-sourced.

---

## 8. References

- [Publishing a Subgraph to the Decentralized Network](https://thegraph.com/docs/en/subgraphs/developing/publishing/publishing-a-subgraph/)
- [Subgraph Quick Start](https://thegraph.com/docs/en/subgraphs/quick-start/)
- [Billing](https://thegraph.com/docs/en/subgraphs/billing/)
- [Managing API Keys](https://thegraph.com/docs/en/subgraphs/querying/managing-api-keys/)
- [Supported Networks](https://thegraph.com/docs/en/supported-networks/)
- [Feature Support Matrix (indexer repo)](https://github.com/graphprotocol/indexer/blob/main/docs/feature-support-matrix.md)
- [How to Migrate Your Subgraph to the Decentralized Network (Graph blog)](https://medium.com/@graphprotocol/how-to-migrate-your-subgraph-to-the-decentralized-network-a-step-by-step-guide-1d3bb1ef653b)
