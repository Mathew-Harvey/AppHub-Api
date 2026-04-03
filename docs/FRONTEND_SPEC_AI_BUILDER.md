# AI App Builder — Frontend Specification

> For the frontend team. This document covers every API endpoint, UI component, and interaction flow needed to integrate the AI App Builder feature.

## Plan Gating

The builder is available on **Business** ($29/mo) and **Power User** ($79/mo) plans only. Free and Team users should see an upgrade CTA instead of the builder UI.

Check the user's plan from the existing `/api/auth/me` response:

```json
{
  "workspace": {
    "plan": "business",
    "planLimits": {
      "appBuilder": true,
      "builderTokenLimit": 500000
    }
  }
}
```

If `planLimits.appBuilder` is `false`, show the upgrade prompt.

---

## 1. Token Usage Meter

### API

```
GET /api/builder/usage
```

**Response (Business plan):**
```json
{
  "used": 142300,
  "limit": 500000,
  "remaining": 357700,
  "percentage": 28.46,
  "resetAt": "2026-05-03T00:00:00.000Z",
  "plan": "business",
  "unlimited": false
}
```

**Response (Power User):**
```json
{
  "used": 842000,
  "limit": null,
  "remaining": null,
  "percentage": 0,
  "resetAt": "2026-05-03T00:00:00.000Z",
  "plan": "power",
  "unlimited": true
}
```

### UI Component: Credits Meter

Display a progress bar in the builder sidebar/header:

- Show `used` / `limit` tokens with a percentage bar
- Color coding: green (0-60%), yellow (60-85%), red (85-100%)
- Show reset date: "Resets on May 3"
- For Power Users: show "Unlimited" badge instead of a bar
- When at 100%: disable generate/revise buttons, show "Upgrade to Power User for unlimited builds"

---

## 2. Guided Form (Session Creation)

### The "App Designer" UI

This is a multi-step form or a single-page guided form. Its purpose is to help users who struggle to express what they want. Use friendly, encouraging copy.

### Step 1: What are you building?

| Field | Type | Required | Options |
|-------|------|----------|---------|
| `name` | text input | yes | Max 100 chars. Placeholder: "My Awesome App" |
| `appType` | select/cards | no | `game`, `tool`, `dashboard`, `form`, `calculator`, `landing-page`, `other` |

Display app types as visual cards with icons:
- 🎮 Game
- 🛠️ Tool
- 📊 Dashboard
- 📝 Form
- 🧮 Calculator
- 🌐 Landing Page
- ✨ Other

### Step 2: Describe your app

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `description` | textarea | no | Max 2000 chars. Placeholder: "A todo list app that helps me track daily tasks with categories and priority levels" |
| `features` | tag input / list builder | no | Max 20 items, 300 chars each. Users add features one by one. Placeholder: "Add a feature, e.g. 'Dark mode toggle'" |

For features, use a list builder UI:
- Text input + "Add" button
- Each feature shows as a pill/tag with remove button
- Show count: "3 / 20 features"

**Helper copy below textarea:** "Don't worry about being too technical — describe it like you're telling a friend what you want."

### Step 3: Style preferences

| Field | Type | Options |
|-------|------|---------|
| `stylePreferences.colorScheme` | select/cards | `dark`, `light`, `colorful`, `minimal` |
| `stylePreferences.layoutStyle` | select/cards | `centered`, `sidebar`, `fullscreen`, `dashboard-grid` |
| `stylePreferences.fontStyle` | select/cards | `modern`, `classic`, `playful`, `monospace` |

Display as visual swatches/previews if possible.

### Step 4: Final details

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `complexity` | radio/cards | no | `simple`, `moderate`, `complex`. Default: `moderate` |
| `targetAudience` | text input | no | Max 255 chars. Placeholder: "Internal team members" |
| `additionalNotes` | textarea | no | Max 2000 chars. Placeholder: "Any other details or specific requirements" |

### API Call

```
POST /api/builder/sessions
Content-Type: application/json

{
  "name": "Task Tracker",
  "appType": "tool",
  "description": "A task management app with categories, priority levels, and due dates",
  "features": [
    "Add, edit, and delete tasks",
    "Assign priority (low, medium, high)",
    "Filter by category",
    "Dark mode toggle",
    "Local storage persistence"
  ],
  "stylePreferences": {
    "colorScheme": "dark",
    "layoutStyle": "centered",
    "fontStyle": "modern"
  },
  "complexity": "moderate",
  "targetAudience": "Internal team",
  "additionalNotes": ""
}
```

**Success Response (201):**
```json
{
  "session": {
    "id": "uuid",
    "appType": "tool",
    "name": "Task Tracker",
    "description": "...",
    "features": ["..."],
    "stylePreferences": { "colorScheme": "dark", "layoutStyle": "centered", "fontStyle": "modern" },
    "complexity": "moderate",
    "status": "draft",
    "hasHtml": false,
    "revisionCount": 0,
    "totalTokensUsed": 0,
    "createdAt": "...",
    "updatedAt": "..."
  },
  "complexityWarning": "This is a complex app. For best results with very complex applications, consider using Claude Opus or the latest ChatGPT to build it, then upload the HTML file directly to AppHub.",
  "complexityLevel": "high",
  "usage": { "used": 142300, "limit": 500000, "..." : "..." }
}
```

### Complexity Warning Banner

If `complexityWarning` is non-null, show a yellow/amber banner:

> ⚠️ **Complex App Detected**
> This is a complex app. For best results with very complex applications, consider using Claude Opus or the latest ChatGPT to build it, then upload the HTML file directly to AppHub.
> [Continue Anyway] [Upload HTML Instead]

---

## 3. Generation Flow

### Trigger

After session is created, user clicks "Generate App" button.

```
POST /api/builder/sessions/:sessionId/generate
```

**Response:**
```json
{ "jobId": "uuid" }
```

### Polling

Poll every 2 seconds:

```
GET /api/builder/sessions/:sessionId/jobs/:jobId
```

**While processing:**
```json
{ "status": "processing" }
```

**On success:**
```json
{
  "status": "done",
  "html": "<!DOCTYPE html>...",
  "reviewNotes": ["All features implemented correctly"],
  "jobType": "generate",
  "tokensUsed": {
    "input": 1250,
    "output": 8400,
    "cacheRead": 0,
    "cacheCreation": 1250
  }
}
```

**On failure:**
```json
{
  "status": "failed",
  "error": "Generation failed. Please try again."
}
```

### Loading UI

During generation (30-90 seconds typical):
- Show a progress animation/skeleton
- Display encouraging messages that rotate:
  - "Building your app..."
  - "Writing the HTML and CSS..."
  - "Adding interactivity..."
  - "Running quality checks..."
  - "Almost there..."
- Show estimated time: "This usually takes 30-60 seconds"

### Preview

On success:
- Render the HTML in a sandboxed iframe (same pattern as existing app preview)
- Show the review notes as a subtle info section
- Buttons: **"Publish to AppHub"**, **"Request Changes"**, **"Start Over"**

---

## 4. Revision Flow

### UI: Chat-like Feedback

Below the preview iframe, show a text input:

> 💬 **What would you like to change?**
> [textarea: "Make the header blue and add a search bar"]
> [Send Feedback]

Max 2000 characters. Show character count.

Also display revision history:
- "Revision 1: Make the header blue..." ✓
- "Revision 2: Add export button..." (in progress)

### API Call

```
POST /api/builder/sessions/:sessionId/revise
Content-Type: application/json

{
  "feedback": "Make the header blue and add a search bar at the top"
}
```

**Response:** Same as generate — returns `{ jobId }`, poll for result.

### After Revision

- Update the iframe preview with new HTML
- Increment revision count display
- Show updated token usage
- Keep the feedback input ready for another revision

---

## 5. Publish Flow

When the user is happy with the preview:

```
POST /api/builder/sessions/:sessionId/publish
Content-Type: application/json

{
  "name": "Task Tracker",
  "description": "A task management tool for the team",
  "icon": "📋",
  "visibility": "team",
  "sharedWith": []
}
```

**Response (201):**
```json
{
  "app": {
    "id": "uuid",
    "name": "Task Tracker",
    "description": "...",
    "icon": "📋",
    "visibility": "team",
    "createdAt": "..."
  }
}
```

### Publish Dialog

Show a modal/dialog with:
- App name (pre-filled from session, editable)
- Description (pre-filled, editable)
- Icon picker (emoji, default 🤖)
- Visibility selector: Team / Private / Specific people
- If "Specific people": member multi-select (same as existing upload flow)
- **"Publish"** button

After publish, redirect to the app in the main AppHub view. Show a success toast: "Your app has been published!"

---

## 6. Session Management

### List Sessions

```
GET /api/builder/sessions
```

**Response:**
```json
{
  "sessions": [
    {
      "id": "uuid",
      "appType": "tool",
      "name": "Task Tracker",
      "status": "done",
      "hasHtml": true,
      "revisionCount": 2,
      "totalTokensUsed": 24500,
      "createdAt": "...",
      "updatedAt": "..."
    }
  ]
}
```

Show a "My Builds" section in the builder UI — list of past sessions with status badges (Draft, Generating, Done, Published).

### Get Session Detail

```
GET /api/builder/sessions/:id
```

Returns full session including `currentHtml` for re-opening a previous build.

### Delete Session

```
DELETE /api/builder/sessions/:id
```

Returns `{ "ok": true }`.

---

## 7. Error States

### Token Budget Exceeded (429)

```json
{
  "error": "token_budget_exceeded",
  "message": "You've used all 500,000 AI tokens this month. Upgrade to Power User for unlimited builds.",
  "used": 500000,
  "limit": 500000,
  "resetAt": "2026-05-03T00:00:00Z"
}
```

**UI:** Disable generate/revise buttons. Show:
> You've used your monthly AI token budget.
> Resets on May 3, 2026.
> [Upgrade to Power User →]

### Plan Upgrade Required (403)

```json
{
  "error": "upgrade_required",
  "message": "AI App Builder requires a Business or Power User plan.",
  "currentPlan": "team",
  "requiredPlans": ["business", "power"]
}
```

**UI:** Instead of the builder, show:
> **AI App Builder**
> Build apps with AI — describe what you want and we'll generate it for you.
> Available on Business ($29/mo) and Power User ($79/mo) plans.
> [Upgrade Now →]

### Generation Failed

Show error message with a "Try Again" button. Keep the session intact so the user doesn't lose their form data.

### Already Generating (409)

```json
{ "error": "A generation is already in progress for this session" }
```

Show the polling UI for the existing job.

---

## 8. Subscription Status (Updated)

The existing `GET /api/subscription/status` now returns builder usage:

```json
{
  "plan": "business",
  "planName": "Business",
  "appBuilder": true,
  "builderTokenLimit": 500000,
  "usage": {
    "apps": 12,
    "members": 5,
    "aiConversions": 8,
    "builderTokensUsed": 142300,
    "builderTokensLimit": 500000,
    "builderTokensResetAt": "2026-04-03T00:00:00Z",
    "builderTokensPercentage": 28.46
  }
}
```

### Checkout (Updated)

The checkout endpoint now accepts a `planKey` in the body:

```
POST /api/subscription/checkout
{ "planKey": "business" }
```

Valid values: `"team"`, `"business"`, `"power"`.

---

## 9. Recommended Page Structure

```
/builder                  → Session list + "New Build" button
/builder/new              → Guided form (steps 1-4)
/builder/:sessionId       → Preview + revise + publish
```

### Navigation

Add "AI Builder" to the main sidebar/nav. Show a sparkle/AI icon. If the user's plan doesn't support it, show a lock icon with "Upgrade" tooltip.

---

## 10. Polling Strategy

For generate/revise jobs:
1. Poll every **2 seconds** for the first 30 seconds
2. Then every **4 seconds** for the next 60 seconds
3. Then every **8 seconds** after that
4. Timeout after **5 minutes** — show "This is taking longer than expected. You can close this and come back later."

The session status persists in the DB, so the user can navigate away and return.
