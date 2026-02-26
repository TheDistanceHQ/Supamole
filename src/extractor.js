/**
 * Supabase data extraction library: discovery, columns, sample data, storage scan.
 * Returns structured result for CLI or API; uses a log callback for messages.
 */

import { createClient } from '@supabase/supabase-js';
import { detectPII } from './pii-detection.js';

const STORAGE_INDEX_LIMIT = 2000;
const STORAGE_PUBLIC_VERIFY_SAMPLE = 5;
const SAMPLE_ROWS_COUNT = 3;

async function authenticateUser(supabase, email, password, token, log) {
  if (token) {
    if (email || password) {
      log('ℹ️  Both token and email/password provided - using bearer token (takes precedence)');
    }
    log('🔐 Authenticating with bearer token...');
    try {
      const { data: user, error } = await supabase.auth.getUser();
      if (error) {
        log('❌ Bearer token authentication failed: ' + error.message);
        return null;
      }
      if (!user.user) {
        log('❌ Bearer token authentication failed: No user found with this token');
        return null;
      }
      log('✅ Bearer token authentication successful');
      log(`   User ID: ${user.user.id}`);
      log(`   Email: ${user.user.email}`);
      return { user: user.user, session: { access_token: token } };
    } catch (error) {
      log('❌ Bearer token authentication error: ' + error.message);
      return null;
    }
  }
  if (!email || !password) {
    log('🔓 No credentials provided - proceeding with anonymous access');
    return null;
  }
  log('🔐 Authenticating with email/password...');
  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      log('❌ Email/password authentication failed: ' + error.message);
      return null;
    }
    log('✅ Email/password authentication successful');
    log(`   User ID: ${data.user?.id}`);
    log(`   Email: ${data.user?.email}`);
    return data;
  } catch (error) {
    log('❌ Email/password authentication error: ' + error.message);
    return null;
  }
}

async function checkConnection(supabase, log) {
  log('🔗 Testing Supabase connection...');
  try {
    const { data: { session }, error } = await supabase.auth.getSession();
    if (error) log('⚠️  Session check failed, but this is normal for anonymous access');
    log('✅ Connection established');
    if (session) log(`   🔐 Authenticated as: ${session.user?.email}`);
    else log('   🔓 Anonymous access');
    return true;
  } catch (error) {
    log('❌ Connection failed: ' + error.message);
    return false;
  }
}

async function getTablesFromRPC(supabase, log) {
  try {
    const { data, error } = await supabase.rpc('get_table_names');
    if (!error && data) {
      log('   ✅ Found tables via RPC function');
      return data.map((tableName) => ({
        table_name: tableName,
        table_schema: 'public',
        table_type: 'BASE TABLE',
      }));
    }
  } catch (_) {}
  return [];
}

async function discoverAuthTables(supabase, log) {
  const authTableNames = [
    'users', 'identities', 'sessions', 'refresh_tokens', 'audit_log_entries',
    'instances', 'schema_migrations', 'flow_state', 'saml_providers', 'saml_relay_states',
    'sso_providers', 'sso_domains', 'mfa_factors', 'mfa_challenges', 'mfa_amr_claims', 'one_time_tokens',
  ];
  const discoveredTables = [];
  for (const tableName of authTableNames) {
    try {
      const { error } = await supabase.from(`auth.${tableName}`).select('*').limit(0);
      if (!error) {
        discoveredTables.push({ table_name: tableName, table_schema: 'auth', table_type: 'BASE TABLE' });
        log(`     Found auth table: ${tableName}`);
      }
    } catch (_) {}
  }
  return discoveredTables;
}

async function discoverViaRestAPI(supabase) {
  const discoveredTables = [];
  try {
    const restUrl = `${supabase.supabaseUrl}/rest/v1/`;
    const response = await fetch(restUrl, {
      headers: {
        apikey: supabase.supabaseKey,
        Authorization: `Bearer ${supabase.supabaseKey}`,
        Accept: 'application/openapi+json',
      },
    });
    if (response.ok) {
      const openApiSpec = await response.json();
      if (openApiSpec.paths) {
        const tablePaths = Object.keys(openApiSpec.paths)
          .filter((path) => path.startsWith('/') && !path.includes('{'))
          .map((path) => path.substring(1))
          .filter((name) => name && !name.includes('/'));
        tablePaths.forEach((tableName) => {
          discoveredTables.push({ table_name: tableName, table_schema: 'public', table_type: 'BASE TABLE' });
        });
      }
    }
  } catch (_) {}
  return discoveredTables;
}

async function discoverViaGraphQL(supabase, log) {
  const discoveredTables = [];
  try {
    const graphqlUrl = `${supabase.supabaseUrl}/graphql/v1`;
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
                    ofType { name kind }
                  }
                }
              }
            }
            types { name kind fields { name type { name kind } } }
          }
        }
      `,
    };
    const response = await fetch(graphqlUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: supabase.supabaseKey,
        Authorization: `Bearer ${supabase.supabaseKey}`,
      },
      body: JSON.stringify(introspectionQuery),
    });
    if (response.ok) {
      const result = await response.json();
      if (result.data?.__schema) {
        const schema = result.data.__schema;
        const queryType = schema.queryType;
        const allTypes = schema.types || [];
        if (queryType?.fields) {
          const queryReturnTypes = new Set();
          queryType.fields.forEach((field) => {
            let returnType = field.type;
            while (returnType?.ofType) returnType = returnType.ofType;
            if (returnType?.name && !returnType.name.startsWith('__') && !['String', 'Int', 'Float', 'Boolean', 'ID'].includes(returnType.name)) {
              queryReturnTypes.add(returnType.name);
            }
          });
          const queryableTypes = allTypes.filter(
            (type) =>
              queryReturnTypes.has(type.name) &&
              type.kind === 'OBJECT' &&
              type.fields?.length > 0 &&
              !type.name.endsWith('Connection') &&
              !type.name.endsWith('Edge') &&
              !type.name.endsWith('PageInfo')
          );
          queryableTypes.forEach((type) => {
            const tableName = type.name.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '');
            discoveredTables.push({
              table_name: tableName,
              table_schema: 'public',
              table_type: 'GRAPHQL_TYPE',
              graphql_type: type.name,
              field_count: type.fields.length,
            });
            log(`     Found queryable GraphQL type: ${type.name} -> ${tableName} (${type.fields.length} fields)`);
          });
          log(`   📊 Analyzed ${queryType.fields.length} Query fields, found ${queryableTypes.length} queryable object types`);
        }
      }
    } else {
      log('   ⚠️  GraphQL endpoint not accessible or disabled');
    }
  } catch (_) {
    log('   ⚠️  GraphQL introspection failed (GraphQL may be disabled)');
  }
  return discoveredTables;
}

const COMMON_TABLES = [
  'users', 'user', 'profiles', 'user_profiles', 'accounts', 'members', 'customers', 'clients', 'employees', 'staff', 'admins', 'moderators',
  'auth_users', 'roles', 'permissions', 'user_roles', 'role_permissions', 'sessions', 'tokens', 'api_keys', 'auth_tokens', 'refresh_tokens',
  'posts', 'articles', 'pages', 'content', 'blogs', 'news', 'stories', 'comments', 'replies', 'reviews', 'feedback', 'testimonials',
  'categories', 'tags', 'topics', 'subjects', 'labels', 'files', 'uploads', 'documents', 'images', 'videos', 'audio', 'attachments', 'media', 'assets', 'resources',
  'products', 'items', 'inventory', 'stock', 'variants', 'skus', 'orders', 'cart', 'cart_items', 'order_items', 'purchases',
  'payments', 'transactions', 'invoices', 'receipts', 'billing', 'shipping', 'addresses', 'coupons', 'discounts', 'promotions',
  'companies', 'organizations', 'departments', 'teams', 'groups', 'branches', 'offices', 'locations', 'places', 'venues',
  'events', 'appointments', 'bookings', 'reservations', 'schedules', 'calendar', 'meetings', 'slots', 'availability',
  'messages', 'notifications', 'emails', 'sms', 'alerts', 'chats', 'conversations', 'threads', 'channels',
  'logs', 'audit_logs', 'activity_logs', 'access_logs', 'error_logs', 'analytics', 'metrics', 'stats', 'reports', 'tracking',
  'settings', 'config', 'configuration', 'preferences', 'options', 'features', 'flags', 'toggles', 'variables', 'constants',
  'countries', 'states', 'cities', 'regions', 'districts', 'zones', 'postcodes', 'zipcodes', 'coordinates', 'maps',
  'friends', 'followers', 'following', 'connections', 'relationships', 'likes', 'favorites', 'bookmarks', 'shares', 'votes',
  'projects', 'tasks', 'todos', 'issues', 'tickets', 'bugs', 'milestones', 'sprints', 'boards', 'workflows',
  'migrations', 'seeds', 'backups', 'imports', 'exports', 'queues', 'jobs', 'workers', 'processes', 'crons',
  'audit', 'history', 'versions', 'revisions', 'changes', 'temp', 'temporary', 'cache', 'buffer',
];

async function discoverCommonTables(supabase, log) {
  log('   🔍 Method 7: Discovering tables by testing common names...');
  const discoveredTables = [];
  const batchSize = 10;
  for (let i = 0; i < COMMON_TABLES.length; i += batchSize) {
    const batch = COMMON_TABLES.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(async (tableName) => {
        try {
          const { error } = await supabase.from(tableName).select('*').limit(0);
          return !error ? { table_name: tableName, table_schema: 'public', table_type: 'BASE TABLE' } : null;
        } catch (_) {
          return null;
        }
      })
    );
    const valid = batchResults.filter((t) => t !== null);
    discoveredTables.push(...valid);
    if (valid.length > 0) log(`     Found: ${valid.map((t) => t.table_name).join(', ')}`);
    if (i + batchSize < COMMON_TABLES.length) await new Promise((r) => setTimeout(r, 100));
  }
  return discoveredTables;
}

async function getSchemaInfo(supabase, fastDiscovery, log) {
  log('📋 Fetching schema information...');
  let discoveredTables = [];

  try {
    log('   🔍 Method 1a: Checking information_schema.tables (public schema)...');
    const { data: tables, error: tablesError } = await supabase
      .from('information_schema.tables')
      .select('table_name, table_schema, table_type')
      .eq('table_schema', 'public')
      .eq('table_type', 'BASE TABLE');
    if (!tablesError && tables?.length > 0) {
      log(`   ✅ Found ${tables.length} tables in public schema`);
      discoveredTables = [...discoveredTables, ...tables];
    } else log('   ⚠️  public schema discovery failed or returned no results');
  } catch (_) {
    log('   ⚠️  public schema discovery failed');
  }

  try {
    log('   🔍 Method 1b: Checking information_schema.tables (auth schema)...');
    const { data: authTables, error: authTablesError } = await supabase
      .from('information_schema.tables')
      .select('table_name, table_schema, table_type')
      .eq('table_schema', 'auth')
      .eq('table_type', 'BASE TABLE');
    if (!authTablesError && authTables?.length > 0) {
      log(`   ✅ Found ${authTables.length} tables in auth schema`);
      discoveredTables = [...discoveredTables, ...authTables];
    } else log('   ⚠️  auth schema discovery failed or returned no results');
  } catch (_) {
    log('   ⚠️  auth schema discovery failed');
  }

  try {
    log('   🔍 Method 2: Checking pg_tables...');
    const { data: pgTables, error: pgError } = await supabase
      .from('pg_tables')
      .select('tablename, schemaname')
      .in('schemaname', ['public', 'auth']);
    if (!pgError && pgTables?.length > 0) {
      log(`   ✅ Found ${pgTables.length} tables via pg_tables`);
      discoveredTables = [
        ...discoveredTables,
        ...pgTables.map((t) => ({ table_name: t.tablename, table_schema: t.schemaname, table_type: 'BASE TABLE' })),
      ];
    } else log('   ⚠️  pg_tables method failed or returned no results');
  } catch (_) {
    log('   ⚠️  pg_tables method failed');
  }

  try {
    log('   🔍 Method 3: Trying RPC functions...');
    const rpcTables = await getTablesFromRPC(supabase, log);
    if (rpcTables?.length > 0) {
      log(`   ✅ Found ${rpcTables.length} tables via RPC exploration`);
      discoveredTables = [...discoveredTables, ...rpcTables];
    }
  } catch (_) {
    log('   ⚠️  RPC method failed');
  }

  try {
    log('   🔍 Method 4: Checking for views...');
    const { data: views, error: viewsError } = await supabase
      .from('information_schema.views')
      .select('table_name, table_schema')
      .in('table_schema', ['public', 'auth']);
    if (!viewsError && views?.length > 0) {
      log(`   ✅ Found ${views.length} views`);
      discoveredTables = [...discoveredTables, ...views.map((v) => ({ table_name: v.table_name, table_schema: v.table_schema, table_type: 'VIEW' }))];
    }
  } catch (_) {
    log('   ⚠️  Views discovery failed');
  }

  try {
    log('   🔍 Method 4b: Testing known auth schema tables...');
    const authTables = await discoverAuthTables(supabase, log);
    if (authTables?.length > 0) {
      log(`   ✅ Found ${authTables.length} auth tables via direct testing`);
      discoveredTables = [...discoveredTables, ...authTables];
    }
  } catch (_) {
    log('   ⚠️  Auth table discovery failed');
  }

  try {
    log('   🔍 Method 5: Trying REST API introspection...');
    const apiTables = await discoverViaRestAPI(supabase);
    if (apiTables?.length > 0) {
      log(`   ✅ Found ${apiTables.length} tables via REST API`);
      discoveredTables = [...discoveredTables, ...apiTables];
    }
  } catch (_) {
    log('   ⚠️  REST API discovery failed');
  }

  try {
    log('   🔍 Method 5b: Trying GraphQL introspection...');
    const graphqlTables = await discoverViaGraphQL(supabase, log);
    if (graphqlTables?.length > 0) {
      log(`   ✅ Found ${graphqlTables.length} types via GraphQL`);
      discoveredTables = [...discoveredTables, ...graphqlTables];
    }
  } catch (_) {
    log('   ⚠️  GraphQL discovery failed');
  }

  if (!fastDiscovery) {
    const commonTables = await discoverCommonTables(supabase, log);
    if (commonTables?.length > 0) {
      log(`   ✅ Found ${commonTables.length} tables via common name discovery`);
      discoveredTables = [...discoveredTables, ...commonTables];
    }
  } else {
    log('   ⏩ Skipping comprehensive table name discovery (fast mode enabled)');
  }

  const uniqueTables = discoveredTables.filter(
    (table, index, self) => index === self.findIndex((t) => t.table_name === table.table_name)
  );
  log(`   📊 Total unique tables/views discovered: ${uniqueTables.length}`);
  return uniqueTables;
}

async function getTableColumns(supabase, tableName, tableSchema, log) {
  log(`     🔍 Getting columns for ${tableSchema}.${tableName}...`);
  try {
    const { data, error } = await supabase
      .from('information_schema.columns')
      .select('column_name, data_type, is_nullable, column_default, ordinal_position')
      .eq('table_name', tableName)
      .eq('table_schema', tableSchema)
      .order('ordinal_position');
    if (!error && data?.length > 0) {
      log(`     ✅ Found ${data.length} columns via information_schema.columns`);
      return data;
    }
  } catch (error) {
    log(`     ⚠️  information_schema.columns failed: ${error.message}`);
  }
  try {
    const tableRef = tableSchema === 'public' ? tableName : `${tableSchema}.${tableName}`;
    const { data, error } = await supabase.from(tableRef).select('*').limit(0);
    if (!error) {
      const { data: sampleData, error: sampleError } = await supabase.from(tableRef).select('*').limit(1);
      if (!sampleError && sampleData?.length > 0) {
        log(`     ✅ Inferred ${Object.keys(sampleData[0]).length} columns from sample data`);
        return Object.keys(sampleData[0]).map((colName) => ({
          column_name: colName,
          data_type: 'unknown',
          is_nullable: 'YES',
          column_default: null,
        }));
      }
    }
  } catch (error) {
    log(`     ⚠️  Sample data method failed: ${error.message}`);
  }
  try {
    const { data, error } = await supabase.rpc('get_table_columns', { table_name: tableName, table_schema: tableSchema });
    if (!error && data) {
      log('     ✅ Found columns via RPC function');
      return data;
    }
  } catch (_) {}
  log(`     ❌ Could not retrieve column information for ${tableSchema}.${tableName}`);
  return null;
}

function maskAuthUsersRow(row) {
  if (!row) return row;
  return {
    ...row,
    encrypted_password: row.encrypted_password ? '[MASKED]' : row.encrypted_password,
    email_confirmation_token: row.email_confirmation_token ? '[MASKED]' : row.email_confirmation_token,
    recovery_token: row.recovery_token ? '[MASKED]' : row.recovery_token,
  };
}

async function extractTableData(supabase, table, log) {
  const tableName = table.table_name;
  const tableSchema = table.table_schema || 'public';
  const fullTableName = tableSchema === 'public' ? tableName : `${tableSchema}.${tableName}`;
  const result = { columns: null, rowCount: 0, sampleRows: [], error: null, table_name: tableName, table_schema: tableSchema, table_type: table.table_type, graphql_type: table.graphql_type };

  log(`\n📊 Extracting data from table: ${fullTableName} (${table.table_type})`);
  if (table.graphql_type) log(`   🔗 GraphQL Type: ${table.graphql_type} (${table.field_count} fields)`);

  try {
    if (table.table_type !== 'GRAPHQL_TYPE') {
      const columns = await getTableColumns(supabase, tableName, tableSchema, log);
      result.columns = columns;
      if (columns?.length > 0) {
        log(`   Columns (${columns.length}):`);
        columns.forEach((col) => log(`     - ${col.column_name} (${col.data_type}${col.is_nullable === 'YES' ? ', nullable' : ''})`));
      }
    }

    let tableRef = tableSchema === 'public' ? tableName : fullTableName;
    let { data, error, count } = await supabase.from(tableRef).select('*', { count: 'exact' });
    if (error && table.graphql_type) {
      log(`   🔄 Trying GraphQL type name: ${table.graphql_type}`);
      const graphqlResult = await supabase.from(table.graphql_type).select('*', { count: 'exact' });
      if (!graphqlResult.error) {
        data = graphqlResult.data;
        error = graphqlResult.error;
        count = graphqlResult.count;
      }
    }

    if (error) {
      log(`   ❌ Error accessing table: ${error.message}`);
      if (tableSchema === 'auth') log(`   ℹ️  Note: auth.${tableName} may require admin privileges or service role key`);
      result.error = error.message;
      return result;
    }

    const total = count ?? data?.length ?? 0;
    result.rowCount = total;
    log(`   📈 Total rows: ${total}`);

    if (data?.length > 0) {
      const sample = data.slice(0, SAMPLE_ROWS_COUNT);
      const masked = tableSchema === 'auth' && tableName === 'users' ? sample.map(maskAuthUsersRow) : sample;
      result.sampleRows = masked;
      log(`   📄 Sample data (first ${masked.length} rows)`);
    } else {
      log('   📭 No data found in this table');
    }
  } catch (error) {
    log(`   ❌ Unexpected error: ${error.message}`);
    result.error = error.message;
  }
  return result;
}

async function verifyPublicUrlReachable(url) {
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'follow' });
    return res.ok;
  } catch (_) {
    return false;
  }
}

async function analyzeStorageBuckets(supabase, log) {
  const out = { buckets: [] };
  log('\n🪣 Storage bucket security analysis...');

  const { data: buckets, error: bucketsError } = await supabase.storage.listBuckets();
  if (bucketsError) {
    log('   ⚠️  Could not list storage buckets: ' + bucketsError.message);
    return out;
  }
  if (!buckets?.length) {
    log('   ℹ️  No storage buckets found (or no permission to list buckets).');
    return out;
  }
  log(`   Found ${buckets.length} bucket(s).`);

  for (const bucket of buckets) {
    const name = bucket.name || bucket.id;
    const isPublic = bucket.public === true;
    const bucketOut = {
      name,
      public: isPublic,
      fileSizeLimit: bucket.file_size_limit ?? undefined,
      objectCount: 0,
      samplePaths: [],
      listError: undefined,
      publicUrlCheck: undefined,
    };

    log(`\n   📦 Bucket: ${name}`);
    log(`      Public (config): ${isPublic ? 'YES ⚠️' : 'No'}`);
    if (bucket.file_size_limit != null) log(`      File size limit: ${bucket.file_size_limit}`);

    let objects = [];
    const { data: listData, error: listError } = await supabase.storage.from(name).list('', { limit: 500, sortBy: { column: 'name', order: 'asc' } });
    if (listError) {
      log(`      List objects: ❌ ${listError.message}`);
      bucketOut.listError = listError.message;
    } else if (listData?.length > 0) {
      objects = listData.map((e) => ({ path: e.name, name: e.name, size: e.metadata?.size }));
      let offset = 500;
      while (objects.length < STORAGE_INDEX_LIMIT) {
        const { data: next, error: nextErr } = await supabase.storage.from(name).list('', { limit: 200, offset, sortBy: { column: 'name', order: 'asc' } });
        if (nextErr || !next?.length) break;
        for (const e of next) objects.push({ path: e.name, name: e.name, size: e.metadata?.size });
        offset += next.length;
        if (next.length < 200) break;
      }
      const possibleFolders = objects.filter((o) => !o.path.includes('.') && o.path.length > 0);
      for (const folder of possibleFolders.slice(0, 30)) {
        if (objects.length >= STORAGE_INDEX_LIMIT) break;
        const { data: subList } = await supabase.storage.from(name).list(folder.path, { limit: 100, sortBy: { column: 'name', order: 'asc' } });
        if (subList?.length > 0) {
          for (const e of subList) {
            if (objects.length >= STORAGE_INDEX_LIMIT) break;
            objects.push({ path: `${folder.path}/${e.name}`, name: e.name, size: e.metadata?.size });
          }
        }
      }
      bucketOut.objectCount = objects.length;
      bucketOut.samplePaths = objects.slice(0, 10).map((o) => (o.size != null ? `${o.path} (${o.size} bytes)` : o.path));
      log(`      Indexed objects: ${objects.length}`);
      if (objects.length > 0) {
        bucketOut.samplePaths.forEach((p) => log(`         - ${p}`));
        if (objects.length > 10) log(`         ... and ${objects.length - 10} more`);
      }
    } else {
      log('      Indexed objects: 0 (empty or no list permission).');
    }

    if (isPublic && objects.length > 0) {
      const sampleForVerify = objects.slice(0, STORAGE_PUBLIC_VERIFY_SAMPLE);
      let verified = 0;
      for (const obj of sampleForVerify) {
        const { data: urlData } = supabase.storage.from(name).getPublicUrl(obj.path);
        if (urlData?.publicUrl && (await verifyPublicUrlReachable(urlData.publicUrl))) verified += 1;
      }
      bucketOut.publicUrlCheck = { verified, sampleSize: sampleForVerify.length };
      log(`      Public URL check: ${verified}/${sampleForVerify.length} sample URLs reachable without auth`);
      if (verified > 0) log('      ⚠️  Bucket is exposed publicly; content can be accessed by anyone with object paths.');
    }

    out.buckets.push(bucketOut);
  }
  log('\n   Storage bucket analysis completed.');
  return out;
}

async function generateSQLSchema(supabase, tables, log) {
  log('📝 Generating SQL schema...');
  let sqlContent = `-- Supabase Database Schema Export\n-- Generated on: ${new Date().toISOString()}\n-- Total tables: ${tables.length}\n\n`;
  const tablesBySchema = {};
  for (const table of tables) {
    const schema = table.table_schema || 'public';
    if (!tablesBySchema[schema]) tablesBySchema[schema] = [];
    tablesBySchema[schema].push(table);
  }
  for (const [schemaName, schemaTables] of Object.entries(tablesBySchema)) {
    sqlContent += `-- ==============================================\n-- Schema: ${schemaName}\n-- ==============================================\n\n`;
    if (schemaName !== 'public') sqlContent += `CREATE SCHEMA IF NOT EXISTS "${schemaName}";\n\n`;
    for (const table of schemaTables) {
      sqlContent += `-- Table: ${schemaName}.${table.table_name}\n`;
      try {
        const columns = await getTableColumns(supabase, table.table_name, table.table_schema, log);
        if (columns?.length > 0) {
          sqlContent += `CREATE TABLE IF NOT EXISTS "${schemaName}"."${table.table_name}" (\n`;
          const defs = columns.map((col) => {
            let def = `  "${col.column_name}"`;
            if (col.data_type && col.data_type !== 'unknown') def += ` ${col.data_type.toUpperCase()}`;
            else {
              const cn = col.column_name.toLowerCase();
              if (cn.includes('id') && cn !== 'id') def += ' INTEGER';
              else if (cn === 'id') def += ' SERIAL PRIMARY KEY';
              else if (cn.includes('email')) def += ' VARCHAR(255)';
              else if (cn.includes('phone')) def += ' VARCHAR(20)';
              else if (cn.includes('date') || cn.includes('time')) def += ' TIMESTAMP';
              else if (cn.includes('amount') || cn.includes('price') || cn.includes('cost')) def += ' DECIMAL(10,2)';
              else if (cn.includes('count') || cn.includes('quantity')) def += ' INTEGER';
              else if (cn.includes('is_') || cn.includes('has_') || cn.includes('active')) def += ' BOOLEAN';
              else def += ' TEXT';
            }
            if (col.is_nullable === 'NO' && !def.includes('PRIMARY KEY')) def += ' NOT NULL';
            if (col.column_default && col.column_default !== 'has_default') def += ` DEFAULT ${col.column_default}`;
            return def;
          });
          sqlContent += defs.join(',\n') + '\n);\n\n';
        } else {
          sqlContent += `-- Note: Could not retrieve column information\nCREATE TABLE IF NOT EXISTS "${schemaName}"."${table.table_name}" ( id SERIAL PRIMARY KEY );\n\n`;
        }
        sqlContent += `COMMENT ON TABLE "${schemaName}"."${table.table_name}" IS '${table.table_type} - Discovered via data extraction';\n\n`;
      } catch (error) {
        sqlContent += `-- Error: ${error.message}\n\n`;
      }
    }
    sqlContent += '\n';
  }
  sqlContent += '-- Indexes and Constraints: add manually if needed.\n';
  return sqlContent;
}

/**
 * Run full extraction. config = { url, key, email?, password?, token?, fastDiscovery?, exportSql? }
 * options = { echoToConsole?: boolean } (default true for CLI)
 * @returns { Promise<{ discoveryLog: string[], tables: Array<{}>, storage: { buckets: Array<{}> }, auth: { used: boolean, userEmail?: string }, exportSqlPath?: string }> }
 */
export async function runExtraction(config, options = {}) {
  const { echoToConsole = true } = options;
  const discoveryLog = [];
  const log = (msg) => {
    discoveryLog.push(msg);
    if (echoToConsole) console.log(msg);
  };

  const result = {
    discoveryLog,
    tables: [],
    storage: { buckets: [] },
    auth: { used: false, userEmail: undefined },
    exportSqlPath: undefined,
  };

  if (!config.url || !config.key) {
    throw new Error('Missing required parameters: url and key');
  }

  log('🚀 Supabase Data Extractor Starting...');
  log(`   URL: ${config.url}`);
  log(`   Key: ${config.key.substring(0, 10)}...`);

  let supabase = createClient(config.url, config.key);
  if (config.token) {
    supabase = createClient(config.url, config.key, {
      global: { headers: { Authorization: `Bearer ${config.token}` } },
    });
  }

  const connected = await checkConnection(supabase, log);
  if (!connected) throw new Error('Connection failed');

  const authResult = await authenticateUser(supabase, config.email, config.password, config.token, log);
  if (authResult) {
    result.auth.used = true;
    result.auth.userEmail = authResult.user?.email;
  }

  const tableList = await getSchemaInfo(supabase, config.fastDiscovery ?? false, log);
  if (!tableList?.length) {
    log('❌ No tables found or accessible');
    return result;
  }

  log(`\n📚 Found ${tableList.length} accessible tables/views/types:`);
  tableList.forEach((t) => {
    const full = t.table_schema === 'public' ? t.table_name : `${t.table_schema}.${t.table_name}`;
    log(`   - ${full}${t.graphql_type ? ` [GraphQL: ${t.graphql_type}]` : ''} (${t.table_type})`);
  });

  if (config.exportSql) {
    log('\n📝 Generating SQL schema export...');
    const sqlContent = await generateSQLSchema(supabase, tableList, log);
    try {
      const fs = await import('fs/promises');
      await fs.writeFile(config.exportSql, sqlContent, 'utf8');
      log(`✅ SQL schema exported to: ${config.exportSql}`);
      result.exportSqlPath = config.exportSql;
    } catch (error) {
      log('❌ Error writing SQL file: ' + error.message);
    }
  }

  log('\n🔄 Starting data extraction...');
  for (const table of tableList) {
    const extracted = await extractTableData(supabase, table, log);
    const row = {
      table_name: extracted.table_name,
      table_schema: extracted.table_schema,
      table_type: extracted.table_type,
      graphql_type: extracted.graphql_type,
      columns: extracted.columns,
      rowCount: extracted.rowCount,
      sampleRows: extracted.sampleRows,
      error: extracted.error,
      piiFindings: [],
    };
    row.piiFindings = detectPII(extracted.columns || [], extracted.sampleRows || []);
    result.tables.push(row);
    await new Promise((r) => setTimeout(r, 500));
  }
  log('\n✨ Data extraction completed!');

  result.storage = await analyzeStorageBuckets(supabase, log);

  if (authResult) {
    await supabase.auth.signOut();
    log('🔓 Signed out successfully');
  }

  return result;
}
