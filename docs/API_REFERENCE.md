# AppHub API Reference

## Base URL
Production: `https://your-api-domain.com/api`
Development: `http://localhost:3001/api`

## Authentication
All authenticated endpoints require a valid JWT cookie. The cookie is set automatically on login/register.

### Headers
- `Content-Type: application/json` (for JSON requests)
- `Content-Type: multipart/form-data` (for file uploads - set automatically by FormData)
- Cookies are sent automatically with `credentials: 'include'`

### Login Flow
```
POST /api/auth/check-email
Body: { "email": "user@example.com" }
Response: { "status": "existing" | "invited" | "unknown", ... }

POST /api/auth/login
Body: { "email": "user@example.com", "password": "MyPass123" }
Response: { "user": { "id", "email", "displayName", "role", "workspace": {...} } }
Sets: JWT httpOnly cookie (7-day expiry)
```

## Endpoints

### Auth

#### POST /api/auth/register
Create a new account and workspace.
```json
Request: {
  "email": "user@example.com",
  "password": "MyPass123",
  "displayName": "John Doe",
  "workspaceName": "My Team"
}
Response: {
  "user": { "id", "email", "displayName", "role": "admin", "workspace": {...} }
}
```

#### POST /api/auth/check-email
Check if an email exists or has a pending invitation.
```json
Request: { "email": "user@example.com" }
Response: { "status": "existing" | "invited" | "unknown", "invitations": [...] }
```

#### POST /api/auth/login
```json
Request: { "email": "user@example.com", "password": "MyPass123" }
Response: { "user": {...} }
```

#### POST /api/auth/logout
Clears the JWT cookie.

#### GET /api/auth/me
Returns current authenticated user with workspace info.
```json
Response: {
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "displayName": "John",
    "role": "admin",
    "workspace": {
      "id": "uuid",
      "name": "My Team",
      "slug": "my-team",
      "plan": "free",
      "primaryColor": "#1a1a2e",
      "accentColor": "#e94560",
      "logoUrl": "/api/workspace/logo/uuid"
    }
  }
}
```

#### POST /api/auth/accept-invite
```json
Request: { "email": "...", "password": "...", "displayName": "...", "invitationId": "uuid" }
```

#### POST /api/auth/change-password
```json
Request: { "currentPassword": "...", "newPassword": "..." }
```

#### POST /api/auth/request-reset
```json
Request: { "email": "user@example.com" }
```
Sends password reset email with time-limited token.

#### POST /api/auth/reset-password
```json
Request: { "token": "hex-token", "newPassword": "NewPass123" }
```

#### GET /api/auth/sandbox-token
Returns a short-lived token for iframe app loading.
```json
Response: { "token": "jwt-string" }
```

---

### Apps

#### GET /api/apps
List all visible apps for the current user.
```json
Response: {
  "apps": [{
    "id": "uuid",
    "name": "Calculator",
    "description": "A simple calculator",
    "icon": "calculator emoji",
    "visibility": "team",
    "fileSize": 4096,
    "originalFilename": "calc.html",
    "uploadedBy": "uuid",
    "uploaderName": "John",
    "isDemo": false,
    "demoCategory": null,
    "sortOrder": 0,
    "createdAt": "2024-01-01T00:00:00Z",
    "updatedAt": "2024-01-01T00:00:00Z"
  }]
}
```

#### GET /api/apps/:id
Get a single app's details.

#### GET /api/apps/:id/source
Download the HTML source file. Returns raw HTML with Content-Disposition header.

#### POST /api/apps/upload
Upload a new HTML app. Requires multipart/form-data.
```
FormData fields:
  file: (HTML file, max 5MB)
  name: (optional, defaults to filename)
  description: (optional)
  icon: (optional, emoji)
  visibility: (optional, "team" | "private" | "specific")
```
Response: `{ "app": {...} }`
Errors: 413 (too large), 422 (code errors), 429 (plan limit)

#### POST /api/apps/check
```json
Request: { "filename": "app.jsx" }
Response: { "supported": true, "requiresConversion": true, "conversionPrompt": "..." }
```

#### POST /api/apps/convert
Start async AI conversion. Requires paid plan.
```
FormData fields:
  file: (non-HTML file)
```
Response: `{ "jobId": "uuid" }`

#### GET /api/apps/convert/:jobId
Poll conversion status.
```json
Response: { "status": "processing" | "done" | "failed", "html": "...", "error": "..." }
```

#### PUT /api/apps/:id
Update app metadata.
```json
Request: { "name": "New Name", "description": "...", "icon": "emoji", "visibility": "team" }
```

#### PUT /api/apps/:id/file
Replace the app's HTML file.
```
FormData fields:
  file: (new HTML file)
```

#### PUT /api/apps/reorder
```json
Request: { "appIds": ["uuid1", "uuid2", "uuid3"] }
```

#### DELETE /api/apps/:id
Marks app for deletion (requires admin approval if not admin).

#### GET /api/apps/stats
```json
Response: { "totalApps": 10, "recentActivity": [...] }
```

#### GET /api/apps/pending-deletions (Admin)
#### POST /api/apps/:id/approve-deletion (Admin)
#### POST /api/apps/:id/reject-deletion (Admin)

---

### Folders

#### GET /api/folders
```json
Response: {
  "folders": [{
    "id": "uuid",
    "name": "Utilities",
    "icon": "folder emoji",
    "sortOrder": 0,
    "apps": [{ "id": "uuid", "name": "...", "sortOrder": 0 }]
  }]
}
```

#### POST /api/folders
```json
Request: { "name": "My Folder", "icon": "emoji", "appIds": ["uuid1", "uuid2"] }
```
Requires at least 2 app IDs.

#### PUT /api/folders/:id
```json
Request: { "name": "New Name", "icon": "new emoji" }
```

#### DELETE /api/folders/:id
Deletes folder, apps are released back to dashboard.

---

### Workspace

#### GET /api/workspace
Returns workspace details including branding.

#### PUT /api/workspace (Admin)
```json
Request: {
  "name": "Team Name",
  "primaryColor": "#1a1a2e",
  "accentColor": "#e94560",
  "primaryColorLight": "#ffffff",
  "accentColorLight": "#e94560"
}
```

#### POST /api/workspace/logo (Admin)
Upload workspace logo (resized to 200x200).
```
FormData fields:
  logo: (image file)
```

#### GET /api/workspace/members
```json
Response: {
  "members": [{ "id", "email", "displayName", "role", "lastLoginAt" }]
}
```

#### POST /api/workspace/invite (Admin)
```json
Request: { "email": "newmember@example.com" }
Response: { "invitation": { "id", "email", "inviteLink": "..." } }
```

---

### Subscription

#### GET /api/subscription/status
```json
Response: {
  "plan": "free",
  "maxApps": 5,
  "maxMembers": 3,
  "currentApps": 2,
  "currentMembers": 1,
  "aiConversionsUsed": 0,
  "aiConversionsLimit": 0,
  "hasAppBuilder": false,
  "builderTokensUsed": 0,
  "builderTokensLimit": 0
}
```

#### POST /api/subscription/checkout (Admin)
Creates Stripe checkout session. Returns `{ url: "https://checkout.stripe.com/..." }`.

#### POST /api/subscription/portal (Admin)
Creates Stripe billing portal session. Returns `{ url: "..." }`.

---

### AI Builder (Business+ plans)

#### POST /api/builder/sessions
```json
Request: {
  "name": "Expense Tracker",
  "appType": "tracker",
  "description": "Track daily expenses with categories",
  "features": ["Add expenses", "View by category", "Monthly totals"],
  "stylePreferences": {
    "colorScheme": "blue",
    "layout": "dashboard",
    "font": "modern"
  },
  "complexity": "medium",
  "targetAudience": "personal",
  "additionalNotes": "Keep it simple"
}
Response: { "session": { "id", "status": "draft", ... } }
```

#### POST /api/builder/sessions/:id/generate
Starts async generation. Returns `{ "jobId": "uuid" }`.

#### GET /api/builder/sessions/:id/jobs/:jobId
```json
Response: {
  "status": "processing" | "reviewing" | "done" | "failed",
  "html": "..." (when done),
  "error": "..." (when failed),
  "reviewNotes": "..." (when done)
}
```
Poll every 2-4 seconds until status is "done" or "failed".

#### POST /api/builder/sessions/:id/revise
```json
Request: { "feedback": "Make the header bigger and add a dark mode toggle" }
Response: { "jobId": "uuid" }
```

#### POST /api/builder/sessions/:id/publish
```json
Request: {
  "name": "Expense Tracker",
  "icon": "money emoji",
  "description": "Track expenses",
  "visibility": "team"
}
Response: { "app": { "id": "uuid", ... } }
```

#### GET /api/builder/usage
```json
Response: { "tokensUsed": 50000, "tokensLimit": 500000, "resetsAt": "2024-02-01T00:00:00Z" }
```

---

### Sandbox

#### GET /sandbox/:appId?token=xxx
Serves the app HTML in an iframe with appropriate CSP headers.
Token obtained from GET /api/auth/sandbox-token.

---

## Error Responses

All errors return JSON:
```json
{
  "error": "error_code_or_message",
  "message": "Human-readable description",
  "details": {} // optional additional data
}
```

### Common Error Codes
| Status | Error | Meaning |
|--------|-------|---------|
| 400 | "Invalid input" | Missing or malformed fields |
| 401 | "Not authenticated" | No valid JWT cookie |
| 403 | "Admin access required" | Not an admin |
| 403 | "upgrade_required" | Feature needs higher plan |
| 404 | "App not found" | Invalid or inaccessible resource |
| 409 | "Generation already in progress" | Builder conflict |
| 413 | "File too large" | Exceeds 5MB limit |
| 422 | "code_errors" | JS errors detected (includes errors array) |
| 429 | "plan_limit" | App/member count exceeded |
| 429 | "token_budget_exceeded" | Monthly AI tokens used up |
| 429 | "Too many requests" | Rate limit hit |

## Rate Limits
| Scope | Limit | Window |
|-------|-------|--------|
| Auth endpoints | 30 requests | 15 minutes |
| General API | 200 requests | 15 minutes |
| File uploads | 50 uploads | 1 hour |
| Builder generate/revise | 10 requests | 1 hour |

## Plans & Limits
| Plan | Max Apps | Max Members | AI Conversions | App Builder | Builder Tokens | Monthly Price |
|------|----------|-------------|----------------|-------------|---------------|---------------|
| Free | 5 | 3 | No | No | 0 | $0 |
| Team | 50 | 15 | 20/month | No | 0 | $12 |
| Creator/Business | Unlimited | Unlimited | Unlimited | Yes | 500K/month | $29 |
| Pro/Power | Unlimited | Unlimited | Unlimited | Yes | Unlimited | $79 |

## Password Requirements
- Minimum 8 characters
- At least 1 uppercase letter
- At least 1 number
