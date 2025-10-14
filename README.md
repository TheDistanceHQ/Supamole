# Supabase Data Extractor

An independent script that uses the Supabase SDK to discover and extract data from all available objects in a Supabase instance.

## Installation

```bash
npm install
```

## Usage

### Basic usage (anonymous access)
```bash
node extract-data.js --url YOUR_SUPABASE_URL --key YOUR_ANON_KEY
```

### With email/password authentication
```bash
node extract-data.js --url YOUR_SUPABASE_URL --key YOUR_ANON_KEY --email your@email.com --password yourpassword
```

### With bearer token authentication
```bash
node extract-data.js --url YOUR_SUPABASE_URL --key YOUR_ANON_KEY --token YOUR_BEARER_TOKEN
```

### Fast discovery mode (recommended for large databases)
```bash
node extract-data.js --url YOUR_SUPABASE_URL --key YOUR_ANON_KEY --fast-discovery
```

## Parameters

- `--url` (required): Your Supabase project URL
- `--key` (required): Your Supabase anon key
- `--email` (optional): Email for authentication
- `--password` (optional): Password for authentication
- `--token` (optional): Bearer token for authentication (JWT token from Supabase Auth)
- `--fast-discovery` (optional): Skip comprehensive table name discovery for faster execution

## Features

### Advanced Table Discovery
The script uses 8 different methods to discover tables across multiple schemas:

1. **information_schema.tables** - Standard SQL schema information (public and auth schemas)
2. **pg_tables** - PostgreSQL system catalog (public and auth schemas)
3. **RPC functions** - Custom stored procedures (if available)
4. **information_schema.views** - Database views (public and auth schemas)
5. **Auth schema tables** - Direct testing of known Supabase auth tables (auth.users, auth.sessions, etc.)
6. **REST API introspection** - OpenAPI specification analysis
7. **GraphQL introspection** - Discovers types/tables exposed via the GraphQL endpoint
8. **Common name discovery** - Tests 70+ common table names (can be skipped with --fast-discovery)

### GraphQL Schema Discovery
The script performs GraphQL introspection to discover additional tables/types that are specifically queryable through the GraphQL API:

- Queries the `/graphql/v1` endpoint with introspection
- Analyzes the Query type to find all queryable fields and their return types
- Unwraps LIST and NON_NULL wrappers to identify actual object types
- Excludes scalar types, system types, and pagination types (Connection, Edge, PageInfo)
- Only includes types that are actually exposed as queries (not just mutations or subscriptions)
- Converts PascalCase GraphQL types to snake_case table names
- Attempts data extraction using both converted names and original GraphQL type names
- Provides comprehensive analysis of Query fields and queryable object types

### Auth Schema Support
The script specifically tests for and extracts data from Supabase's auth schema tables including:
- `auth.users` - User accounts (with sensitive data masking)
- `auth.sessions` - User sessions
- `auth.identities` - Social login identities
- `auth.refresh_tokens` - Refresh tokens
- `auth.audit_log_entries` - Authentication audit logs
- And 10+ other auth-related tables

### Data Extraction
- Lists all discovered tables and views with their types
- Shows detailed column information (name, data type, nullable status)
- Extracts all data with accurate row counts
- Displays sample data (first 3 rows) for readability
- Includes built-in rate limiting to avoid overwhelming the API
- Handles errors gracefully for inaccessible objects

### Authentication & Security
- Supports anonymous access, email/password authentication, and bearer token authentication
- Bearer token authentication takes precedence if both token and email/password are provided
- Automatic session management and cleanup
- Secure credential handling (no storage of credentials)
