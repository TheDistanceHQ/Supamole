#!/usr/bin/env node

import { parseArgs } from 'util';
import { runExtraction } from './src/extractor.js';

function parseArguments() {
  const options = {
    url: { type: 'string', short: 'u' },
    key: { type: 'string', short: 'k' },
    email: { type: 'string', short: 'e' },
    password: { type: 'string', short: 'p' },
    token: { type: 'string', short: 't' },
    help: { type: 'boolean', short: 'h' },
    'fast-discovery': { type: 'boolean', short: 'f' },
    'export-sql': { type: 'string', short: 's' },
  };
  try {
    const { values } = parseArgs({ options, allowPositionals: false });
    return values;
  } catch (error) {
    console.error('Error parsing arguments:', error.message);
    showHelp();
    process.exit(1);
  }
}

function showHelp() {
  console.log(`
Supabase Data Extractor

Usage:
  node extract-data.js --url <supabase-url> --key <anon-key> [options]

Required Parameters:
  --url, -u    Supabase project URL
  --key, -k    Supabase anon key

Optional Parameters:
  --email, -e          Email for authentication
  --password, -p       Password for authentication
  --token, -t          Bearer token for authentication (JWT token from Supabase Auth)
  --fast-discovery, -f Skip comprehensive table name discovery (faster)
  --export-sql, -s     Export database schema as SQL file (specify filename)
  --help, -h           Show this help message

Examples:
  # Anonymous access
  node extract-data.js --url https://project.supabase.co --key your-anon-key

  # With email/password authentication
  node extract-data.js --url https://project.supabase.co --key your-anon-key --email user@example.com --password password123

  # With bearer token authentication
  node extract-data.js --url https://project.supabase.co --key your-anon-key --token your-bearer-token

  # Export schema as SQL file
  node extract-data.js --url https://project.supabase.co --key your-anon-key --export-sql schema.sql
`);
}

async function main() {
  const args = parseArguments();

  if (args.help) {
    showHelp();
    return;
  }

  if (!args.url || !args.key) {
    console.error('❌ Missing required parameters: --url and --key');
    showHelp();
    process.exit(1);
  }

  const config = {
    url: args.url,
    key: args.key,
    email: args.email,
    password: args.password,
    token: args.token,
    fastDiscovery: args['fast-discovery'] ?? false,
    exportSql: args['export-sql'] || undefined,
  };

  try {
    await runExtraction(config, { echoToConsole: true });
  } catch (error) {
    console.error('💥 Fatal error:', error.message);
    process.exit(1);
  }
}

main();
