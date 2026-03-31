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
    expect(res.headers['content-security-policy']).toBeDefined();
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
