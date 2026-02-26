#!/usr/bin/env node

import { createClient } from '@supabase/supabase-js';
import { parseArgs } from 'util';

/**
 * Parse command line arguments
 */
function parseArguments() {
  const options = {
    url: {
      type: 'string',
      short: 'u',
    },
    key: {
      type: 'string',
      short: 'k',
    },
    email: {
      type: 'string',
      short: 'e',
    },
    password: {
      type: 'string',
      short: 'p',
    },
    token: {
      type: 'string',
      short: 't',
    },
    help: {
      type: 'boolean',
      short: 'h',
    },
    'fast-discovery': {
      type: 'boolean',
      short: 'f',
    },
    'export-sql': {
      type: 'string',
      short: 's',
    },
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

/**
 * Show help information
 */
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

/**
 * Authenticate user if credentials or token are provided
 */
async function authenticateUser(supabase, email, password, token) {
  // Check if bearer token is provided
  if (token) {
    if ((email || password)) {
      console.log('ℹ️  Both token and email/password provided - using bearer token (takes precedence)');
    }
    console.log('🔐 Authenticating with bearer token...');
    try {
      // Test the token by trying to get current user
      const { data: user, error } = await supabase.auth.getUser();

      if (error) {
        console.error('❌ Bearer token authentication failed:', error.message);
        return null;
      }

      if (!user.user) {
        console.error('❌ Bearer token authentication failed: No user found with this token');
        return null;
      }

      console.log('✅ Bearer token authentication successful');
      console.log(`   User ID: ${user.user.id}`);
      console.log(`   Email: ${user.user.email}`);
      
      return { 
        user: user.user, 
        session: { access_token: token }
      };
    } catch (error) {
      console.error('❌ Bearer token authentication error:', error.message);
      return null;
    }
  }
  
  // Check if email/password are provided
  if (!email || !password) {
    console.log('🔓 No credentials provided - proceeding with anonymous access');
    return null;
  }

  console.log('🔐 Authenticating with email/password...');
  try {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      console.error('❌ Email/password authentication failed:', error.message);
      return null;
    }

    console.log('✅ Email/password authentication successful');
    console.log(`   User ID: ${data.user?.id}`);
    console.log(`   Email: ${data.user?.email}`);
    return data;
  } catch (error) {
    console.error('❌ Email/password authentication error:', error.message);
    return null;
  }
}

/**
 * Get schema information from Supabase using multiple methods
 */
async function getSchemaInfo(supabase, fastDiscovery = false) {
  console.log('📋 Fetching schema information...');
  
  let discoveredTables = [];
  
  // Method 1: Try information_schema.tables (public schema)
  try {
    console.log('   🔍 Method 1a: Checking information_schema.tables (public schema)...');
    const { data: tables, error: tablesError } = await supabase
      .from('information_schema.tables')
      .select('table_name, table_schema, table_type')
      .eq('table_schema', 'public')
      .eq('table_type', 'BASE TABLE');

    if (!tablesError && tables && tables.length > 0) {
      console.log(`   ✅ Found ${tables.length} tables in public schema`);
      discoveredTables = [...discoveredTables, ...tables];
    } else {
      console.log('   ⚠️  public schema discovery failed or returned no results');
    }
  } catch (error) {
    console.log('   ⚠️  public schema discovery failed');
  }

  // Method 1b: Try information_schema.tables (auth schema)
  try {
    console.log('   🔍 Method 1b: Checking information_schema.tables (auth schema)...');
    const { data: authTables, error: authTablesError } = await supabase
      .from('information_schema.tables')
      .select('table_name, table_schema, table_type')
      .eq('table_schema', 'auth')
      .eq('table_type', 'BASE TABLE');

    if (!authTablesError && authTables && authTables.length > 0) {
      console.log(`   ✅ Found ${authTables.length} tables in auth schema`);
      discoveredTables = [...discoveredTables, ...authTables];
    } else {
      console.log('   ⚠️  auth schema discovery failed or returned no results');
    }
  } catch (error) {
    console.log('   ⚠️  auth schema discovery failed');
  }
  
  // Method 2: Try PostgreSQL system catalogs (public and auth schemas)
  try {
    console.log('   🔍 Method 2: Checking pg_tables...');
    const { data: pgTables, error: pgError } = await supabase
      .from('pg_tables')
      .select('tablename, schemaname')
      .in('schemaname', ['public', 'auth']);

    if (!pgError && pgTables && pgTables.length > 0) {
      console.log(`   ✅ Found ${pgTables.length} tables via pg_tables`);
      const formattedTables = pgTables.map(t => ({
        table_name: t.tablename,
        table_schema: t.schemaname,
        table_type: 'BASE TABLE'
      }));
      discoveredTables = [...discoveredTables, ...formattedTables];
    } else {
      console.log('   ⚠️  pg_tables method failed or returned no results');
    }
  } catch (error) {
    console.log('   ⚠️  pg_tables method failed');
  }

  // Method 3: Try RPC function to get tables
  try {
    console.log('   🔍 Method 3: Trying RPC functions...');
    const rpcTables = await getTablesFromRPC(supabase);
    if (rpcTables && rpcTables.length > 0) {
      console.log(`   ✅ Found ${rpcTables.length} tables via RPC exploration`);
      discoveredTables = [...discoveredTables, ...rpcTables];
    }
  } catch (error) {
    console.log('   ⚠️  RPC method failed');
  }

  // Method 4: Try to get views as well (public and auth schemas)
  try {
    console.log('   🔍 Method 4: Checking for views...');
    const { data: views, error: viewsError } = await supabase
      .from('information_schema.views')
      .select('table_name, table_schema')
      .in('table_schema', ['public', 'auth']);

    if (!viewsError && views && views.length > 0) {
      console.log(`   ✅ Found ${views.length} views`);
      const formattedViews = views.map(v => ({
        table_name: v.table_name,
        table_schema: v.table_schema,
        table_type: 'VIEW'
      }));
      discoveredTables = [...discoveredTables, ...formattedViews];
    }
  } catch (error) {
    console.log('   ⚠️  Views discovery failed');
  }

  // Method 4b: Try direct auth schema table discovery
  try {
    console.log('   🔍 Method 4b: Testing known auth schema tables...');
    const authTables = await discoverAuthTables(supabase);
    if (authTables && authTables.length > 0) {
      console.log(`   ✅ Found ${authTables.length} auth tables via direct testing`);
      discoveredTables = [...discoveredTables, ...authTables];
    }
  } catch (error) {
    console.log('   ⚠️  Auth table discovery failed');
  }

  // Method 5: Try REST API introspection
  try {
    console.log('   🔍 Method 5: Trying REST API introspection...');
    const apiTables = await discoverViaRestAPI(supabase);
    if (apiTables && apiTables.length > 0) {
      console.log(`   ✅ Found ${apiTables.length} tables via REST API`);
      discoveredTables = [...discoveredTables, ...apiTables];
    }
  } catch (error) {
    console.log('   ⚠️  REST API discovery failed');
  }

  // Method 5b: Try GraphQL introspection
  try {
    console.log('   🔍 Method 5b: Trying GraphQL introspection...');
    const graphqlTables = await discoverViaGraphQL(supabase);
    if (graphqlTables && graphqlTables.length > 0) {
      console.log(`   ✅ Found ${graphqlTables.length} types via GraphQL`);
      discoveredTables = [...discoveredTables, ...graphqlTables];
    }
  } catch (error) {
    console.log('   ⚠️  GraphQL discovery failed');
  }

  // Method 6: Try common table name discovery (skip if fast discovery is enabled)
  if (!fastDiscovery) {
    const commonTables = await discoverCommonTables(supabase);
    if (commonTables && commonTables.length > 0) {
      console.log(`   ✅ Found ${commonTables.length} tables via common name discovery`);
      discoveredTables = [...discoveredTables, ...commonTables];
    }
  } else {
    console.log('   ⏩ Skipping comprehensive table name discovery (fast mode enabled)');
  }

  // Remove duplicates
  const uniqueTables = discoveredTables.filter((table, index, self) => 
    index === self.findIndex(t => t.table_name === table.table_name)
  );

  console.log(`   📊 Total unique tables/views discovered: ${uniqueTables.length}`);
  return uniqueTables;
}

/**
 * Try to get tables through RPC functions
 */
async function getTablesFromRPC(supabase) {
  const discoveredTables = [];
  
  // Try to call a custom RPC function if it exists
  try {
    const { data, error } = await supabase.rpc('get_table_names');
    if (!error && data) {
      console.log(`   ✅ Found tables via RPC function`);
      return data.map(tableName => ({
        table_name: tableName,
        table_schema: 'public',
        table_type: 'BASE TABLE'
      }));
    }
  } catch (error) {
    // RPC function doesn't exist, continue with other methods
  }

  return discoveredTables;
}

/**
 * Discover auth schema tables by testing known table names
 */
async function discoverAuthTables(supabase) {
  // Known auth schema tables in Supabase
  const authTableNames = [
    'users',           // Main user table
    'identities',      // User identities (social logins, etc.)
    'sessions',        // User sessions
    'refresh_tokens',  // Refresh tokens
    'audit_log_entries', // Audit logs
    'instances',       // Instance configuration
    'schema_migrations', // Auth schema migrations
    'flow_state',      // Authentication flow state
    'saml_providers',  // SAML providers
    'saml_relay_states', // SAML relay states
    'sso_providers',   // SSO providers
    'sso_domains',     // SSO domains
    'mfa_factors',     // Multi-factor authentication factors
    'mfa_challenges',  // MFA challenges
    'mfa_amr_claims',  // MFA Authentication Method Reference claims
    'one_time_tokens'  // One-time tokens
  ];

  const discoveredTables = [];

  for (const tableName of authTableNames) {
    try {
      // Try to select from auth.table_name with limit 0 to check if it exists
      const { error } = await supabase
        .from(`auth.${tableName}`)
        .select('*')
        .limit(0);

      if (!error) {
        discoveredTables.push({
          table_name: tableName,
          table_schema: 'auth',
          table_type: 'BASE TABLE'
        });
        console.log(`     Found auth table: ${tableName}`);
      }
    } catch (err) {
      // Table doesn't exist or no access, continue
    }
  }

  return discoveredTables;
}

/**
 * Try to discover tables via REST API introspection
 */
async function discoverViaRestAPI(supabase) {
  const discoveredTables = [];
  
  try {
    // Extract base URL and try to access the OpenAPI spec
    const supabaseUrl = supabase.supabaseUrl;
    const restUrl = `${supabaseUrl}/rest/v1/`;
    
    // Try to fetch with the API key in headers
    const response = await fetch(restUrl, {
      headers: {
        'apikey': supabase.supabaseKey,
        'Authorization': `Bearer ${supabase.supabaseKey}`,
        'Accept': 'application/openapi+json'
      }
    });

    if (response.ok) {
      const openApiSpec = await response.json();
      
      // Extract table names from OpenAPI paths
      if (openApiSpec.paths) {
        const tablePaths = Object.keys(openApiSpec.paths)
          .filter(path => path.startsWith('/') && !path.includes('{'))
          .map(path => path.substring(1)) // Remove leading slash
          .filter(tableName => tableName && !tableName.includes('/'));
        
        tablePaths.forEach(tableName => {
          discoveredTables.push({
            table_name: tableName,
            table_schema: 'public',
            table_type: 'BASE TABLE'
          });
        });
      }
    }
  } catch (error) {
    // REST API introspection failed, continue
  }

  return discoveredTables;
}

/**
 * Try to discover tables via GraphQL introspection
 */
async function discoverViaGraphQL(supabase) {
  const discoveredTables = [];
  
  try {
    // Extract base URL and construct GraphQL endpoint
    const supabaseUrl = supabase.supabaseUrl;
    const graphqlUrl = `${supabaseUrl}/graphql/v1`;
    
    // GraphQL introspection query - focus on Query type fields
    const introspectionQuery = {
      query: `
        query IntrospectionQuery {
          __schema {
            queryType {
              name
              fields {
                name
                type {
                  name
                  kind
                  ofType {
                    name
                    kind
                    ofType {
                      name
                      kind
                    }
                  }
                }
              }
            }
            types {
              name
              kind
              fields {
                name
                type {
                  name
                  kind
                }
              }
            }
          }
        }
      `
    };

    // Make GraphQL introspection request
    const response = await fetch(graphqlUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabase.supabaseKey,
        'Authorization': `Bearer ${supabase.supabaseKey}`,
      },
      body: JSON.stringify(introspectionQuery)
    });

    if (response.ok) {
      const result = await response.json();
      
      if (result.data && result.data.__schema) {
        const schema = result.data.__schema;
        const queryType = schema.queryType;
        const allTypes = schema.types;

        if (queryType && queryType.fields) {
          // Get the return types of all Query fields
          const queryReturnTypes = new Set();
          
          queryType.fields.forEach(field => {
            let returnType = field.type;
            
            // Unwrap LIST and NON_NULL wrappers to get the actual type
            while (returnType.ofType) {
              returnType = returnType.ofType;
            }
            
            if (returnType.name && 
                !returnType.name.startsWith('__') && 
                !['String', 'Int', 'Float', 'Boolean', 'ID'].includes(returnType.name)) {
              queryReturnTypes.add(returnType.name);
            }
          });

          // Find the actual type definitions for these return types
          const queryableTypes = allTypes.filter(type => 
            queryReturnTypes.has(type.name) && 
            type.kind === 'OBJECT' &&
            type.fields &&
            type.fields.length > 0 &&
            !type.name.endsWith('Connection') &&
            !type.name.endsWith('Edge') &&
            !type.name.endsWith('PageInfo')
          );

          // Convert GraphQL types to table format
          queryableTypes.forEach(type => {
            // Convert PascalCase to snake_case for table name matching
            const tableName = type.name
              .replace(/([A-Z])/g, '_$1')
              .toLowerCase()
              .replace(/^_/, '');

            discoveredTables.push({
              table_name: tableName,
              table_schema: 'public', // GraphQL typically exposes public schema
              table_type: 'GRAPHQL_TYPE',
              graphql_type: type.name,
              field_count: type.fields.length
            });
            
            console.log(`     Found queryable GraphQL type: ${type.name} -> ${tableName} (${type.fields.length} fields)`);
          });
          
          console.log(`   📊 Analyzed ${queryType.fields.length} Query fields, found ${queryableTypes.length} queryable object types`);
        }
      }
    } else {
      console.log('   ⚠️  GraphQL endpoint not accessible or disabled');
    }
  } catch (error) {
    // GraphQL introspection failed, this is normal if GraphQL is disabled
    console.log('   ⚠️  GraphQL introspection failed (GraphQL may be disabled)');
  }

  return discoveredTables;
}

/**
 * Discover tables by trying common table names
 */
async function discoverCommonTables(supabase) {
  console.log('   🔍 Method 7: Discovering tables by testing common names...');
  
  // Comprehensive list of common table names
  const commonTables = [
    // User management
    'users', 'user', 'profiles', 'user_profiles', 'accounts', 'members',
    'customers', 'clients', 'employees', 'staff', 'admins', 'moderators',
    
    // Authentication & Authorization
    'auth_users', 'roles', 'permissions', 'user_roles', 'role_permissions',
    'sessions', 'tokens', 'api_keys', 'auth_tokens', 'refresh_tokens',
    
    // Content management
    'posts', 'articles', 'pages', 'content', 'blogs', 'news', 'stories',
    'comments', 'replies', 'reviews', 'feedback', 'testimonials',
    'categories', 'tags', 'topics', 'subjects', 'labels',
    
    // Media & Files
    'files', 'uploads', 'documents', 'images', 'videos', 'audio',
    'attachments', 'media', 'assets', 'resources',
    
    // E-commerce
    'products', 'items', 'inventory', 'stock', 'variants', 'skus',
    'orders', 'cart', 'cart_items', 'order_items', 'purchases',
    'payments', 'transactions', 'invoices', 'receipts', 'billing',
    'shipping', 'addresses', 'coupons', 'discounts', 'promotions',
    
    // Organizations
    'companies', 'organizations', 'departments', 'teams', 'groups',
    'branches', 'offices', 'locations', 'places', 'venues',
    
    // Events & Scheduling
    'events', 'appointments', 'bookings', 'reservations', 'schedules',
    'calendar', 'meetings', 'sessions', 'slots', 'availability',
    
    // Communication
    'messages', 'notifications', 'emails', 'sms', 'alerts',
    'chats', 'conversations', 'threads', 'channels',
    
    // Logs & Analytics
    'logs', 'audit_logs', 'activity_logs', 'access_logs', 'error_logs',
    'analytics', 'metrics', 'stats', 'reports', 'tracking',
    
    // Configuration
    'settings', 'config', 'configuration', 'preferences', 'options',
    'features', 'flags', 'toggles', 'variables', 'constants',
    
    // Geographic
    'countries', 'states', 'cities', 'regions', 'districts', 'zones',
    'postcodes', 'zipcodes', 'coordinates', 'maps',
    
    // Social features
    'friends', 'followers', 'following', 'connections', 'relationships',
    'likes', 'favorites', 'bookmarks', 'shares', 'votes',
    
    // Project management
    'projects', 'tasks', 'todos', 'issues', 'tickets', 'bugs',
    'milestones', 'sprints', 'boards', 'workflows',
    
    // Common system tables
    'migrations', 'seeds', 'backups', 'imports', 'exports',
    'queues', 'jobs', 'workers', 'processes', 'crons',
    
    // Database specific
    'audit', 'history', 'versions', 'revisions', 'changes',
    'temp', 'temporary', 'cache', 'buffer'
  ];

  const discoveredTables = [];
  const batchSize = 10; // Process in batches to avoid overwhelming the API

  for (let i = 0; i < commonTables.length; i += batchSize) {
    const batch = commonTables.slice(i, i + batchSize);
    const batchPromises = batch.map(async (tableName) => {
      try {
        // Try to select from table with limit 0 to check if it exists
        const { error } = await supabase
          .from(tableName)
          .select('*')
          .limit(0);

        if (!error) {
          return {
            table_name: tableName,
            table_schema: 'public',
            table_type: 'BASE TABLE'
          };
        }
      } catch (err) {
        // Table doesn't exist or no access, continue
      }
      return null;
    });

    const batchResults = await Promise.all(batchPromises);
    const validTables = batchResults.filter(table => table !== null);
    discoveredTables.push(...validTables);
    
    if (validTables.length > 0) {
      console.log(`     Found: ${validTables.map(t => t.table_name).join(', ')}`);
    }

    // Small delay between batches
    if (i + batchSize < commonTables.length) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  return discoveredTables;
}

/**
 * Get column information for a table using multiple methods
 */
async function getTableColumns(supabase, tableName, tableSchema = 'public') {
  console.log(`     🔍 Getting columns for ${tableSchema}.${tableName}...`);
  
  // Method 1: Try information_schema.columns
  try {
    const { data, error } = await supabase
      .from('information_schema.columns')
      .select('column_name, data_type, is_nullable, column_default, ordinal_position')
      .eq('table_name', tableName)
      .eq('table_schema', tableSchema)
      .order('ordinal_position');

    if (!error && data && data.length > 0) {
      console.log(`     ✅ Found ${data.length} columns via information_schema.columns`);
      return data;
    }
  } catch (error) {
    console.log(`     ⚠️  information_schema.columns failed: ${error.message}`);
  }

  // Method 2: Try pg_attribute system catalog
  try {
    const { data, error } = await supabase
      .from('pg_attribute')
      .select('attname, atttypid, attnotnull, atthasdef')
      .eq('attrelid', `(SELECT oid FROM pg_class WHERE relname = '${tableName}' AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = '${tableSchema}'))`)
      .neq('attnum', 0) // Exclude system columns
      .order('attnum');

    if (!error && data && data.length > 0) {
      console.log(`     ✅ Found ${data.length} columns via pg_attribute`);
      // Convert pg_attribute data to our format
      return data.map(col => ({
        column_name: col.attname,
        data_type: 'unknown', // We'd need to join with pg_type to get actual type
        is_nullable: col.attnotnull ? 'NO' : 'YES',
        column_default: col.atthasdef ? 'has_default' : null
      }));
    }
  } catch (error) {
    console.log(`     ⚠️  pg_attribute method failed: ${error.message}`);
  }

  // Method 3: Try to get column info by attempting a SELECT with LIMIT 0
  try {
    const tableRef = tableSchema === 'public' ? tableName : `${tableSchema}.${tableName}`;
    const { data, error } = await supabase
      .from(tableRef)
      .select('*')
      .limit(0);

    if (!error) {
      // If we can query the table, try to get one row to infer column structure
      const { data: sampleData, error: sampleError } = await supabase
        .from(tableRef)
        .select('*')
        .limit(1);

      if (!sampleError && sampleData && sampleData.length > 0) {
        console.log(`     ✅ Inferred ${Object.keys(sampleData[0]).length} columns from sample data`);
        return Object.keys(sampleData[0]).map(colName => ({
          column_name: colName,
          data_type: 'unknown', // Type inference would require more complex logic
          is_nullable: 'YES', // Default assumption
          column_default: null
        }));
      }
    }
  } catch (error) {
    console.log(`     ⚠️  Sample data method failed: ${error.message}`);
  }

  // Method 4: Try RPC function for column info
  try {
    const { data, error } = await supabase.rpc('get_table_columns', {
      table_name: tableName,
      table_schema: tableSchema
    });

    if (!error && data) {
      console.log(`     ✅ Found columns via RPC function`);
      return data;
    }
  } catch (error) {
    // RPC function doesn't exist, continue
  }

  console.log(`     ❌ Could not retrieve column information for ${tableSchema}.${tableName}`);
  return null;
}

/**
 * Extract data from a specific table
 */
async function extractTableData(supabase, table) {
  const tableName = table.table_name;
  const tableSchema = table.table_schema || 'public';
  const fullTableName = tableSchema === 'public' ? tableName : `${tableSchema}.${tableName}`;
  
  console.log(`\n📊 Extracting data from table: ${fullTableName} (${table.table_type})`);
  
  // Add GraphQL type information if available
  if (table.graphql_type) {
    console.log(`   🔗 GraphQL Type: ${table.graphql_type} (${table.field_count} fields)`);
  }
  
  try {
    // Get column information first (skip for GraphQL-only discoveries)
    if (table.table_type !== 'GRAPHQL_TYPE') {
      const columns = await getTableColumns(supabase, tableName, tableSchema);
      if (columns && columns.length > 0) {
        console.log(`   Columns (${columns.length}):`);
        columns.forEach(col => {
          console.log(`     - ${col.column_name} (${col.data_type}${col.is_nullable === 'YES' ? ', nullable' : ''})`);
        });
      }
    }

    // For GraphQL types, try both the GraphQL name and converted table name
    let tableRef = tableSchema === 'public' ? tableName : fullTableName;
    let { data, error, count } = await supabase
      .from(tableRef)
      .select('*', { count: 'exact' });

    // If failed and this is a GraphQL type, try the original GraphQL type name
    if (error && table.graphql_type) {
      console.log(`   🔄 Trying GraphQL type name: ${table.graphql_type}`);
      const graphqlResult = await supabase
        .from(table.graphql_type)
        .select('*', { count: 'exact' });
      
      if (!graphqlResult.error) {
        data = graphqlResult.data;
        error = graphqlResult.error;
        count = graphqlResult.count;
      }
    }

    if (error) {
      console.log(`   ❌ Error accessing table: ${error.message}`);
      
      // For auth tables, provide additional context
      if (tableSchema === 'auth') {
        console.log(`   ℹ️  Note: auth.${tableName} may require admin privileges or service role key`);
      }
      return;
    }

    console.log(`   📈 Total rows: ${count || data?.length || 0}`);
    
    if (data && data.length > 0) {
      console.log(`   📄 Sample data (first ${Math.min(3, data.length)} rows):`);
      data.slice(0, 3).forEach((row, index) => {
        // For auth.users, mask sensitive data in the output
        let displayRow = row;
        if (tableSchema === 'auth' && tableName === 'users') {
          displayRow = {
            ...row,
            encrypted_password: row.encrypted_password ? '[MASKED]' : row.encrypted_password,
            email_confirmation_token: row.email_confirmation_token ? '[MASKED]' : row.email_confirmation_token,
            recovery_token: row.recovery_token ? '[MASKED]' : row.recovery_token
          };
        }
        
        console.log(`     Row ${index + 1}:`, JSON.stringify(displayRow, null, 2));
      });
      
      if (data.length > 3) {
        console.log(`     ... and ${data.length - 3} more rows`);
      }
      
      // Show all data if requested (uncomment the line below for full data output)
      // console.log('\n   🗂️  Full data:', JSON.stringify(data, null, 2));
    } else {
      console.log('   📭 No data found in this table');
    }

  } catch (error) {
    console.log(`   ❌ Unexpected error: ${error.message}`);
  }
}

/**
 * Generate SQL DDL statements from discovered tables
 */
async function generateSQLSchema(supabase, tables) {
  console.log('📝 Generating SQL schema...');
  
  let sqlContent = `-- Supabase Database Schema Export
-- Generated on: ${new Date().toISOString()}
-- Total tables: ${tables.length}

`;

  // Group tables by schema
  const tablesBySchema = {};
  tables.forEach(table => {
    const schema = table.table_schema || 'public';
    if (!tablesBySchema[schema]) {
      tablesBySchema[schema] = [];
    }
    tablesBySchema[schema].push(table);
  });

  // Generate SQL for each schema
  for (const [schemaName, schemaTables] of Object.entries(tablesBySchema)) {
    sqlContent += `-- ==============================================
-- Schema: ${schemaName}
-- ==============================================

`;

    // Create schema if it's not public
    if (schemaName !== 'public') {
      sqlContent += `CREATE SCHEMA IF NOT EXISTS "${schemaName}";

`;
    }

    // Generate table definitions
    for (const table of schemaTables) {
      sqlContent += `-- Table: ${schemaName}.${table.table_name}
`;
      
      try {
        // Get detailed column information
        const columns = await getTableColumns(supabase, table.table_name, table.table_schema);
        
        if (columns && columns.length > 0) {
          sqlContent += `CREATE TABLE IF NOT EXISTS "${schemaName}"."${table.table_name}" (
`;
          
          const columnDefinitions = columns.map(col => {
            let columnDef = `  "${col.column_name}"`;
            
            // Add data type (with fallback for unknown types)
            if (col.data_type && col.data_type !== 'unknown') {
              columnDef += ` ${col.data_type.toUpperCase()}`;
            } else {
              // Try to infer type from column name patterns
              const colName = col.column_name.toLowerCase();
              if (colName.includes('id') && colName !== 'id') {
                columnDef += ' INTEGER'; // Foreign key
              } else if (colName === 'id') {
                columnDef += ' SERIAL PRIMARY KEY';
              } else if (colName.includes('email')) {
                columnDef += ' VARCHAR(255)';
              } else if (colName.includes('phone')) {
                columnDef += ' VARCHAR(20)';
              } else if (colName.includes('date') || colName.includes('time')) {
                columnDef += ' TIMESTAMP';
              } else if (colName.includes('amount') || colName.includes('price') || colName.includes('cost')) {
                columnDef += ' DECIMAL(10,2)';
              } else if (colName.includes('count') || colName.includes('quantity')) {
                columnDef += ' INTEGER';
              } else if (colName.includes('is_') || colName.includes('has_') || colName.includes('active')) {
                columnDef += ' BOOLEAN';
              } else {
                columnDef += ' TEXT'; // Default fallback
              }
            }
            
            // Add NOT NULL constraint (only if we have explicit info and it's not already PRIMARY KEY)
            if (col.is_nullable === 'NO' && !columnDef.includes('PRIMARY KEY')) {
              columnDef += ' NOT NULL';
            }
            
            // Add default value
            if (col.column_default && col.column_default !== 'has_default') {
              columnDef += ` DEFAULT ${col.column_default}`;
            }
            
            return columnDef;
          });
          
          sqlContent += columnDefinitions.join(',\n');
          sqlContent += `
);

`;
        } else {
          // Fallback for tables where we can't get column info
          sqlContent += `-- Note: Could not retrieve column information for this table
-- This might be a view or require special permissions
CREATE TABLE IF NOT EXISTS "${schemaName}"."${table.table_name}" (
  -- Column information not available
  id SERIAL PRIMARY KEY
);

`;
        }
        
        // Add table comment
        sqlContent += `COMMENT ON TABLE "${schemaName}"."${table.table_name}" IS '${table.table_type} - Discovered via data extraction';

`;
        
      } catch (error) {
        sqlContent += `-- Error generating table definition: ${error.message}
-- Table: ${table.table_name} (${table.table_type})

`;
      }
    }
    
    sqlContent += `
`;
  }

  // Add indexes and constraints section
  sqlContent += `-- ==============================================
-- Indexes and Constraints
-- ==============================================

-- Note: This section would typically contain:
-- - Primary key constraints
-- - Foreign key constraints  
-- - Unique constraints
-- - Indexes
-- 
-- These are not automatically discovered but can be added manually
-- based on your application requirements.

`;

  // Add sample data section
  sqlContent += `-- ==============================================
-- Sample Data (Optional)
-- ==============================================

-- Uncomment the following sections to include sample data
-- Note: This will only include data from tables that are accessible

`;

  return sqlContent;
}

/**
 * Export SQL schema to file
 */
async function exportSQLToFile(sqlContent, filename) {
  try {
    const fs = await import('fs/promises');
    await fs.writeFile(filename, sqlContent, 'utf8');
    console.log(`✅ SQL schema exported to: ${filename}`);
    return true;
  } catch (error) {
    console.error(`❌ Error writing SQL file: ${error.message}`);
    return false;
  }
}

/**
 * Check Supabase connection and basic info
 */
async function checkConnection(supabase) {
  console.log('🔗 Testing Supabase connection...');
  
  try {
    // Try to get the current user session
    const { data: { session }, error } = await supabase.auth.getSession();
    
    if (error) {
      console.log('⚠️  Session check failed, but this is normal for anonymous access');
    }

    console.log('✅ Connection established');
    
    if (session) {
      console.log(`   🔐 Authenticated as: ${session.user?.email}`);
    } else {
      console.log('   🔓 Anonymous access');
    }

    return true;
  } catch (error) {
    console.error('❌ Connection failed:', error.message);
    return false;
  }
}

/** Max objects to index per bucket (security scan cap) */
const STORAGE_INDEX_LIMIT = 2000;
/** Sample size for public URL access verification */
const STORAGE_PUBLIC_VERIFY_SAMPLE = 5;

/**
 * Verify that a public URL is actually reachable without authentication.
 */
async function verifyPublicUrlReachable(url) {
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'follow' });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Analyse Supabase Storage buckets for security: list buckets, detect public exposure,
 * and attempt to index object listing (content) that might be present.
 */
async function analyzeStorageBuckets(supabase) {
  console.log('\n🪣 Storage bucket security analysis...');

  const { data: buckets, error: bucketsError } = await supabase.storage.listBuckets();
  if (bucketsError) {
    console.log('   ⚠️  Could not list storage buckets:', bucketsError.message);
    return;
  }
  if (!buckets || buckets.length === 0) {
    console.log('   ℹ️  No storage buckets found (or no permission to list buckets).');
    return;
  }

  console.log(`   Found ${buckets.length} bucket(s).`);

  for (const bucket of buckets) {
    const name = bucket.name || bucket.id;
    const isPublic = bucket.public === true;
    console.log(`\n   📦 Bucket: ${name}`);
    console.log(`      Public (config): ${isPublic ? 'YES ⚠️' : 'No'}`);
    if (bucket.file_size_limit != null) {
      console.log(`      File size limit: ${bucket.file_size_limit}`);
    }

    let objects = [];
    const { data: listData, error: listError } = await supabase.storage.from(name).list('', { limit: 500, sortBy: { column: 'name', order: 'asc' } });
    if (listError) {
      console.log(`      List objects: ❌ ${listError.message}`);
    } else if (listData && listData.length > 0) {
      objects = listData.map(e => ({ path: e.name, name: e.name, size: e.metadata?.size }));
      let offset = 500;
      while (objects.length < STORAGE_INDEX_LIMIT) {
        const { data: next, error: nextErr } = await supabase.storage.from(name).list('', { limit: 200, offset, sortBy: { column: 'name', order: 'asc' } });
        if (nextErr || !next || next.length === 0) break;
        for (const e of next) objects.push({ path: e.name, name: e.name, size: e.metadata?.size });
        offset += next.length;
        if (next.length < 200) break;
      }
      // Index one level of subfolders (likely folder prefixes) to improve content visibility
      const possibleFolders = objects.filter(o => !o.path.includes('.') && o.path.length > 0);
      for (const folder of possibleFolders.slice(0, 30)) {
        if (objects.length >= STORAGE_INDEX_LIMIT) break;
        const { data: subList } = await supabase.storage.from(name).list(folder.path, { limit: 100, sortBy: { column: 'name', order: 'asc' } });
        if (subList && subList.length > 0) {
          for (const e of subList) {
            if (objects.length >= STORAGE_INDEX_LIMIT) break;
            const subPath = `${folder.path}/${e.name}`;
            objects.push({ path: subPath, name: e.name, size: e.metadata?.size });
          }
        }
      }
      console.log(`      Indexed objects: ${objects.length}`);
      if (objects.length > 0) {
        const sample = objects.slice(0, 10);
        console.log('      Sample paths:');
        sample.forEach(o => console.log(`         - ${o.path}${o.size != null ? ` (${o.size} bytes)` : ''}`));
        if (objects.length > 10) {
          console.log(`         ... and ${objects.length - 10} more`);
        }
      }
    } else {
      console.log('      Indexed objects: 0 (empty or no list permission).');
    }

    if (isPublic && objects.length > 0) {
      const sampleForVerify = objects.slice(0, STORAGE_PUBLIC_VERIFY_SAMPLE);
      let verified = 0;
      for (const obj of sampleForVerify) {
        const { data: urlData } = supabase.storage.from(name).getPublicUrl(obj.path);
        const url = urlData?.publicUrl;
        if (url) {
          const reachable = await verifyPublicUrlReachable(url);
          if (reachable) verified += 1;
        }
      }
      console.log(`      Public URL check: ${verified}/${sampleForVerify.length} sample URLs reachable without auth`);
      if (verified > 0) {
        console.log('      ⚠️  Bucket is exposed publicly; content can be accessed by anyone with object paths.');
      }
    }
  }

  console.log('\n   Storage bucket analysis completed.');
}

/**
 * Main execution function
 */
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

  console.log('🚀 Supabase Data Extractor Starting...');
  console.log(`   URL: ${args.url}`);
  console.log(`   Key: ${args.key.substring(0, 10)}...`);

  // Initialize Supabase client
  let supabase;
  if (args.token) {
    // If bearer token is provided, create client with token in headers
    supabase = createClient(args.url, args.key, {
      global: {
        headers: {
          Authorization: `Bearer ${args.token}`
        }
      }
    });
  } else {
    // Standard client for anonymous or email/password auth
    supabase = createClient(args.url, args.key);
  }

  // Test connection
  const connected = await checkConnection(supabase);
  if (!connected) {
    process.exit(1);
  }

  // Authenticate if credentials or token provided
  const authResult = await authenticateUser(supabase, args.email, args.password, args.token);

  // Get schema information
  const tables = await getSchemaInfo(supabase, args['fast-discovery']);
  
  if (!tables || tables.length === 0) {
    console.log('❌ No tables found or accessible');
    process.exit(1);
  }

  console.log(`\n📚 Found ${tables.length} accessible tables/views/types:`);
  tables.forEach(table => {
    const fullTableName = table.table_schema === 'public' ? table.table_name : `${table.table_schema}.${table.table_name}`;
    let displayName = fullTableName;
    
    if (table.graphql_type) {
      displayName += ` [GraphQL: ${table.graphql_type}]`;
    }
    
    console.log(`   - ${displayName} (${table.table_type})`);
  });

  // Export SQL schema if requested
  if (args['export-sql']) {
    console.log('\n📝 Generating SQL schema export...');
    const sqlContent = await generateSQLSchema(supabase, tables);
    const exportSuccess = await exportSQLToFile(sqlContent, args['export-sql']);
    
    if (exportSuccess) {
      console.log(`📄 SQL schema exported to: ${args['export-sql']}`);
    } else {
      console.log('❌ Failed to export SQL schema');
    }
  }

  // Extract data from each table
  console.log('\n🔄 Starting data extraction...');
  
  for (const table of tables) {
    await extractTableData(supabase, table);
    
    // Add a small delay to avoid overwhelming the API
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  console.log('\n✨ Data extraction completed!');

  // Storage bucket security analysis: public exposure and content indexing
  await analyzeStorageBuckets(supabase);

  // Sign out if we authenticated
  if (authResult) {
    await supabase.auth.signOut();
    console.log('🔓 Signed out successfully');
  }
}

// Execute main function
main().catch(error => {
  console.error('💥 Fatal error:', error.message);
  process.exit(1);
});
