# AGENTS.md - AppHub API (AI Agent Reference)

## Overview
AppHub-API is an Express.js REST API for a team portal where users upload, share, and manage single-file HTML tools. Uses PostgreSQL, JWT auth, Stripe billing, and AI services (Anthropic Claude + Google Gemini).

## Tech Stack
- **Framework**: Express.js (Node.js)
- **Database**: PostgreSQL (connection pool)
- **Auth**: JWT in httpOnly cookies (jsonwebtoken + bcryptjs)
- **AI**: @anthropic-ai/sdk (Claude), @google/generative-ai (Gemini)
- **Payments**: Stripe
- **Email**: Resend
- **File Processing**: multer, sharp, cheerio, acorn, adm-zip
- **Security**: helmet, cors, express-rate-limit

## Project Structure
```
config/
  db.js              - PostgreSQL connection pool (20 connections, 30s idle)
  plans.js           - Subscription tier definitions and limits
  demoApps.js        - Demo app seeding data
  migrate.js         - Database schema migrations (idempotent)
middleware/
  auth.js            - JWT verification, adminOnly, validateId
  subscription.js    - Plan enforcement (app/member limits, AI gating, token budgets)
routes/
  auth.js            - Registration, login, password reset, sandbox tokens
  apps.js            - App CRUD, uploads, AI conversion, file handling
  folders.js         - User-specific folder organization
  workspace.js       - Workspace settings, member management, invitations
  subscription.js    - Stripe checkout, billing portal, webhooks
  sandbox.js         - Iframe app serving with CSP headers
  convert.js         - Tiered LLM file conversion (multi-file to HTML)
  builder.js         - AI App Builder (generate, revise, publish)
services/
  appBuilder.js      - LLM-powered app generation/revision with prompt caching
  aiConvert.js       - AI conversion for non-HTML uploads
  converter.js       - Tiered LLM orchestration (Gemini Tier1 -> Claude Tier2)
  fileDetection.js   - File type detection and conversion prompts
  fileProcessor.js   - File manifest building from uploads
  htmlValidator.js   - JavaScript validation (syntax, TDZ errors)
  email.js           - Email templates via Resend
  llmClient.js       - LLM abstraction layer (Anthropic, Gemini, OpenAI-compatible)
  validator.js       - HTML output validation
index.js             - Express app setup, middleware chain, error handlers
```

## Database Schema

### workspaces
- id (UUID PK), name, slug (unique)
- plan: free | team | business | power
- primaryColor, accentColor, primaryColorLight, accentColorLight
- stripe_customer_id, stripe_subscription_id
- ai_conversions_used, ai_conversions_reset_at
- builder_tokens_used, builder_tokens_reset_at
- logo_data (base64 PNG)

### users
- id (UUID PK), workspace_id (FK), email, password_hash, display_name
- role: admin | member
- reset_token, reset_token_expires, last_login_at, is_active

### apps
- id (UUID PK), workspace_id (FK), uploaded_by (FK)
- name, description, icon, file_content (TEXT - full HTML)
- original_filename, file_size, sort_order
- visibility: private | team | specific
- is_demo, demo_category
- pending_delete, delete_requested_by

### app_shares
- app_id (FK), user_id (FK) - for "specific" visibility

### app_folders
- id (UUID PK), workspace_id, user_id, name, icon, sort_order

### app_folder_items
- folder_id (FK), app_id (FK), sort_order

### invitations
- id (UUID PK), workspace_id (FK), email, invited_by (FK), accepted

### conversion_jobs
- id (UUID PK), workspace_id, user_id, status, html, error, original_filename

### builder_sessions
- id (UUID PK), workspace_id, user_id, name, app_type, description
- features (JSONB), style_preferences (JSONB)
- complexity, target_audience, additional_notes
- status: draft | generating | done | published
- current_html, revision_count, total_tokens_used

### builder_jobs
- id (UUID PK), session_id (FK), workspace_id, user_id
- job_type: generate | revise | review
- status: processing | reviewing | done | failed
- input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens

## API Endpoints

### Auth (/api/auth)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /register | - | Create account + workspace |
| POST | /check-email | - | Check email status (exists/invited/unknown) |
| POST | /accept-invite | - | Join workspace via invitation |
| POST | /login | - | Authenticate (returns JWT cookie) |
| POST | /logout | - | Clear JWT cookie |
| GET | /me | Yes | Current user + workspace info |
| POST | /change-password | Yes | Update password |
| POST | /request-reset | - | Send reset email |
| POST | /reset-password | - | Reset with token |
| POST | /admin-reset | Admin | Generate reset link for member |
| GET | /sandbox-token | Yes | Short-lived iframe auth token (1hr) |

### Apps (/api/apps)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | / | Yes | List visible apps (respects permissions) |
| GET | /stats | Yes | Workspace app statistics |
| GET | /:id | Yes | Get app details |
| GET | /:id/source | Yes | Download HTML source |
| POST | /check | Yes | Detect file type, get conversion prompt |
| POST | /upload | Yes+Limit | Upload HTML app (FormData with 'file') |
| POST | /convert | Yes+Paid | Start AI conversion (async) |
| GET | /convert/:jobId | Yes | Poll conversion status |
| PUT | /:id | Yes | Update metadata (name, desc, visibility) |
| PUT | /:id/file | Yes | Replace app HTML file |
| PUT | /reorder | Yes | Batch reorder app sort_order |
| DELETE | /:id | Yes | Request deletion (pending admin approval) |
| GET | /pending-deletions | Admin | List apps awaiting deletion |
| POST | /:id/approve-deletion | Admin | Approve deletion |
| POST | /:id/reject-deletion | Admin | Reject deletion |

### Folders (/api/folders)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | / | Yes | List folders with nested apps |
| POST | / | Yes | Create folder (requires 2+ appIds) |
| PUT | /:id | Yes | Update folder name/icon |
| PUT | /:id/reorder | Yes | Reorder items in folder |
| DELETE | /:id | Yes | Delete folder (keeps apps) |
| DELETE | /:id/items/:appId | Yes | Remove app from folder |

### Workspace (/api/workspace)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | / | Yes | Get workspace details |
| PUT | / | Admin | Update name, colors |
| GET | /logo | Yes | Get workspace logo |
| GET | /logo/:id | - | Get logo by workspace ID (public) |
| POST | /logo | Admin | Upload workspace logo |
| GET | /members | Yes | List team members |
| POST | /invite | Admin+Limit | Invite by email |
| POST | /remove-member | Admin | Deactivate member |

### Subscription (/api/subscription)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /status | Yes | Plan, usage, limits |
| POST | /checkout | Admin | Create Stripe checkout |
| POST | /portal | Admin | Stripe customer portal |
| GET | /checkout-landing | - | Pre-registration checkout |
| GET | /verify-session | - | Verify Stripe session |
| POST | /webhook | - | Stripe webhook handler |

### Builder (/api/builder)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /usage | Builder | Token usage and limits |
| GET | /sessions | Builder | List sessions |
| POST | /sessions | Builder | Create session |
| GET | /sessions/:id | Yes | Get session (includes HTML) |
| POST | /sessions/:id/generate | Builder+Budget | Start generation (async) |
| GET | /sessions/:id/jobs/:jobId | Yes | Poll job status |
| POST | /sessions/:id/revise | Builder+Budget | Start revision (async) |
| POST | /sessions/:id/publish | Yes | Publish as app |
| DELETE | /sessions/:id | Yes | Delete session |

### Sandbox (/sandbox)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /:appId?token=xxx | Token | Serve HTML in iframe with CSP |

### Health
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/health | DB connectivity check |

## Subscription Plans
| Plan | maxApps | maxMembers | AI Convert | Builder | Builder Tokens | Price |
|------|---------|------------|------------|---------|---------------|-------|
| free | 5 | 3 | No | No | 0 | $0 |
| team | 50 | 15 | Yes (20/mo) | No | 0 | $12/mo |
| business | Unlimited | Unlimited | Yes | Yes | 500K/mo | $29/mo |
| power | Unlimited | Unlimited | Yes | Yes | Unlimited | $79/mo |

## Authentication
- JWT signed with JWT_SECRET, 7-day expiry
- Stored in httpOnly cookie (path: /api)
- Payload: { id, email, workspaceId, role }
- Production: Secure flag, SameSite: none
- Sandbox uses separate short-lived tokens (1 hour)

## Middleware Chain
1. helmet (security headers)
2. CORS (exact origin matching, credentials allowed)
3. Cookie parser
4. Morgan (request logging)
5. Rate limiters (auth: 30/15min, api: 200/15min, upload: 50/hr)
6. JSON body parser (skipped for Stripe webhook)
7. Route-level: auth(), adminOnly(), validateId()
8. Route-level: enforceAppLimit(), enforceMemberLimit(), requirePaidAI(), requireAppBuilder(), checkTokenBudget()

## Error Codes
| Status | Meaning | Special Fields |
|--------|---------|---------------|
| 400 | Bad request / validation | |
| 401 | Not authenticated | |
| 403 | Forbidden (role/plan) | error: 'upgrade_required' |
| 404 | Not found | |
| 409 | Conflict (already processing) | |
| 413 | File too large (>5MB) | |
| 422 | Code errors in HTML | errors: [...], canAutoFix |
| 429 | Rate limited / plan limit | error: 'plan_limit', error: 'token_budget_exceeded' |

## Environment Variables
### Required
- DATABASE_URL - PostgreSQL connection string
- JWT_SECRET - JWT signing secret
- CLIENT_URL - Frontend URL (CORS, invite links)

### AI
- ANTHROPIC_API_KEY - Claude API key
- TIER1_PROVIDER / TIER1_MODEL / TIER1_API_KEY - Fast converter (default: gemini)
- TIER2_PROVIDER / TIER2_MODEL / TIER2_API_KEY - Fallback converter (default: anthropic)
- BUILDER_MODEL - AI builder model (default: claude-sonnet-4-20250514)

### Email
- RESEND_API_KEY - Resend email service
- EMAIL_FROM - Sender address

### Stripe
- STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
- STRIPE_PRICE_TEAM, STRIPE_PRICE_BUSINESS, STRIPE_PRICE_POWER

### Dev
- DEV_BYPASS_PLAN=true - Treats as Power plan, skips all limits

## Key Patterns
1. **Workspace isolation**: All queries filter by workspace_id
2. **Async jobs**: Created in DB, background processing, client polls status
3. **Soft deletes**: Apps use pending_delete + admin approval workflow
4. **Tiered AI**: Gemini (fast/cheap) first, Claude (capable) as fallback
5. **Prompt caching**: Builder uses Anthropic prompt caching for efficiency
6. **Transactions**: Multi-step operations use BEGIN/COMMIT/ROLLBACK

## Development
```bash
npm install
cp .env.example .env   # Fill in values
node config/migrate.js  # Create/update tables
npm run dev             # Starts on port 3001
```

## Common Tasks for AI Agents
1. **Adding endpoint**: Create route handler in routes/, register in index.js
2. **Adding middleware**: Add to middleware/ directory, apply in route or globally
3. **Database changes**: Add migration in config/migrate.js (idempotent ALTER TABLE)
4. **Plan gating**: Use subscription middleware (enforceAppLimit, requirePaidAI, etc.)
5. **Email template**: Add to services/email.js
6. **AI integration**: Use services/llmClient.js abstraction layer
