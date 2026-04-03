const request = require('supertest');
const app = require('../index');
const { migrate, teardown, pool } = require('./setup');

// Cookie jar — stores auth cookies between requests
let adminCookie;
let memberCookie;
let adminUser;
let memberUser;
let workspaceId;

beforeAll(async () => {
  await migrate();
});

afterAll(async () => {
  await teardown();
});

// ─── Health ─────────────────────────────────────────────────────────────────

describe('GET /api/health', () => {
  it('returns ok status', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.timestamp).toBeDefined();
  });
});

// ─── Auth: Register ─────────────────────────────────────────────────────────

describe('POST /api/auth/register', () => {
  it('rejects missing fields', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'test@test.com' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });

  it('rejects short password', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'a@b.com', password: 'short', displayName: 'Test', workspaceName: 'TestWs' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/8 characters/);
  });

  it('rejects register without workspace or invite', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'a@b.com', password: 'password123', displayName: 'Test' });
    expect(res.status).toBe(400);
  });

  it('creates workspace and admin user', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        email: 'admin@test.com',
        password: 'password123',
        displayName: 'Admin User',
        workspaceName: 'Test Workspace'
      });

    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe('admin@test.com');
    expect(res.body.user.displayName).toBe('Admin User');
    expect(res.body.user.role).toBe('admin');
    expect(res.body.user.workspace).toBeDefined();
    expect(res.body.user.workspace.name).toBe('Test Workspace');
    expect(res.body.user.workspace.primaryColor).toBe('#1a1a2e');

    adminCookie = res.headers['set-cookie'];
    adminUser = res.body.user;
    workspaceId = res.body.user.workspaceId;
  });

  it('rejects duplicate workspace slug', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        email: 'other@test.com',
        password: 'password123',
        displayName: 'Other',
        workspaceName: 'Test Workspace'
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/similar name/);
  });
});

// ─── Auth: Login ────────────────────────────────────────────────────────────

describe('POST /api/auth/login', () => {
  it('rejects missing fields', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@test.com' });
    expect(res.status).toBe(400);
  });

  it('rejects wrong password', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@test.com', password: 'wrongpassword' });
    expect(res.status).toBe(401);
  });

  it('logs in successfully with workspace data', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@test.com', password: 'password123' });

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('admin@test.com');
    expect(res.body.user.workspace).toBeDefined();
    expect(res.body.user.workspace.name).toBe('Test Workspace');

    // Refresh admin cookie
    adminCookie = res.headers['set-cookie'];
  });

  it('rejects non-existent user', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@test.com', password: 'password123' });
    expect(res.status).toBe(401);
  });
});

// ─── Auth: Me ───────────────────────────────────────────────────────────────

describe('GET /api/auth/me', () => {
  it('returns 401 without cookie', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('returns user profile with workspace', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Cookie', adminCookie);

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('admin@test.com');
    expect(res.body.user.workspace.primaryColor).toBe('#1a1a2e');
  });
});

// ─── Auth: Logout ───────────────────────────────────────────────────────────

describe('POST /api/auth/logout', () => {
  it('clears cookie', async () => {
    const res = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', adminCookie);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Re-login for subsequent tests
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@test.com', password: 'password123' });
    adminCookie = login.headers['set-cookie'];
  });
});

// ─── Auth: Change password ──────────────────────────────────────────────────

describe('POST /api/auth/change-password', () => {
  it('rejects without auth', async () => {
    const res = await request(app)
      .post('/api/auth/change-password')
      .send({ currentPassword: 'password123', newPassword: 'newpass123' });
    expect(res.status).toBe(401);
  });

  it('rejects wrong current password', async () => {
    const res = await request(app)
      .post('/api/auth/change-password')
      .set('Cookie', adminCookie)
      .send({ currentPassword: 'wrongpass', newPassword: 'newpass123' });
    expect(res.status).toBe(401);
  });

  it('rejects short new password', async () => {
    const res = await request(app)
      .post('/api/auth/change-password')
      .set('Cookie', adminCookie)
      .send({ currentPassword: 'password123', newPassword: 'short' });
    expect(res.status).toBe(400);
  });

  it('changes password successfully', async () => {
    const res = await request(app)
      .post('/api/auth/change-password')
      .set('Cookie', adminCookie)
      .send({ currentPassword: 'password123', newPassword: 'newpassword123' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Verify can login with new password
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@test.com', password: 'newpassword123' });
    expect(login.status).toBe(200);
    adminCookie = login.headers['set-cookie'];

    // Change back for other tests
    await request(app)
      .post('/api/auth/change-password')
      .set('Cookie', adminCookie)
      .send({ currentPassword: 'newpassword123', newPassword: 'password123' });
    const relogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@test.com', password: 'password123' });
    adminCookie = relogin.headers['set-cookie'];
  });
});

// ─── Auth: Password reset flow ─────────────────────────────────────────────

describe('Password reset flow', () => {
  it('request-reset always returns ok (no email enumeration)', async () => {
    const res = await request(app)
      .post('/api/auth/request-reset')
      .send({ email: 'nonexistent@test.com' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('request-reset for existing user returns ok', async () => {
    const res = await request(app)
      .post('/api/auth/request-reset')
      .send({ email: 'admin@test.com' });
    expect(res.status).toBe(200);
  });

  it('reset-password rejects invalid token', async () => {
    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: 'invalidtoken', newPassword: 'newpass123' });
    expect(res.status).toBe(400);
  });

  it('admin-reset generates a reset link', async () => {
    // First we need a member to reset — get the member's ID
    const members = await request(app)
      .get('/api/workspace/members')
      .set('Cookie', adminCookie);
    const member = members.body.members.find(m => m.email === 'admin@test.com');

    const res = await request(app)
      .post('/api/auth/admin-reset')
      .set('Cookie', adminCookie)
      .send({ userId: member.id });
    expect(res.status).toBe(200);
    expect(res.body.resetLink).toContain('/reset-password?token=');
    expect(res.body.email).toBe('admin@test.com');

    // Extract token and use it
    const token = new URL(res.body.resetLink).searchParams.get('token');
    const reset = await request(app)
      .post('/api/auth/reset-password')
      .send({ token, newPassword: 'resetpass123' });
    expect(reset.status).toBe(200);

    // Login with new password
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@test.com', password: 'resetpass123' });
    expect(login.status).toBe(200);
    adminCookie = login.headers['set-cookie'];

    // Restore original password
    await request(app)
      .post('/api/auth/change-password')
      .set('Cookie', adminCookie)
      .send({ currentPassword: 'resetpass123', newPassword: 'password123' });
    const relogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@test.com', password: 'password123' });
    adminCookie = relogin.headers['set-cookie'];
  });

  it('admin-reset rejects non-admin', async () => {
    const res = await request(app)
      .post('/api/auth/admin-reset')
      .send({ userId: 'some-id' });
    expect(res.status).toBe(401);
  });
});

// ─── Auth: Invite email enforcement ─────────────────────────────────────────

describe('Invite email enforcement', () => {
  let testInviteId;

  it('creates invitation for specific email', async () => {
    const res = await request(app)
      .post('/api/workspace/invite')
      .set('Cookie', adminCookie)
      .send({ email: 'specific@test.com' });
    expect(res.status).toBe(201);
    testInviteId = res.body.invitation.id;
  });

  it('rejects registration with wrong email', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        email: 'wrong@test.com',
        password: 'password123',
        displayName: 'Wrong User',
        inviteCode: testInviteId
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/different email/i);
  });

  it('accepts registration with correct email', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        email: 'specific@test.com',
        password: 'password123',
        displayName: 'Specific User',
        inviteCode: testInviteId
      });
    expect(res.status).toBe(201);
  });
});

// ─── Workspace ──────────────────────────────────────────────────────────────

describe('GET /api/workspace', () => {
  it('returns workspace details', async () => {
    const res = await request(app)
      .get('/api/workspace')
      .set('Cookie', adminCookie);

    expect(res.status).toBe(200);
    expect(res.body.workspace.name).toBe('Test Workspace');
    expect(res.body.workspace.primaryColor).toBe('#1a1a2e');
    expect(res.body.workspace.plan).toBe('free');
  });
});

describe('PUT /api/workspace', () => {
  it('updates workspace branding', async () => {
    const res = await request(app)
      .put('/api/workspace')
      .set('Cookie', adminCookie)
      .send({ primaryColor: '#ff0000', accentColor: '#00ff00' });

    expect(res.status).toBe(200);
    expect(res.body.workspace.primaryColor).toBe('#ff0000');
    expect(res.body.workspace.accentColor).toBe('#00ff00');
  });

  it('updates light mode branding colors', async () => {
    const res = await request(app)
      .put('/api/workspace')
      .set('Cookie', adminCookie)
      .send({ primaryColorLight: '#fafafa', accentColorLight: '#cc3344' });

    expect(res.status).toBe(200);
    expect(res.body.workspace.primaryColorLight).toBe('#fafafa');
    expect(res.body.workspace.accentColorLight).toBe('#cc3344');
  });
});

// ─── Workspace: Members ─────────────────────────────────────────────────────

describe('GET /api/workspace/members', () => {
  it('lists workspace members', async () => {
    const res = await request(app)
      .get('/api/workspace/members')
      .set('Cookie', adminCookie);

    expect(res.status).toBe(200);
    expect(res.body.members.length).toBeGreaterThanOrEqual(1);
    const admin = res.body.members.find(m => m.email === 'admin@test.com');
    expect(admin).toBeDefined();
    expect(admin.displayName).toBe('Admin User');
  });
});

// ─── Workspace: Invitations ─────────────────────────────────────────────────

let invitationId;

describe('POST /api/workspace/invite', () => {
  it('rejects missing email', async () => {
    const res = await request(app)
      .post('/api/workspace/invite')
      .set('Cookie', adminCookie)
      .send({});
    expect(res.status).toBe(400);
  });

  it('creates invitation', async () => {
    const res = await request(app)
      .post('/api/workspace/invite')
      .set('Cookie', adminCookie)
      .send({ email: 'member@test.com' });

    expect(res.status).toBe(201);
    expect(res.body.invitation.email).toBe('member@test.com');
    expect(res.body.invitation.inviteLink).toContain('/register?invite=');
    invitationId = res.body.invitation.id;
  });

  it('rejects duplicate invitation', async () => {
    const res = await request(app)
      .post('/api/workspace/invite')
      .set('Cookie', adminCookie)
      .send({ email: 'member@test.com' });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/workspace/invitations', () => {
  it('lists invitations', async () => {
    const res = await request(app)
      .get('/api/workspace/invitations')
      .set('Cookie', adminCookie);

    expect(res.status).toBe(200);
    expect(res.body.invitations.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── Auth: Register via invite ──────────────────────────────────────────────

describe('Register via invitation', () => {
  it('registers member with invite code', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        email: 'member@test.com',
        password: 'password123',
        displayName: 'Member User',
        inviteCode: invitationId
      });

    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('member');
    expect(res.body.user.workspace.name).toBe('Test Workspace');

    memberCookie = res.headers['set-cookie'];
    memberUser = res.body.user;
  });

  it('rejects already-used invite', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        email: 'another@test.com',
        password: 'password123',
        displayName: 'Another',
        inviteCode: invitationId
      });
    expect(res.status).toBe(400);
  });
});

// ─── Workspace: Role change ─────────────────────────────────────────────────

describe('PUT /api/workspace/members/:id/role', () => {
  it('rejects invalid role', async () => {
    const res = await request(app)
      .put(`/api/workspace/members/${memberUser.id}/role`)
      .set('Cookie', adminCookie)
      .send({ role: 'superadmin' });
    expect(res.status).toBe(400);
  });

  it('changes member role', async () => {
    const res = await request(app)
      .put(`/api/workspace/members/${memberUser.id}/role`)
      .set('Cookie', adminCookie)
      .send({ role: 'admin' });
    expect(res.status).toBe(200);

    // Change back to member for subsequent tests
    await request(app)
      .put(`/api/workspace/members/${memberUser.id}/role`)
      .set('Cookie', adminCookie)
      .send({ role: 'member' });
  });

  it('rejects non-admin caller', async () => {
    const res = await request(app)
      .put(`/api/workspace/members/${adminUser.id}/role`)
      .set('Cookie', memberCookie)
      .send({ role: 'member' });
    expect(res.status).toBe(403);
  });
});

// ─── Apps: Check ────────────────────────────────────────────────────────────

describe('POST /api/apps/check', () => {
  it('rejects missing filename', async () => {
    const res = await request(app)
      .post('/api/apps/check')
      .set('Cookie', adminCookie)
      .send({});
    expect(res.status).toBe(400);
  });

  it('returns supported for .html', async () => {
    const res = await request(app)
      .post('/api/apps/check')
      .set('Cookie', adminCookie)
      .send({ filename: 'my-app.html' });
    expect(res.status).toBe(200);
    expect(res.body.supported).toBe(true);
  });

  it('returns supported for .htm', async () => {
    const res = await request(app)
      .post('/api/apps/check')
      .set('Cookie', adminCookie)
      .send({ filename: 'app.htm' });
    expect(res.body.supported).toBe(true);
  });

  it('returns unsupported with conversion prompt for .jsx', async () => {
    const res = await request(app)
      .post('/api/apps/check')
      .set('Cookie', adminCookie)
      .send({ filename: 'component.jsx' });
    expect(res.body.supported).toBe(false);
    expect(res.body.detected).toBe('React JSX Component');
    expect(res.body.conversionPrompt).toBeDefined();
  });

  it('handles unknown extensions', async () => {
    const res = await request(app)
      .post('/api/apps/check')
      .set('Cookie', adminCookie)
      .send({ filename: 'data.xyz' });
    expect(res.body.supported).toBe(false);
    expect(res.body.detected).toContain('xyz');
  });
});

// ─── Apps: Stats ────────────────────────────────────────────────────────────

describe('GET /api/apps/stats', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/apps/stats');
    expect(res.status).toBe(401);
  });

  it('returns stats structure', async () => {
    const res = await request(app)
      .get('/api/apps/stats')
      .set('Cookie', adminCookie);

    expect(res.status).toBe(200);
    expect(typeof res.body.totalApps).toBe('number');
    expect(typeof res.body.totalBuilders).toBe('number');
    expect(typeof res.body.newThisWeek).toBe('number');
    expect(Array.isArray(res.body.recentActivity)).toBe(true);
  });
});

// ─── Apps: Convert (AI) ─────────────────────────────────────────────────────

describe('POST /api/apps/convert', () => {
  it('rejects without auth', async () => {
    const res = await request(app)
      .post('/api/apps/convert')
      .attach('appFile', Buffer.from('const x = 1;'), 'app.js');
    expect(res.status).toBe(401);
  });

  it('rejects free plan workspace', async () => {
    const res = await request(app)
      .post('/api/apps/convert')
      .set('Cookie', adminCookie)
      .attach('appFile', Buffer.from('const x = 1;'), 'app.js');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('upgrade_required');
  });

  it('rejects when rate limit exceeded (team plan)', async () => {
    // Temporarily set plan to team and max out conversions
    await pool.query("UPDATE workspaces SET plan = 'team', ai_conversions_used = 999 WHERE slug = 'test-workspace'");

    const res = await request(app)
      .post('/api/apps/convert')
      .set('Cookie', adminCookie)
      .attach('appFile', Buffer.from('const x = 1;'), 'app.js');
    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/limit/i);

    // Reset
    await pool.query("UPDATE workspaces SET plan = 'free', ai_conversions_used = 0 WHERE slug = 'test-workspace'");
  });

  it('poll endpoint returns 404 for unknown job', async () => {
    const res = await request(app)
      .get('/api/apps/convert/nonexistent-job-id')
      .set('Cookie', adminCookie);
    expect(res.status).toBe(404);
  });
});

// ─── Apps: Upload ───────────────────────────────────────────────────────────

let appId;
const testHtml = '<html><head><title>Test</title></head><body><h1>Hello</h1></body></html>';

describe('POST /api/apps/upload', () => {
  it('rejects unauthenticated', async () => {
    const res = await request(app)
      .post('/api/apps/upload')
      .field('name', 'Test App');
    expect(res.status).toBe(401);
  });

  it('rejects missing file', async () => {
    const res = await request(app)
      .post('/api/apps/upload')
      .set('Cookie', adminCookie)
      .field('name', 'Test App');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no file/i);
  });

  it('rejects missing name', async () => {
    const res = await request(app)
      .post('/api/apps/upload')
      .set('Cookie', adminCookie)
      .attach('appFile', Buffer.from(testHtml), 'test.html');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name/i);
  });

  it('uploads an HTML app successfully', async () => {
    const res = await request(app)
      .post('/api/apps/upload')
      .set('Cookie', adminCookie)
      .attach('appFile', Buffer.from(testHtml), 'test-app.html')
      .field('name', 'My Test App')
      .field('description', 'A test application')
      .field('icon', '🚀')
      .field('visibility', 'team');

    expect(res.status).toBe(201);
    expect(res.body.app.name).toBe('My Test App');
    expect(res.body.app.description).toBe('A test application');
    expect(res.body.app.icon).toBe('🚀');
    expect(res.body.app.visibility).toBe('team');
    expect(res.body.app.uploadedBy).toBe('Admin User');
    expect(res.body.app.uploadedByEmail).toBe('admin@test.com');
    expect(res.body.validation).toBeDefined();

    appId = res.body.app.id;
  });
});

// ─── Apps: Stats (with data) ────────────────────────────────────────────────

describe('GET /api/apps/stats (after upload)', () => {
  it('reflects uploaded app in counts and activity', async () => {
    const res = await request(app)
      .get('/api/apps/stats')
      .set('Cookie', adminCookie);

    expect(res.status).toBe(200);
    expect(res.body.totalApps).toBeGreaterThanOrEqual(1);
    expect(res.body.totalBuilders).toBeGreaterThanOrEqual(1);
    expect(res.body.newThisWeek).toBeGreaterThanOrEqual(1);
    expect(res.body.recentActivity.length).toBeGreaterThanOrEqual(1);
    expect(res.body.recentActivity[0].appName).toBeDefined();
    expect(res.body.recentActivity[0].uploadedBy).toBeDefined();
    expect(res.body.recentActivity[0].appIcon).toBeDefined();
    expect(res.body.recentActivity[0].createdAt).toBeDefined();
  });
});

// ─── Apps: List ─────────────────────────────────────────────────────────────

describe('GET /api/apps', () => {
  it('lists apps for workspace', async () => {
    const res = await request(app)
      .get('/api/apps')
      .set('Cookie', adminCookie);

    expect(res.status).toBe(200);
    expect(res.body.apps.length).toBeGreaterThanOrEqual(1);
    expect(res.body.apps[0].name).toBe('My Test App');
  });

  it('member can see team-visible apps', async () => {
    const res = await request(app)
      .get('/api/apps')
      .set('Cookie', memberCookie);

    expect(res.status).toBe(200);
    expect(res.body.apps.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── Apps: Get by ID ────────────────────────────────────────────────────────

describe('GET /api/apps/:id', () => {
  it('returns app details', async () => {
    const res = await request(app)
      .get(`/api/apps/${appId}`)
      .set('Cookie', adminCookie);

    expect(res.status).toBe(200);
    expect(res.body.app.name).toBe('My Test App');
    expect(res.body.app.uploadedByEmail).toBe('admin@test.com');
  });

  it('returns 404 for non-existent app', async () => {
    const res = await request(app)
      .get('/api/apps/00000000-0000-0000-0000-000000000000')
      .set('Cookie', adminCookie);
    expect(res.status).toBe(404);
  });

  it('rejects invalid UUID', async () => {
    const res = await request(app)
      .get('/api/apps/not-a-uuid')
      .set('Cookie', adminCookie);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid id/i);
  });
});

// ─── Apps: Update ───────────────────────────────────────────────────────────

describe('PUT /api/apps/:id', () => {
  it('updates app metadata', async () => {
    const res = await request(app)
      .put(`/api/apps/${appId}`)
      .set('Cookie', adminCookie)
      .send({ name: 'Updated App', description: 'Updated description' });

    expect(res.status).toBe(200);
    expect(res.body.app.name).toBe('Updated App');
    expect(res.body.app.description).toBe('Updated description');
  });

  it('rejects non-owner non-admin', async () => {
    const res = await request(app)
      .put(`/api/apps/${appId}`)
      .set('Cookie', memberCookie)
      .send({ name: 'Hacked' });
    expect(res.status).toBe(403);
  });
});

// ─── Apps: Reorder ──────────────────────────────────────────────────────────

let secondAppId;

describe('PUT /api/apps/reorder', () => {
  it('creates a second app for reorder test', async () => {
    const res = await request(app)
      .post('/api/apps/upload')
      .set('Cookie', adminCookie)
      .attach('appFile', Buffer.from(testHtml), 'second.html')
      .field('name', 'Second App');
    expect(res.status).toBe(201);
    secondAppId = res.body.app.id;
  });

  it('rejects empty body', async () => {
    const res = await request(app)
      .put('/api/apps/reorder')
      .set('Cookie', adminCookie)
      .send({});
    expect(res.status).toBe(400);
  });

  it('reorders apps', async () => {
    const res = await request(app)
      .put('/api/apps/reorder')
      .set('Cookie', adminCookie)
      .send({ appIds: [secondAppId, appId] });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Verify order
    const list = await request(app)
      .get('/api/apps')
      .set('Cookie', adminCookie);
    const ids = list.body.apps.map(a => a.id);
    expect(ids.indexOf(secondAppId)).toBeLessThan(ids.indexOf(appId));
  });
});

// ─── Apps: Update file ──────────────────────────────────────────────────────

describe('PUT /api/apps/:id/file', () => {
  const updatedHtml = '<html><body><h1>Updated Version</h1></body></html>';

  it('rejects unauthenticated', async () => {
    const res = await request(app)
      .put(`/api/apps/${appId}/file`)
      .attach('appFile', Buffer.from(updatedHtml), 'updated.html');
    expect(res.status).toBe(401);
  });

  it('rejects non-owner non-admin', async () => {
    const res = await request(app)
      .put(`/api/apps/${appId}/file`)
      .set('Cookie', memberCookie)
      .attach('appFile', Buffer.from(updatedHtml), 'updated.html');
    expect(res.status).toBe(403);
  });

  it('rejects missing file', async () => {
    const res = await request(app)
      .put(`/api/apps/${appId}/file`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(400);
  });

  it('updates app file successfully', async () => {
    const res = await request(app)
      .put(`/api/apps/${appId}/file`)
      .set('Cookie', adminCookie)
      .attach('appFile', Buffer.from(updatedHtml), 'updated.html');

    expect(res.status).toBe(200);
    expect(res.body.app.originalFilename).toBe('updated.html');
    expect(res.body.app.fileSize).toBe(updatedHtml.length);
  });

  it('rejects non-html file', async () => {
    const res = await request(app)
      .put(`/api/apps/${appId}/file`)
      .set('Cookie', adminCookie)
      .attach('appFile', Buffer.from('console.log("hi")'), 'app.js');
    expect(res.status).toBe(400);
    expect(res.body.detected).toBeDefined();
    expect(res.body.conversionPrompt).toBeDefined();
  });

  it('serves updated content in sandbox', async () => {
    const res = await request(app)
      .get(`/sandbox/${appId}`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Updated Version');
  });
});

// ─── Apps: Visibility (private) ─────────────────────────────────────────────

let privateAppId;

describe('App visibility', () => {
  it('admin uploads a private app', async () => {
    const res = await request(app)
      .post('/api/apps/upload')
      .set('Cookie', adminCookie)
      .attach('appFile', Buffer.from(testHtml), 'private-app.html')
      .field('name', 'Private App')
      .field('visibility', 'private');

    expect(res.status).toBe(201);
    privateAppId = res.body.app.id;
  });

  it('member cannot see private app', async () => {
    const res = await request(app)
      .get(`/api/apps/${privateAppId}`)
      .set('Cookie', memberCookie);
    expect(res.status).toBe(403);
  });

  it('member list does not include private app', async () => {
    const res = await request(app)
      .get('/api/apps')
      .set('Cookie', memberCookie);

    const ids = res.body.apps.map(a => a.id);
    expect(ids).not.toContain(privateAppId);
  });
});

// ─── Apps: Delete ───────────────────────────────────────────────────────────

describe('DELETE /api/apps/:id', () => {
  it('rejects non-owner non-admin', async () => {
    const res = await request(app)
      .delete(`/api/apps/${appId}`)
      .set('Cookie', memberCookie);
    expect(res.status).toBe(403);
  });

  it('admin can delete immediately', async () => {
    const res = await request(app)
      .delete(`/api/apps/${appId}`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.pending).toBe(false);
  });

  it('deleted app returns 404', async () => {
    const res = await request(app)
      .get(`/api/apps/${appId}`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(404);
  });

  it('cannot re-delete', async () => {
    const res = await request(app)
      .delete(`/api/apps/${appId}`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(404);
  });
});

// ─── Apps: Pending Deletion (member flow) ───────────────────────────────────

describe('Pending deletion workflow', () => {
  let pendingAppId;
  let tempMemberCookie;

  beforeAll(async () => {
    // Re-activate member for this test
    await pool.query("UPDATE users SET is_active = true WHERE email = 'member@test.com'");
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'member@test.com', password: 'password123' });
    tempMemberCookie = login.headers['set-cookie'];

    // Member uploads an app
    const upload = await request(app)
      .post('/api/apps/upload')
      .set('Cookie', tempMemberCookie)
      .attach('appFile', Buffer.from(testHtml), 'pending-test.html')
      .field('name', 'Pending Test App');
    pendingAppId = upload.body.app.id;
  });

  it('member delete creates pending deletion', async () => {
    const res = await request(app)
      .delete(`/api/apps/${pendingAppId}`)
      .set('Cookie', tempMemberCookie);
    expect(res.status).toBe(200);
    expect(res.body.pending).toBe(true);
  });

  it('pending app is excluded from normal listing', async () => {
    const res = await request(app)
      .get('/api/apps')
      .set('Cookie', tempMemberCookie);
    const ids = res.body.apps.map(a => a.id);
    expect(ids).not.toContain(pendingAppId);
  });

  it('admin can see pending deletions', async () => {
    const res = await request(app)
      .get('/api/apps/pending-deletions')
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.apps.length).toBeGreaterThanOrEqual(1);
    const pending = res.body.apps.find(a => a.id === pendingAppId);
    expect(pending).toBeDefined();
    expect(pending.requestedBy).toBe('Member User');
  });

  it('member cannot see pending deletions', async () => {
    const res = await request(app)
      .get('/api/apps/pending-deletions')
      .set('Cookie', tempMemberCookie);
    expect(res.status).toBe(403);
  });

  it('admin can reject deletion', async () => {
    const res = await request(app)
      .post(`/api/apps/${pendingAppId}/reject-deletion`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);

    // App reappears in listing
    const list = await request(app)
      .get('/api/apps')
      .set('Cookie', tempMemberCookie);
    const ids = list.body.apps.map(a => a.id);
    expect(ids).toContain(pendingAppId);
  });

  it('re-request and approve deletion', async () => {
    await request(app)
      .delete(`/api/apps/${pendingAppId}`)
      .set('Cookie', tempMemberCookie);

    const res = await request(app)
      .post(`/api/apps/${pendingAppId}/approve-deletion`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);

    // App is now gone
    const list = await request(app)
      .get('/api/apps')
      .set('Cookie', tempMemberCookie);
    const ids = list.body.apps.map(a => a.id);
    expect(ids).not.toContain(pendingAppId);
  });
});

// ─── Workspace: Revoke invitation ───────────────────────────────────────────

describe('DELETE /api/workspace/invite/:id', () => {
  let newInviteId;

  it('creates a new invitation to revoke', async () => {
    const res = await request(app)
      .post('/api/workspace/invite')
      .set('Cookie', adminCookie)
      .send({ email: 'revoke-me@test.com' });
    expect(res.status).toBe(201);
    newInviteId = res.body.invitation.id;
  });

  it('revokes invitation', async () => {
    const res = await request(app)
      .delete(`/api/workspace/invite/${newInviteId}`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('returns 404 for already revoked', async () => {
    const res = await request(app)
      .delete(`/api/workspace/invite/${newInviteId}`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(404);
  });
});

// ─── Workspace: Remove member ───────────────────────────────────────────────

describe('DELETE /api/workspace/members/:id', () => {
  it('admin cannot remove self', async () => {
    const res = await request(app)
      .delete(`/api/workspace/members/${adminUser.id}`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/yourself/);
  });

  it('member cannot remove others', async () => {
    const res = await request(app)
      .delete(`/api/workspace/members/${adminUser.id}`)
      .set('Cookie', memberCookie);
    expect(res.status).toBe(403);
  });

  it('admin can deactivate member', async () => {
    const res = await request(app)
      .delete(`/api/workspace/members/${memberUser.id}`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);
  });

  it('deactivated member cannot log in', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'member@test.com', password: 'password123' });
    expect(res.status).toBe(401);
  });
});

// ─── Sandbox ────────────────────────────────────────────────────────────────

describe('GET /sandbox/:appId', () => {
  let sandboxAppId;

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/apps/upload')
      .set('Cookie', adminCookie)
      .attach('appFile', Buffer.from('<html><body><h1>Sandbox Test</h1></body></html>'), 'sandbox-test.html')
      .field('name', 'Sandbox App');

    sandboxAppId = res.body.app.id;
  });

  it('returns 401 without auth', async () => {
    const res = await request(app).get(`/sandbox/${sandboxAppId}`);
    expect(res.status).toBe(401);
  });

  it('serves HTML content with security headers', async () => {
    const res = await request(app)
      .get(`/sandbox/${sandboxAppId}`)
      .set('Cookie', adminCookie);

    expect(res.status).toBe(200);
    expect(res.text).toContain('Sandbox Test');
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    const csp = res.headers['content-security-policy'];
    expect(csp).toContain("connect-src 'self' https: wss: ws: data: blob:");
    expect(csp).toContain('mediastream:');
    expect(csp).toContain('frame-ancestors');
  });

  it('returns 404 for non-existent app', async () => {
    const res = await request(app)
      .get('/sandbox/00000000-0000-0000-0000-000000000000')
      .set('Cookie', adminCookie);
    expect(res.status).toBe(404);
  });

  it('rejects invalid UUID', async () => {
    const res = await request(app)
      .get('/sandbox/not-valid')
      .set('Cookie', adminCookie);
    expect(res.status).toBe(400);
  });
});

// ─── Auth: Check Email ─────────────────────────────────────────────────────

describe('POST /api/auth/check-email', () => {
  it('rejects missing email', async () => {
    const res = await request(app)
      .post('/api/auth/check-email')
      .send({});
    expect(res.status).toBe(400);
  });

  it('returns existing_user for registered email', async () => {
    const res = await request(app)
      .post('/api/auth/check-email')
      .send({ email: 'admin@test.com' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('existing_user');
  });

  it('returns unknown for unregistered email', async () => {
    const res = await request(app)
      .post('/api/auth/check-email')
      .send({ email: 'nobody@nowhere.com' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('unknown');
  });

  it('returns pending_invite for invited email', async () => {
    // Create a fresh invitation
    await request(app)
      .post('/api/workspace/invite')
      .set('Cookie', adminCookie)
      .send({ email: 'checkemail@test.com' });

    const res = await request(app)
      .post('/api/auth/check-email')
      .send({ email: 'checkemail@test.com' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending_invite');
    expect(Array.isArray(res.body.invites)).toBe(true);
    expect(res.body.invites.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── Auth: Accept Invite ───────────────────────────────────────────────────

describe('POST /api/auth/accept-invite', () => {
  let acceptInviteId;

  beforeAll(async () => {
    const inv = await request(app)
      .post('/api/workspace/invite')
      .set('Cookie', adminCookie)
      .send({ email: 'accept-test@test.com' });
    acceptInviteId = inv.body.invitation.id;
  });

  it('rejects missing fields', async () => {
    const res = await request(app)
      .post('/api/auth/accept-invite')
      .send({ email: 'accept-test@test.com' });
    expect(res.status).toBe(400);
  });

  it('rejects weak password', async () => {
    const res = await request(app)
      .post('/api/auth/accept-invite')
      .send({
        email: 'accept-test@test.com',
        password: 'weak',
        displayName: 'Test',
        inviteId: acceptInviteId
      });
    expect(res.status).toBe(400);
  });

  it('rejects mismatched email', async () => {
    const res = await request(app)
      .post('/api/auth/accept-invite')
      .send({
        email: 'wrong-email@test.com',
        password: 'Password1',
        displayName: 'Test',
        inviteId: acceptInviteId
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/different email/i);
  });

  it('rejects invalid invite ID', async () => {
    const res = await request(app)
      .post('/api/auth/accept-invite')
      .send({
        email: 'accept-test@test.com',
        password: 'Password1',
        displayName: 'Test',
        inviteId: '00000000-0000-0000-0000-000000000000'
      });
    expect(res.status).toBe(400);
  });

  it('accepts invite successfully', async () => {
    const res = await request(app)
      .post('/api/auth/accept-invite')
      .send({
        email: 'accept-test@test.com',
        password: 'Password1',
        displayName: 'Accepted User',
        inviteId: acceptInviteId
      });
    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe('accept-test@test.com');
    expect(res.body.user.role).toBe('member');
    expect(res.body.user.workspace).toBeDefined();
  });

  it('rejects already-used invite', async () => {
    const res = await request(app)
      .post('/api/auth/accept-invite')
      .send({
        email: 'accept-test@test.com',
        password: 'Password1',
        displayName: 'Duplicate',
        inviteId: acceptInviteId
      });
    expect(res.status).toBe(400);
  });
});

// ─── Auth: Sandbox Token ───────────────────────────────────────────────────

describe('GET /api/auth/sandbox-token', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/auth/sandbox-token');
    expect(res.status).toBe(401);
  });

  it('returns a short-lived token', async () => {
    const res = await request(app)
      .get('/api/auth/sandbox-token')
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(typeof res.body.token).toBe('string');
    expect(res.body.token.length).toBeGreaterThan(10);
  });
});

// ─── Folders ───────────────────────────────────────────────────────────────

describe('Folders API', () => {
  let folderId;
  let folderApp1Id, folderApp2Id, folderApp3Id;

  beforeAll(async () => {
    // Create apps for folder tests
    const upload1 = await request(app)
      .post('/api/apps/upload')
      .set('Cookie', adminCookie)
      .attach('appFile', Buffer.from('<html><body>Folder App 1</body></html>'), 'folder1.html')
      .field('name', 'Folder App 1');
    folderApp1Id = upload1.body.app.id;

    const upload2 = await request(app)
      .post('/api/apps/upload')
      .set('Cookie', adminCookie)
      .attach('appFile', Buffer.from('<html><body>Folder App 2</body></html>'), 'folder2.html')
      .field('name', 'Folder App 2');
    folderApp2Id = upload2.body.app.id;

    const upload3 = await request(app)
      .post('/api/apps/upload')
      .set('Cookie', adminCookie)
      .attach('appFile', Buffer.from('<html><body>Folder App 3</body></html>'), 'folder3.html')
      .field('name', 'Folder App 3');
    folderApp3Id = upload3.body.app.id;
  });

  describe('GET /api/folders', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).get('/api/folders');
      expect(res.status).toBe(401);
    });

    it('returns empty folders initially', async () => {
      const res = await request(app)
        .get('/api/folders')
        .set('Cookie', adminCookie);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.folders)).toBe(true);
    });
  });

  describe('POST /api/folders', () => {
    it('rejects without appIds', async () => {
      const res = await request(app)
        .post('/api/folders')
        .set('Cookie', adminCookie)
        .send({ name: 'Test Folder' });
      expect(res.status).toBe(400);
    });

    it('rejects with fewer than 2 appIds', async () => {
      const res = await request(app)
        .post('/api/folders')
        .set('Cookie', adminCookie)
        .send({ name: 'Test Folder', appIds: [folderApp1Id] });
      expect(res.status).toBe(400);
    });

    it('creates folder with 2+ apps', async () => {
      const res = await request(app)
        .post('/api/folders')
        .set('Cookie', adminCookie)
        .send({ name: 'My Folder', icon: '📂', appIds: [folderApp1Id, folderApp2Id] });
      expect(res.status).toBe(201);
      expect(res.body.folder.name).toBe('My Folder');
      expect(res.body.folder.icon).toBe('📂');
      folderId = res.body.folder.id;
    });
  });

  describe('PUT /api/folders/:id', () => {
    it('renames folder', async () => {
      const res = await request(app)
        .put(`/api/folders/${folderId}`)
        .set('Cookie', adminCookie)
        .send({ name: 'Renamed Folder' });
      expect(res.status).toBe(200);
      expect(res.body.folder.name).toBe('Renamed Folder');
    });

    it('updates folder icon', async () => {
      const res = await request(app)
        .put(`/api/folders/${folderId}`)
        .set('Cookie', adminCookie)
        .send({ icon: '🗂️' });
      expect(res.status).toBe(200);
      expect(res.body.folder.icon).toBe('🗂️');
    });

    it('returns 404 for non-existent folder', async () => {
      const res = await request(app)
        .put('/api/folders/00000000-0000-0000-0000-000000000000')
        .set('Cookie', adminCookie)
        .send({ name: 'Nope' });
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/folders/:id/apps', () => {
    it('adds app to folder', async () => {
      const res = await request(app)
        .post(`/api/folders/${folderId}/apps`)
        .set('Cookie', adminCookie)
        .send({ appId: folderApp3Id });
      expect(res.status).toBe(201);
      expect(res.body.ok).toBe(true);
    });

    it('rejects missing appId', async () => {
      const res = await request(app)
        .post(`/api/folders/${folderId}/apps`)
        .set('Cookie', adminCookie)
        .send({});
      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /api/folders/:id/apps/:appId', () => {
    it('removes app from folder', async () => {
      const res = await request(app)
        .delete(`/api/folders/${folderId}/apps/${folderApp3Id}`)
        .set('Cookie', adminCookie);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.folderDeleted).toBe(false);
    });
  });

  describe('PUT /api/folders/layout', () => {
    it('rejects missing folders array', async () => {
      const res = await request(app)
        .put('/api/folders/layout')
        .set('Cookie', adminCookie)
        .send({});
      expect(res.status).toBe(400);
    });

    it('saves folder layout', async () => {
      const res = await request(app)
        .put('/api/folders/layout')
        .set('Cookie', adminCookie)
        .send({ folders: [{ id: folderId, appIds: [folderApp2Id, folderApp1Id] }] });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });

  describe('DELETE /api/folders/:id', () => {
    it('deletes folder', async () => {
      const res = await request(app)
        .delete(`/api/folders/${folderId}`)
        .set('Cookie', adminCookie);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it('returns 404 for deleted folder', async () => {
      const res = await request(app)
        .delete(`/api/folders/${folderId}`)
        .set('Cookie', adminCookie);
      expect(res.status).toBe(404);
    });
  });

  describe('Auto-delete folder on remove app', () => {
    let autoDeleteFolderId;

    beforeAll(async () => {
      const folder = await request(app)
        .post('/api/folders')
        .set('Cookie', adminCookie)
        .send({ name: 'Auto Delete', appIds: [folderApp1Id, folderApp2Id] });
      autoDeleteFolderId = folder.body.folder.id;
    });

    it('auto-deletes folder when apps drop below 2', async () => {
      const res = await request(app)
        .delete(`/api/folders/${autoDeleteFolderId}/apps/${folderApp1Id}`)
        .set('Cookie', adminCookie);
      expect(res.status).toBe(200);
      expect(res.body.folderDeleted).toBe(true);
    });
  });
});

// ─── Subscription: Status ──────────────────────────────────────────────────

describe('GET /api/subscription/status', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/subscription/status');
    expect(res.status).toBe(401);
  });

  it('returns subscription status and usage', async () => {
    const res = await request(app)
      .get('/api/subscription/status')
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.plan).toBeDefined();
    expect(res.body.usage).toBeDefined();
    expect(typeof res.body.usage.apps).toBe('number');
    expect(typeof res.body.usage.members).toBe('number');
    expect(typeof res.body.hasStripeSubscription).toBe('boolean');
  });
});

// ─── Subscription: Checkout Landing ────────────────────────────────────────

describe('GET /api/subscription/checkout-landing', () => {
  it('rejects missing plan', async () => {
    const res = await request(app)
      .get('/api/subscription/checkout-landing');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid plan/i);
  });

  it('rejects invalid plan name', async () => {
    const res = await request(app)
      .get('/api/subscription/checkout-landing?plan=invalid');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid plan/i);
  });

  it('returns 500 when Stripe is not configured', async () => {
    // Without STRIPE_SECRET_KEY, Stripe won't be available
    const res = await request(app)
      .get('/api/subscription/checkout-landing?plan=team');
    // Either 500 (no Stripe) or 303 (redirect to Stripe) depending on config
    expect([303, 500]).toContain(res.status);
  });
});

// ─── Subscription: Verify Session ──────────────────────────────────────────

describe('GET /api/subscription/verify-session', () => {
  it('rejects missing session_id', async () => {
    const res = await request(app)
      .get('/api/subscription/verify-session');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/session_id/i);
  });

  it('rejects invalid session_id', async () => {
    const res = await request(app)
      .get('/api/subscription/verify-session?session_id=fake_session');
    // Either 400 (invalid) or 500 (Stripe not configured)
    expect([400, 500]).toContain(res.status);
  });
});

// ─── Apps: Demo management ─────────────────────────────────────────────────

describe('Demo app management', () => {
  it('dismiss-demos returns 401 without auth', async () => {
    const res = await request(app).post('/api/apps/dismiss-demos');
    expect(res.status).toBe(401);
  });

  it('dismiss-demos succeeds', async () => {
    const res = await request(app)
      .post('/api/apps/dismiss-demos')
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('restore-demos returns 401 without auth', async () => {
    const res = await request(app).post('/api/apps/restore-demos');
    expect(res.status).toBe(401);
  });

  it('restore-demos succeeds', async () => {
    const res = await request(app)
      .post('/api/apps/restore-demos')
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

// ─── Builder: Sessions ─────────────────────────────────────────────────────

describe('Builder API', () => {
  let builderSessionId;

  describe('GET /api/builder/usage', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).get('/api/builder/usage');
      expect(res.status).toBe(401);
    });

    it('returns usage for authenticated user', async () => {
      const res = await request(app)
        .get('/api/builder/usage')
        .set('Cookie', adminCookie);
      expect(res.status).toBe(200);
    });
  });

  describe('POST /api/builder/sessions', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app)
        .post('/api/builder/sessions')
        .send({ name: 'Test Build' });
      expect(res.status).toBe(401);
    });

    it('rejects on free plan (no builder access)', async () => {
      const res = await request(app)
        .post('/api/builder/sessions')
        .set('Cookie', adminCookie)
        .send({ name: 'Test Build' });
      // Free plan doesn't have builder access
      expect([201, 403]).toContain(res.status);
      if (res.status === 201) {
        builderSessionId = res.body.session.id;
      }
    });

    it('creates session on paid plan', async () => {
      // Upgrade workspace to power plan for builder access
      await pool.query("UPDATE workspaces SET plan = 'power' WHERE slug = 'test-workspace'");

      const res = await request(app)
        .post('/api/builder/sessions')
        .set('Cookie', adminCookie)
        .send({
          name: 'Test Builder Session',
          description: 'Building a test app',
          appType: 'tool',
          complexity: 'simple',
          features: ['responsive', 'dark mode']
        });
      expect(res.status).toBe(201);
      expect(res.body.session.name).toBe('Test Builder Session');
      expect(res.body.session.appType).toBe('tool');
      expect(res.body.session.complexity).toBe('simple');
      expect(res.body.session.status).toBe('draft');
      builderSessionId = res.body.session.id;
    });

    it('rejects missing name', async () => {
      const res = await request(app)
        .post('/api/builder/sessions')
        .set('Cookie', adminCookie)
        .send({ description: 'No name provided' });
      expect(res.status).toBe(400);
    });

    it('rejects name over 100 chars', async () => {
      const res = await request(app)
        .post('/api/builder/sessions')
        .set('Cookie', adminCookie)
        .send({ name: 'x'.repeat(101) });
      expect(res.status).toBe(400);
    });

    it('rejects invalid appType', async () => {
      const res = await request(app)
        .post('/api/builder/sessions')
        .set('Cookie', adminCookie)
        .send({ name: 'Test', appType: 'invalid-type' });
      expect(res.status).toBe(400);
    });

    it('rejects invalid complexity', async () => {
      const res = await request(app)
        .post('/api/builder/sessions')
        .set('Cookie', adminCookie)
        .send({ name: 'Test', complexity: 'ultra' });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/builder/sessions', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).get('/api/builder/sessions');
      expect(res.status).toBe(401);
    });

    it('lists sessions', async () => {
      const res = await request(app)
        .get('/api/builder/sessions')
        .set('Cookie', adminCookie);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.sessions)).toBe(true);
      expect(res.body.sessions.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('GET /api/builder/sessions/:id', () => {
    it('returns session details', async () => {
      const res = await request(app)
        .get(`/api/builder/sessions/${builderSessionId}`)
        .set('Cookie', adminCookie);
      expect(res.status).toBe(200);
      expect(res.body.session.name).toBe('Test Builder Session');
    });

    it('returns 404 for non-existent session', async () => {
      const res = await request(app)
        .get('/api/builder/sessions/00000000-0000-0000-0000-000000000000')
        .set('Cookie', adminCookie);
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/builder/sessions/:id/jobs/:jobId', () => {
    it('returns 404 for non-existent job', async () => {
      const res = await request(app)
        .get(`/api/builder/sessions/${builderSessionId}/jobs/00000000-0000-0000-0000-000000000000`)
        .set('Cookie', adminCookie);
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/builder/sessions/:id/revise', () => {
    it('rejects without current HTML', async () => {
      const res = await request(app)
        .post(`/api/builder/sessions/${builderSessionId}/revise`)
        .set('Cookie', adminCookie)
        .send({ feedback: 'Make it blue' });
      // Session has no HTML yet, should fail
      expect([400, 404]).toContain(res.status);
    });

    it('rejects missing feedback', async () => {
      const res = await request(app)
        .post(`/api/builder/sessions/${builderSessionId}/revise`)
        .set('Cookie', adminCookie)
        .send({});
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/builder/sessions/:id/publish', () => {
    it('rejects publish without HTML', async () => {
      const res = await request(app)
        .post(`/api/builder/sessions/${builderSessionId}/publish`)
        .set('Cookie', adminCookie)
        .send({ name: 'Published App' });
      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /api/builder/sessions/:id', () => {
    it('deletes session', async () => {
      const res = await request(app)
        .delete(`/api/builder/sessions/${builderSessionId}`)
        .set('Cookie', adminCookie);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it('returns 404 for deleted session', async () => {
      const res = await request(app)
        .get(`/api/builder/sessions/${builderSessionId}`)
        .set('Cookie', adminCookie);
      expect(res.status).toBe(404);
    });
  });

  afterAll(async () => {
    // Restore free plan
    await pool.query("UPDATE workspaces SET plan = 'free' WHERE slug = 'test-workspace'");
  });
});

// ─── Per-user permissions: members get free tier ───────────────────────────

describe('Per-user permission model', () => {
  let permMemberCookie;

  beforeAll(async () => {
    // Re-activate member and login
    await pool.query("UPDATE users SET is_active = true WHERE email = 'member@test.com'");
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'member@test.com', password: 'password123' });
    permMemberCookie = login.headers['set-cookie'];
  });

  describe('Member gets free tier even when workspace is on paid plan', () => {
    beforeAll(async () => {
      await pool.query("UPDATE workspaces SET plan = 'power' WHERE slug = 'test-workspace'");
    });

    afterAll(async () => {
      await pool.query("UPDATE workspaces SET plan = 'free' WHERE slug = 'test-workspace'");
    });

    it('admin /me returns workspace plan', async () => {
      const res = await request(app)
        .get('/api/auth/me')
        .set('Cookie', adminCookie);
      expect(res.status).toBe(200);
      expect(res.body.user.workspace.plan).toBe('power');
      expect(res.body.user.workspace.workspacePlan).toBe('power');
    });

    it('member /me returns free effective plan with workspacePlan', async () => {
      const res = await request(app)
        .get('/api/auth/me')
        .set('Cookie', permMemberCookie);
      expect(res.status).toBe(200);
      expect(res.body.user.workspace.plan).toBe('free');
      expect(res.body.user.workspace.workspacePlan).toBe('power');
    });

    it('admin subscription status shows workspace plan', async () => {
      const res = await request(app)
        .get('/api/subscription/status')
        .set('Cookie', adminCookie);
      expect(res.status).toBe(200);
      expect(res.body.effectivePlan).toBe('power');
      expect(res.body.isInvitedMember).toBe(false);
    });

    it('member subscription status shows free effective plan', async () => {
      const res = await request(app)
        .get('/api/subscription/status')
        .set('Cookie', permMemberCookie);
      expect(res.status).toBe(200);
      expect(res.body.effectivePlan).toBe('free');
      expect(res.body.workspacePlan).toBe('power');
      expect(res.body.isInvitedMember).toBe(true);
      expect(res.body.upgradeAvailable).toBe(true);
    });

    it('member cannot use AI conversions on paid workspace', async () => {
      const res = await request(app)
        .post('/api/apps/convert')
        .set('Cookie', permMemberCookie)
        .attach('appFile', Buffer.from('const x = 1;'), 'app.js');
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('upgrade_required');
      expect(res.body.upgradeAvailable).toBe(true);
    });

    it('admin can use AI conversions on paid workspace', async () => {
      // Admin on power plan should pass requirePaidAI (even if no AI key configured)
      const res = await request(app)
        .post('/api/apps/convert')
        .set('Cookie', adminCookie)
        .attach('appFile', Buffer.from('const x = 1;'), 'app.js');
      // Should not get 403 upgrade_required — may get other errors (no AI key, etc.)
      expect(res.status).not.toBe(403);
    });

    it('member cannot create builder session on paid workspace', async () => {
      const res = await request(app)
        .post('/api/builder/sessions')
        .set('Cookie', permMemberCookie)
        .send({ name: 'Member Build' });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('upgrade_required');
      expect(res.body.upgradeAvailable).toBe(true);
    });

    it('admin can create builder session on paid workspace', async () => {
      const res = await request(app)
        .post('/api/builder/sessions')
        .set('Cookie', adminCookie)
        .send({ name: 'Admin Build' });
      expect(res.status).toBe(201);
      // Clean up
      if (res.body.session?.id) {
        await request(app)
          .delete(`/api/builder/sessions/${res.body.session.id}`)
          .set('Cookie', adminCookie);
      }
    });

    it('member can still view all team-visible apps', async () => {
      const res = await request(app)
        .get('/api/apps')
        .set('Cookie', permMemberCookie);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.apps)).toBe(true);
    });

    it('member app limit counts only their own apps', async () => {
      // Member on free tier (5 app limit) — count only member's own apps
      const upload = await request(app)
        .post('/api/apps/upload')
        .set('Cookie', permMemberCookie)
        .attach('appFile', Buffer.from('<html><body>Member App</body></html>'), 'member-app.html')
        .field('name', 'Member App');
      expect(upload.status).toBe(201);
    });
  });

  describe('Checkout-landing accepts creator alias', () => {
    it('accepts plan=creator as valid', async () => {
      const res = await request(app)
        .get('/api/subscription/checkout-landing?plan=creator');
      // Either 303 (redirect to Stripe) or 500 (no Stripe config) — not 400
      expect(res.status).not.toBe(400);
    });

    it('still accepts plan=business', async () => {
      const res = await request(app)
        .get('/api/subscription/checkout-landing?plan=business');
      expect(res.status).not.toBe(400);
    });
  });

  describe('Business plan displays as Creator', () => {
    beforeAll(async () => {
      await pool.query("UPDATE workspaces SET plan = 'business' WHERE slug = 'test-workspace'");
    });

    afterAll(async () => {
      await pool.query("UPDATE workspaces SET plan = 'free' WHERE slug = 'test-workspace'");
    });

    it('admin /me shows Creator as plan name', async () => {
      const res = await request(app)
        .get('/api/auth/me')
        .set('Cookie', adminCookie);
      expect(res.status).toBe(200);
      expect(res.body.user.workspace.planLimits.planName).toBe('Creator');
    });

    it('subscription status shows Creator name', async () => {
      const res = await request(app)
        .get('/api/subscription/status')
        .set('Cookie', adminCookie);
      expect(res.status).toBe(200);
      expect(res.body.planName).toBe('Creator');
    });
  });
});
