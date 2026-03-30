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
        logo_path VARCHAR(500),
        primary_color VARCHAR(7) DEFAULT '#1a1a2e',
        accent_color VARCHAR(7) DEFAULT '#e94560',
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
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(email, workspace_id)
      )
    `);

    // Invitations table (whitelist)
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

    // Apps table
    await client.query(`
      CREATE TABLE IF NOT EXISTS apps (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
        uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        icon VARCHAR(10) DEFAULT '📱',
        file_path VARCHAR(500) NOT NULL,
        original_filename VARCHAR(255),
        file_size INTEGER,
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

    // Indexes
    await client.query('CREATE INDEX IF NOT EXISTS idx_users_workspace ON users(workspace_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_apps_workspace ON apps(workspace_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_apps_uploaded_by ON apps(uploaded_by)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_invitations_workspace ON invitations(workspace_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_app_shares_app ON app_shares(app_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_app_shares_user ON app_shares(user_id)');

    await client.query('COMMIT');
    console.log('✅ Database migration completed successfully');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Migration failed:', err.message);
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
