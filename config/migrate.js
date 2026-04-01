const pool = require('./db');
require('dotenv').config();

const migrate = async () => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Enable UUID extension
    await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');

    // Workspaces table
    await client.query(`
      CREATE TABLE IF NOT EXISTS workspaces (
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
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
        email VARCHAR(255) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        display_name VARCHAR(255) NOT NULL,
        role VARCHAR(20) DEFAULT 'member' CHECK (role IN ('admin', 'member')),
        is_active BOOLEAN DEFAULT true,
        reset_token VARCHAR(64),
        reset_token_expires TIMESTAMP,
        last_login_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(email, workspace_id)
      )
    `);

    // Invitations table
    await client.query(`
      CREATE TABLE IF NOT EXISTS invitations (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
        email VARCHAR(255) NOT NULL,
        invited_by UUID REFERENCES users(id),
        accepted BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(email, workspace_id)
      )
    `);

    // Apps table — HTML content stored directly in DB
    await client.query(`
      CREATE TABLE IF NOT EXISTS apps (
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
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // App shares (for 'specific' visibility)
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_shares (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        app_id UUID REFERENCES apps(id) ON DELETE CASCADE,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(app_id, user_id)
      )
    `);

    // App folders — per-user layout customisation within a workspace
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_folders (
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

    // Items inside an app folder
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_folder_items (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        folder_id UUID REFERENCES app_folders(id) ON DELETE CASCADE,
        app_id UUID REFERENCES apps(id) ON DELETE CASCADE,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(folder_id, app_id)
      )
    `);

    // Indexes
    await client.query('CREATE INDEX IF NOT EXISTS idx_users_workspace ON users(workspace_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_apps_workspace ON apps(workspace_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_apps_uploaded_by ON apps(uploaded_by)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_invitations_workspace ON invitations(workspace_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_app_shares_app ON app_shares(app_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_app_shares_user ON app_shares(user_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_app_folders_user_ws ON app_folders(user_id, workspace_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_app_folder_items_folder ON app_folder_items(folder_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_app_folder_items_app ON app_folder_items(app_id)');

    // Composite indexes for common query patterns
    await client.query('CREATE INDEX IF NOT EXISTS idx_apps_workspace_active ON apps(workspace_id, is_active) WHERE is_active = true');
    await client.query('CREATE INDEX IF NOT EXISTS idx_apps_workspace_active_pending ON apps(workspace_id, is_active, pending_delete) WHERE is_active = true AND pending_delete = false');
    await client.query('CREATE INDEX IF NOT EXISTS idx_users_email_active ON users(email, is_active) WHERE is_active = true');
    await client.query('CREATE INDEX IF NOT EXISTS idx_invitations_email_pending ON invitations(email, accepted) WHERE accepted = false');

    // Idempotent migrations for existing databases
    await client.query('ALTER TABLE apps ADD COLUMN IF NOT EXISTS file_content TEXT');
    await client.query('ALTER TABLE apps ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0');
    await client.query('ALTER TABLE apps ADD COLUMN IF NOT EXISTS pending_delete BOOLEAN DEFAULT false');
    await client.query('ALTER TABLE apps ADD COLUMN IF NOT EXISTS delete_requested_by UUID REFERENCES users(id)');
    await client.query('ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS logo_data TEXT');
    await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token VARCHAR(64)');
    await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMP');
    await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP');
    await client.query("ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS plan VARCHAR(20) DEFAULT 'free'");
    await client.query("ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS primary_color_light VARCHAR(7) DEFAULT '#ffffff'");
    await client.query("ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS accent_color_light VARCHAR(7) DEFAULT '#d63851'");
    await client.query('ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS ai_conversions_used INTEGER DEFAULT 0');
    await client.query('ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS ai_conversions_reset_at TIMESTAMP DEFAULT NOW()');
    await client.query('ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(255)');
    await client.query('ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS stripe_subscription_id VARCHAR(255)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_workspaces_stripe_customer ON workspaces(stripe_customer_id)');
    // Drop NOT NULL on old file_path column if it exists (no longer used, file_content replaces it)
    await client.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'apps' AND column_name = 'file_path') THEN
          ALTER TABLE apps ALTER COLUMN file_path DROP NOT NULL;
        END IF;
      END $$
    `);

    // Demo apps flag — demo apps are seeded on workspace creation and excluded from plan limits
    await client.query('ALTER TABLE apps ADD COLUMN IF NOT EXISTS is_demo BOOLEAN DEFAULT false');
    await client.query('CREATE INDEX IF NOT EXISTS idx_apps_is_demo ON apps(is_demo) WHERE is_demo = true');

    // Conversion logs for the tiered LLM converter
    await client.query(`
      CREATE TABLE IF NOT EXISTS conversion_logs (
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
    await client.query('CREATE INDEX IF NOT EXISTS idx_conversion_logs_created ON conversion_logs(created_at)');

    // Conversion jobs (replaces in-memory Map for persistence across restarts)
    await client.query(`
      CREATE TABLE IF NOT EXISTS conversion_jobs (
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
    await client.query('CREATE INDEX IF NOT EXISTS idx_conversion_jobs_created ON conversion_jobs(created_at)');

    // Backfill sort_order from created_at for existing rows
    await client.query(`
      UPDATE apps SET sort_order = sub.rn FROM (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY workspace_id ORDER BY created_at) - 1 AS rn
        FROM apps WHERE sort_order = 0
      ) sub WHERE apps.id = sub.id AND apps.sort_order = 0
    `);

    await client.query('COMMIT');
    console.log('Database migration completed successfully');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
};

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
