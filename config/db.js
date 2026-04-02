const { Pool } = require('pg');
require('dotenv').config();

const isTest = process.env.NODE_ENV === 'test';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: process.env.DATABASE_SSLMODE !== 'no-verify' }
    : false,
  max: isTest ? 5 : 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client:', err.message);
});

// In test mode, route all queries to the isolated test schema
if (isTest) {
  const originalQuery = pool.query.bind(pool);
  const originalConnect = pool.connect.bind(pool);

  pool.query = async (...args) => {
    // Set search_path before each direct query
    await originalQuery('SET search_path TO test_apphub, public');
    return originalQuery(...args);
  };

  pool.connect = async () => {
    const client = await originalConnect();
    await client.query('SET search_path TO test_apphub, public');
    return client;
  };
}

module.exports = pool;
