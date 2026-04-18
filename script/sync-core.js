#!/usr/bin/env node

// Syncs ABIs and deployment addresses from oddmaki-core into the subgraph.
//
// Usage:
//   node script/sync-core.js [options]
//
// Options:
//   --network <name>       Target network (default: base-sepolia)
//   --version <ver>        Deployment version, e.g. v0.12.1 (default: latest)
//   --start-block <n>      Override startBlock in subgraph YAML (keeps existing if omitted)
//   --core-path <path>     Path to oddmaki-core repo (default: ../oddmaki-core)
//
// Examples:
//   node script/sync-core.js
//   node script/sync-core.js --version v0.11.0
//   node script/sync-core.js --network base-sepolia --start-block 40000000
//   node script/sync-core.js --core-path ../../oddmaki-core

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    network: 'base-sepolia',
    version: 'latest',
    startBlock: null,
    corePath: path.resolve(ROOT, '..', 'oddmaki-core'),
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--network':
        opts.network = args[++i];
        break;
      case '--version':
        opts.version = args[++i];
        break;
      case '--start-block':
        opts.startBlock = Number(args[++i]);
        if (Number.isNaN(opts.startBlock)) {
          console.error('Error: --start-block must be a number');
          process.exit(1);
        }
        break;
      case '--core-path':
        opts.corePath = path.resolve(args[++i]);
        break;
      case '--help':
      case '-h':
        console.log(fs.readFileSync(__filename, 'utf8').match(/\/\/ Usage:[\s\S]*?\/\/ Examples:[\s\S]*?\n/)[0].replace(/^\/\/ ?/gm, ''));
        process.exit(0);
      default:
        console.error(`Unknown option: ${args[i]}`);
        process.exit(1);
    }
  }

  return opts;
}

// ---------------------------------------------------------------------------
// Read deployment
// ---------------------------------------------------------------------------

function readDeployment(corePath, network, version) {
  const filename = version === 'latest' ? 'latest.json' : `${version.startsWith('v') ? version : 'v' + version}.json`;
  const filePath = path.join(corePath, 'deployments', network, filename);

  if (!fs.existsSync(filePath)) {
    console.error(`Error: Deployment file not found at ${filePath}`);
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  console.log(`  Deployment: ${network} v${data.version} (${data.timestamp})`);
  return data;
}

// ---------------------------------------------------------------------------
// Merge facet ABIs
// ---------------------------------------------------------------------------

function mergeFacetAbis(corePath) {
  const outDir = path.join(corePath, 'out');

  if (!fs.existsSync(outDir)) {
    console.error(`Error: Foundry out/ directory not found at ${outDir}`);
    console.error('Run "forge build" in oddmaki-core first.');
    process.exit(1);
  }

  // Find all *Facet.sol directories
  const facetDirs = fs.readdirSync(outDir)
    .filter((name) => name.endsWith('Facet.sol'))
    .sort();

  if (facetDirs.length === 0) {
    console.error('Error: No facet artifacts found in out/');
    process.exit(1);
  }

  // Collect events and read-only (view/pure) functions from all facets,
  // deduplicate by signature. View/pure functions are included so subgraph
  // handlers can make contract reads (e.g., PriceMarketFacet.getPriceMarket).
  const seen = new Map(); // "type:signature" -> ABI entry

  for (const dir of facetDirs) {
    const jsonName = dir.replace('.sol', '.json');
    const artifactPath = path.join(outDir, dir, jsonName);

    if (!fs.existsSync(artifactPath)) continue;

    const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    const entries = (artifact.abi || []).filter((entry) =>
      entry.type === 'event' ||
      (entry.type === 'function' && (entry.stateMutability === 'view' || entry.stateMutability === 'pure'))
    );

    for (const entry of entries) {
      const sig = `${entry.type}:${entry.name}(${entry.inputs.map((i) => i.type).join(',')})`;
      if (!seen.has(sig)) {
        seen.set(sig, entry);
      }
    }
  }

  const merged = Array.from(seen.values()).sort((a, b) => {
    if (a.type !== b.type) return a.type.localeCompare(b.type);
    return a.name.localeCompare(b.name);
  });
  const eventCount = merged.filter((e) => e.type === 'event').length;
  const fnCount = merged.filter((e) => e.type === 'function').length;
  console.log(`  Merged ${eventCount} events + ${fnCount} view/pure functions from ${facetDirs.length} facets`);

  return merged;
}

// ---------------------------------------------------------------------------
// Update files
// ---------------------------------------------------------------------------

function writeAbi(abiPath, abi) {
  fs.writeFileSync(abiPath, JSON.stringify(abi, null, 2) + '\n');
  console.log(`  Updated ${path.relative(ROOT, abiPath)}`);
}

function updateNetworksJson(network, contracts) {
  const filePath = path.join(ROOT, 'networks.json');
  const networks = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  if (!networks[network]) {
    networks[network] = {};
  }

  networks[network].OddMaki = { address: contracts.OddMaki };
  networks[network].ConditionalTokens = { address: contracts.ConditionalTokens };

  fs.writeFileSync(filePath, JSON.stringify(networks, null, 2) + '\n');
  console.log(`  Updated networks.json [${network}]`);
}

function updateSubgraphYaml(network, contracts, startBlock) {
  const yamlName = network === 'localhost' ? 'subgraph.yaml' : `subgraph.${network}.yaml`;
  const yamlPath = path.join(ROOT, yamlName);

  if (!fs.existsSync(yamlPath)) {
    console.warn(`  Warning: ${yamlName} not found, skipping YAML update`);
    return;
  }

  let content = fs.readFileSync(yamlPath, 'utf8');

  // Update OddMaki address
  content = content.replace(
    /(name: OddMaki[\s\S]*?address: )"([^"]+)"/,
    `$1"${contracts.OddMaki}"`
  );

  // Update ConditionalTokens address
  content = content.replace(
    /(name: ConditionalTokens[\s\S]*?address: )"([^"]+)"/,
    `$1"${contracts.ConditionalTokens}"`
  );

  // Update startBlock if provided
  if (startBlock != null) {
    content = content.replace(
      /(name: OddMaki[\s\S]*?startBlock: )\d+/,
      `$1${startBlock}`
    );
    content = content.replace(
      /(name: ConditionalTokens[\s\S]*?startBlock: )\d+/,
      `$1${startBlock}`
    );
  }

  fs.writeFileSync(yamlPath, content);
  console.log(`  Updated ${yamlName}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const opts = parseArgs();

  console.log(`\nSync from oddmaki-core → oddmaki-subgraph`);
  console.log(`  Core path: ${opts.corePath}\n`);

  if (!fs.existsSync(opts.corePath)) {
    console.error(`Error: oddmaki-core not found at ${opts.corePath}`);
    process.exit(1);
  }

  // 1. Read deployment
  console.log('Reading deployment...');
  const deployment = readDeployment(opts.corePath, opts.network, opts.version);

  const contracts = deployment.contracts;
  if (!contracts.OddMaki) {
    console.error('Error: OddMaki address not found in deployment');
    process.exit(1);
  }

  // 2. Merge facet ABIs → abis/OddMaki.json
  console.log('\nMerging facet ABIs...');
  const mergedAbi = mergeFacetAbis(opts.corePath);
  writeAbi(path.join(ROOT, 'abis', 'OddMaki.json'), mergedAbi);

  // 3. Update networks.json
  console.log('\nUpdating addresses...');
  updateNetworksJson(opts.network, contracts);

  // 4. Update subgraph YAML
  updateSubgraphYaml(opts.network, contracts, opts.startBlock);

  // Summary
  console.log('\nDone! Contract addresses:');
  console.log(`  OddMaki:           ${contracts.OddMaki}`);
  console.log(`  ConditionalTokens: ${contracts.ConditionalTokens}`);
  if (opts.startBlock != null) {
    console.log(`  startBlock:        ${opts.startBlock}`);
  }

  console.log('\nNext steps:');
  console.log('  pnpm codegen   # regenerate types');
  console.log('  pnpm build     # verify build');
}

main();
