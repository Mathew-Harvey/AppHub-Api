const pool = require('../config/db');

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');

    await client.query('DROP TABLE IF EXISTS app_shares CASCADE');
    await client.query('DROP TABLE IF EXISTS apps CASCADE');
    await client.query('DROP TABLE IF EXISTS invitations CASCADE');
    await client.query('DROP TABLE IF EXISTS users CASCADE');
    await client.query('DROP TABLE IF EXISTS workspaces CASCADE');

    await client.query(`
      CREATE TABLE workspaces (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name VARCHAR(255) NOT NULL,
        slug VARCHAR(255) UNIQUE NOT NULL,
        logo_data TEXT,
        primary_color VARCHAR(7) DEFAULT '#1a1a2e',
        accent_color VARCHAR(7) DEFAULT '#e94560',
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
        is_active BOOLEAN DEFAULT true,
        reset_token VARCHAR(64),
        reset_token_expires TIMESTAMP,
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
  } finally {
    client.release();
  }
}

async function teardown() {
  await pool.end();
}

module.exports = { migrate, teardown, pool };
