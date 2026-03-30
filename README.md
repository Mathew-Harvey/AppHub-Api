# AppHub API

Backend service for [AppHub-Web](https://github.com/Mathew-Harvey/AppHub-Web) — a team portal for sharing vibe-coded HTML tools.

## Stack

Node.js, Express, PostgreSQL, JWT (httpOnly cookies), Multer, Helmet.

## Local Development

```bash
git clone https://github.com/Mathew-Harvey/AppHub-Api.git
cd AppHub-Api
npm install
cp .env.example .env   # edit with your local Postgres URL
npm run db:migrate
npm run dev             # → http://localhost:3001
```

Then start [AppHub-Web](https://github.com/Mathew-Harvey/AppHub-Web) which proxies `/api` and `/sandbox` to this service via Vite.

## Deploy to Render

1. Create a **Web Service** pointing to this repo
2. Build: `npm install` / Start: `node index.js`
3. Create a **PostgreSQL** database, connect via `DATABASE_URL`
4. Set env vars: `NODE_ENV=production`, `JWT_SECRET` (generate), `CLIENT_URL` (your AppHub-Web URL), `UPLOAD_DIR=/opt/render/project/src/uploads`
5. After first deploy, open Shell and run `npm run db:migrate`

⚠️ Render's filesystem is ephemeral — uploaded apps are lost on redeploy. Swap to Cloudflare R2 or S3 for persistence (isolated change in `routes/apps.js` and `routes/sandbox.js`).

## API Endpoints

**Auth:** register, login, logout, me  
**Apps:** list, get, check file type, upload, update, delete  
**Workspace:** get, update branding, upload logo, manage members, invite/revoke  
**Sandbox:** `GET /sandbox/:appId` — serves HTML app with CSP headers (used by iframe)  
**Health:** `GET /api/health`
