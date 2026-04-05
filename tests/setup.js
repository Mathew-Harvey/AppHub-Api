const { Pool } = require('pg');
require('dotenv').config();

const TEST_SCHEMA = 'test_apphub';

// Use the same DATABASE_URL but isolate via a Postgres schema
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' || process.env.DATABASE_SSLMODE
    ? { rejectUnauthorized: process.env.DATABASE_SSLMODE !== 'no-verify' }
    : false,
  max: 5,
});

async function migrate() {
  const client = await pool.connect();
  try {
    // Create isolated test schema (drops old one if exists)
    await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
    await client.query(`SET search_path TO ${TEST_SCHEMA}`);
    await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');

    await client.query(`
      CREATE TABLE workspaces (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name VARCHAR(255) NOT NULL,
        slug VARCHAR(255) UNIQUE NOT NULL,
        logo_data TEXT,
        primary_color VARCHAR(7) DEFAULT '#1a1a2e',
        accent_color VARCHAR(7) DEFAULT '#e94560',
        primary_color_light VARCHAR(7) DEFAULT '#ffffff',
        accent_color_light VARCHAR(7) DEFAULT '#d63851',
        plan VARCHAR(20) DEFAULT 'free',
        ai_conversions_used INTEGER DEFAULT 0,
        ai_conversions_reset_at TIMESTAMP DEFAULT NOW(),
        stripe_customer_id VARCHAR(255),
        stripe_subscription_id VARCHAR(255),
        builder_tokens_used INTEGER DEFAULT 0,
        builder_tokens_reset_at TIMESTAMP DEFAULT NOW(),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE users (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
        email VARCHAR(255) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        display_name VARCHAR(255) NOT NULL,
        role VARCHAR(20) DEFAULT 'member' CHECK (role IN ('admin', 'member')),
        plan VARCHAR(20) DEFAULT 'free',
        stripe_customer_id VARCHAR(255),
        stripe_subscription_id VARCHAR(255),
        ai_conversions_used INTEGER DEFAULT 0,
        ai_conversions_reset_at TIMESTAMP DEFAULT NOW(),
        builder_tokens_used INTEGER DEFAULT 0,
        builder_tokens_reset_at TIMESTAMP DEFAULT NOW(),
        is_active BOOLEAN DEFAULT true,
        reset_token VARCHAR(64),
        reset_token_expires TIMESTAMP,
        last_login_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(email, workspace_id)
      )
    `);

    await client.query(`
      CREATE TABLE invitations (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
        email VARCHAR(255) NOT NULL,
        invited_by UUID REFERENCES users(id),
        accepted BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(email, workspace_id)
      )
    `);

    await client.query(`
      CREATE TABLE apps (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
        uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        icon VARCHAR(10) DEFAULT '📱',
        file_content TEXT NOT NULL,
        original_filename VARCHAR(255),
        file_size INTEGER,
        sort_order INTEGER DEFAULT 0,
        pending_delete BOOLEAN DEFAULT false,
        delete_requested_by UUID,
        visibility VARCHAR(20) DEFAULT 'team' CHECK (visibility IN ('private', 'team', 'specific')),
        is_active BOOLEAN DEFAULT true,
        is_demo BOOLEAN DEFAULT false,
        demo_category VARCHAR(50),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE app_shares (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        app_id UUID REFERENCES apps(id) ON DELETE CASCADE,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(app_id, user_id)
      )
    `);

    await client.query(`
      CREATE TABLE app_folders (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL DEFAULT 'New Folder',
        icon VARCHAR(10) DEFAULT '📁',
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE app_folder_items (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        folder_id UUID REFERENCES app_folders(id) ON DELETE CASCADE,
        app_id UUID REFERENCES apps(id) ON DELETE CASCADE,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(folder_id, app_id)
      )
    `);

    await client.query(`
      CREATE TABLE conversion_jobs (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
        user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        status VARCHAR(20) DEFAULT 'processing' CHECK (status IN ('processing', 'done', 'failed')),
        html TEXT,
        error TEXT,
        original_filename VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE conversion_logs (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        input_files INTEGER,
        input_tokens_est INTEGER,
        output_tokens_est INTEGER,
        tier_used INTEGER,
        model_used VARCHAR(100),
        cost_estimate_usd NUMERIC(10, 6),
        success BOOLEAN DEFAULT true,
        validation_errors JSONB,
        processing_time_ms INTEGER,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE builder_sessions (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
        user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        app_type VARCHAR(50),
        name VARCHAR(100) NOT NULL,
        description TEXT,
        features JSONB DEFAULT '[]',
        style_preferences JSONB DEFAULT '{}',
        complexity VARCHAR(20) DEFAULT 'moderate' CHECK (complexity IN ('simple', 'moderate', 'complex')),
        target_audience VARCHAR(255),
        additional_notes TEXT,
        status VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft', 'generating', 'done', 'published')),
        current_html TEXT,
        revision_count INTEGER DEFAULT 0,
        total_tokens_used INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE builder_jobs (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        session_id UUID REFERENCES builder_sessions(id) ON DELETE CASCADE,
        workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
        user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        job_type VARCHAR(20) DEFAULT 'generate' CHECK (job_type IN ('generate', 'revise', 'review')),
        status VARCHAR(20) DEFAULT 'processing' CHECK (status IN ('processing', 'reviewing', 'done', 'failed')),
        html TEXT,
        review_notes JSONB,
        user_feedback TEXT,
        error TEXT,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        cache_read_tokens INTEGER DEFAULT 0,
        cache_creation_tokens INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
  } finally {
    client.release();
  }
}

// Set search_path for all connections in the pool so app code uses the test schema
async function setSearchPath() {
  await pool.query(`SET search_path TO ${TEST_SCHEMA}, public`);
}

async function teardown() {
  try {
    await pool.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
  } catch (err) {
    console.error('Teardown error:', err.message);
  }
  await pool.end();
}

module.exports = { migrate, teardown, pool, setSearchPath, TEST_SCHEMA };
