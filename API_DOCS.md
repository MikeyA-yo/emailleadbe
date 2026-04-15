# Email Lead Generation API — Documentation

> **Base URL:** `http://localhost:5000`

---

## Agent Pipeline (recommended flow)

Two entry points depending on your data source:

**Starting from HubSpot contacts (new):**
```
1. POST /api/agent/hubspot-to-linkedin      → Gemini finds LinkedIn profile for each HubSpot contact
2. POST /api/agent/rank-csuite-targets      → score & filter to C-suite leads
3. POST /api/agent/save-candidates          → persist accepted leads
```

**Starting from public search (original):**
```
1. POST /api/agent/search-public-profiles   → discover LinkedIn profile URLs
2. POST /api/agent/extract-profile-signals  → fetch & parse each profile (HTML + AI)
3. POST /api/agent/ai-enrich-profiles       → AI re-enrichment for any still-incomplete profiles
4. POST /api/agent/rank-csuite-targets      → score & filter to C-suite leads
5. POST /api/agent/save-candidates          → persist accepted leads
```

Steps 2 and 3 of the public search flow are complementary — run 3 on the output of 2 for any candidates still flagged `insufficientPublicData`.

---

## Lead Verification Pipeline (NEW)

Autonomous AI agent that compares HubSpot CRM data against live LinkedIn profiles and categorizes each lead:

```
1. POST /api/verification/run              → Scan HubSpot contacts, find LinkedIn, compare & categorize
2. GET  /api/verification/results          → Browse results filtered by status (Match/Stale/Discrepancy)
3. GET  /api/verification/stats            → Dashboard summary counts
4. POST /api/verification/sync/:id         → Push corrected data back to HubSpot (single)
5. POST /api/verification/sync-bulk        → Push corrected data back to HubSpot (batch)
6. POST /api/verification/discard/:id      → Soft-delete a result
```

**Verification Statuses:**
| Status | Meaning |
| --- | --- |
| `match` | HubSpot data matches LinkedIn — lead is verified and current. |
| `stale` | Lead has **moved to a different company**. New company & title identified. |
| `discrepancy` | Lead is at the **same company** but has a **different job title** (e.g. promotion). |
| `not_found` | Could not find a LinkedIn profile for this contact. |
| `error` | An error occurred during verification (e.g. LinkedIn blocked the fetch). |
| `unverified` | Verification could not be completed (insufficient data). |

---

## Endpoints

### 1. Health Check

|              |                                                     |
| ------------ | --------------------------------------------------- |
| **Method**   | `GET`                                               |
| **URL**      | `/`                                                 |
| **Response** | Plain text: `Email Lead Generation API is running!` |

---

### 2. Get All Leads

|              |                                            |
| ------------ | ------------------------------------------ |
| **Method**   | `GET`                                      |
| **URL**      | `/api/leads`                               |
| **Response** | `application/json` — Array of lead objects |

#### Query Parameters

| Param | Type | Description |
| --- | --- | --- |
| `search` | `string` | Filter leads by name, title, company, or email |

#### Response Example

```json
[
  {
    "url": "https://www.linkedin.com/in/williamhgates/",
    "email": "bill@example.com",
    "type": "linkedin",
    "name": "Bill Gates",
    "title": "Chair, Gates Foundation and Founder, Breakthrough Energy",
    "contextForAI": "...",
    "isCSuite": true
  },
  {
    "profileUrl": "https://www.linkedin.com/in/some-profile",
    "name": "Jane Doe",
    "title": "CEO at SomeCompany",
    "location": "London, United Kingdom",
    "company": "SomeCompany",
    "companyName": "SomeCompany",
    "companyWebsite": "https://somecompany.com",
    "about": "",
    "experience": "...",
    "isCSuite": true,
    "contextForAI": "...",
    "searchKeyword": "CEO"
  }
]
```

#### Lead Object Fields

| Field           | Type      | Description                                                |
| --------------- | --------- | ---------------------------------------------------------- |
| `url`           | `string?` | LinkedIn profile URL (older format leads)                  |
| `profileUrl`    | `string?` | LinkedIn profile URL (newer format leads)                  |
| `email`         | `string?` | Contact email (not always present)                         |
| `name`          | `string`  | Full name of the lead                                      |
| `title`         | `string`  | Job title                                                  |
| `company`       | `string?` | Company name                                               |
| `companyName`   | `string?` | Company name from LinkedIn source data                     |
| `companyWebsite`| `string?` | Company website from LinkedIn source data                  |
| `location`      | `string?` | Geographic location                                        |
| `about`         | `string?` | Bio / about section                                        |
| `experience`    | `string?` | Work experience text                                       |
| `contextForAI`  | `string`  | Scraped LinkedIn profile context used for email generation |
| `isCSuite`      | `boolean` | Whether the lead is a C-suite executive                    |
| `searchKeyword` | `string?` | The keyword used to find this lead                         |

> **Note:** LinkedIn-related workflows now use a hybrid intake path (public search/fetch + dedupe + persistence). `src/linkedin.json` is retained as a bootstrap fallback source when anonymous public collection is blocked.

---

### 3. Generate Personalized Email

|                  |                       |
| ---------------- | --------------------- |
| **Method**       | `POST`                |
| **URL**          | `/api/generate-email` |
| **Content-Type** | `application/json`    |

#### Request Body

```json
{
  "identifier": "Bill Gates",
  "company": "Microsoft",
  "context": "We are selling an AI-powered CRM tool for enterprise companies."
}
```

| Field        | Type     | Required | Description                                                                                                                             |
| ------------ | -------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `identifier` | `string` | ✅ Yes   | Used to find the lead. Can be: **name**, **email**, **url**, or **profileUrl**                                                          |
| `company`    | `string` | ❌ No    | Explicitly provide the company name, taking precedence over default scraped or CRM data                                                 |
| `context`    | `string` | ❌ No    | Additional instructions or context for the AI to tailor the email (e.g. what product you're selling, the tone, specific talking points) |

#### Success Response — `200`

```json
{
  "success": true,
  "text": "Subject: Transforming Enterprise CRM with AI\n\nHi Bill,\n\nI hope this message finds you well...",
  "leadName": "Bill Gates"
}
```

| Field      | Type      | Description                                                       |
| ---------- | --------- | ----------------------------------------------------------------- |
| `success`  | `boolean` | Always `true` on success                                          |
| `text`     | `string`  | The generated email in **plain text** (ready to display directly) |
| `leadName` | `string`  | Name of the matched lead                                          |

#### Error Response — `404` (Lead Not Found)

```json
{
  "error": "Lead not found. Please provide a valid email, profileUrl, url, or name as identifier."
}
```

#### Error Response — `500` (Generation Failed)

```json
{
  "error": "Failed to generate email"
}
```

---

### 4. Send Email

|                  |                    |
| ---------------- | ------------------ |
| **Method**       | `POST`             |
| **URL**          | `/api/send-email`  |
| **Content-Type** | `application/json` |

#### Request Body

```json
{
  "to": "recipient@example.com",
  "subject": "Let's Connect — AI-Powered CRM for Enterprise",
  "text": "Hi Bill,\n\nI hope this message finds you well..."
}
```

| Field     | Type     | Required | Description                                                       |
| --------- | -------- | -------- | ----------------------------------------------------------------- |
| `to`      | `string` | ✅ Yes   | Recipient email address                                           |
| `subject` | `string` | ✅ Yes   | Email subject line                                                |
| `text`    | `string` | ✅ Yes   | Plain text email body (use the `text` from `/api/generate-email`) |

#### Success Response — `200`

```json
{
  "success": true,
  "messageId": "<abc123@smtp.office365.com>"
}
```

#### Error Response — `400` (Missing Fields)

```json
{
  "error": "Missing required fields: to, subject, text"
}
```

#### Error Response — `500` (Send Failed)

```json
{
  "error": "Failed to send email",
  "details": "Invalid login: 535 5.7.3 Authentication unsuccessful"
}
```

---

### 5. Search HubSpot Contacts Directly

|                  |                    |
| ---------------- | ------------------ |
| **Method**       | `POST` or `GET`    |
| **URL**          | `/api/hubspot/search` |
| **Content-Type** | `application/json` (if POST) |

#### Query Parameters or Request Body

| Field | Type | Description |
| --- | --- | --- |
| `company` | `string` | Filter by company name |
| `role` | `string` | Filter by job title |
| `region` | `string` | Filter by state, city, or country |
| `interacted` | `boolean` | If `true`, returns contacts that have opened an email. If `false`, returns contacts that have NOT opened an email. |
| `limit` | `number` | Number of results to return (default: `50`) |
| `after` | `string` | Pagination cursor returned from a previous search |

#### Example Search Request Body
```json
{
  "company": "Coresight",
  "role": "Manager",
  "region": "California",
  "interacted": true
}
```
*Alternatively, you can provide the parameters in the URL:*
`/api/hubspot/search?company=Coresight&role=Manager&region=California&interacted=true`

#### Success Response
```json
{
  "total": 15,
  "results": [
    {
      "id": "12345",
      "properties": {
        "firstname": "John",
        "lastname": "Doe",
        "company": "Coresight",
        "jobtitle": "Marketing Manager",
        "state": "California",
        "city": "Los Angeles",
        "country": "United States",
        "industry": "Retail",
        "hs_email_last_open_date": "2024-05-12T08:32:00Z",
        "hs_email_last_click_date": "2024-05-13T10:00:00Z",
        "lastmodifieddate": "2024-06-01T00:00:00Z"
      }
    }
  ],
  "paging": {
    "next": {
      "after": "100"
    }
  }
}
```

| Property | Description |
| --- | --- |
| `industry` | Industry as set in HubSpot (e.g. `"Retail"`, `"Real Estate"`). `null` if not set. |
| `lastmodifieddate` | Date the contact was last modified in HubSpot. `null` if blank. (Replaced `notes_last_activity_date` which does not exist in HubSpot.) |
| `hs_email_last_open_date` | Last date the contact opened an email sent via HubSpot. |
| `hs_email_last_click_date` | Last date the contact clicked a link in a HubSpot email. |

---

### 5.1 HubSpot Diagnostics — Property Definitions
**GET** `/api/hubspot/diagnostics/properties`

Returns HubSpot property metadata (type, fieldType, valid options) for the filter fields used by the search and verification endpoints. Useful for debugging operator mismatches.

```json
{
  "company": { "name": "company", "label": "Company Name", "type": "string", "fieldType": "text" },
  "jobtitle": { "name": "jobtitle", "label": "Job Title", "type": "string", "fieldType": "text" },
  "hs_lead_status": { "name": "hs_lead_status", "type": "enumeration", "options": [...] }
}
```

### 5.2 HubSpot Diagnostics — Sample Contacts
**GET** `/api/hubspot/diagnostics/sample`

Fetches 20 contacts directly from the HubSpot API with real property values. Useful for verifying what data actually exists in the CRM.

```json
{
  "sampleSize": 20,
  "sample": [
    { "id": "123", "firstname": "Jane", "lastname": "Doe", "company": "Acme", "jobtitle": "VP Sales", ... }
  ]
}
```

---

## 6. Agentic LinkedIn Lead Intake (Phase 1 MVP)

All endpoints below are best-effort public-page collection only (no login required, no paid fallback source).

### 6.0 HubSpot → LinkedIn Agent (Gemini-powered)
**POST** `/api/agent/hubspot-to-linkedin`

Uses Gemini AI with function-calling tools to find the LinkedIn profile for each contact already in HubSpot. Gemini is given two tools it can call autonomously:
- `search_web` — searches DuckDuckGo (Bing fallback) and returns any `linkedin.com/in/` URLs found
- `fetch_linkedin_page` — fetches a LinkedIn profile page to confirm name/title/company match

Returns candidates in the **standard agent format**, ready to pipe directly into `POST /api/agent/rank-csuite-targets` and `POST /api/agent/save-candidates`.

> **Note:** Only contacts that have both a name and a company are eligible (required for a meaningful search). Cap `limit` at 25 per call to stay within Gemini rate limits.

Fetches contacts **directly from the HubSpot API** on every call (no in-memory cache). Supports cursor-based pagination via `nextCursor`.

#### Request Body

```json
{
  "limit": 10,
  "after": "optional-cursor-from-previous-response"
}
```

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `limit` | `number` | `10` | How many HubSpot contacts to fetch and process per call. Max `25`. |
| `after` | `string` | — | Pagination cursor. Pass the `nextCursor` value from a previous response to get the next page. |

#### Success Response

```json
{
  "processed": 10,
  "eligible": 8,
  "found": 6,
  "notFound": 2,
  "nextCursor": "AoJ...",
  "note": "Pipe candidates into POST /api/agent/rank-csuite-targets then POST /api/agent/save-candidates. Pass nextCursor as 'after' to process the next page.",
  "candidates": [
    {
      "identifier": "https://linkedin.com/in/jane-doe",
      "profileUrl": "https://linkedin.com/in/jane-doe",
      "name": "Jane Doe",
      "title": "Chief Operating Officer",
      "company": "Acme Corp",
      "sector": "retail",
      "isCSuite": true,
      "confidence": 0.8,
      "provenance": {
        "sourceUrl": "https://linkedin.com/in/jane-doe",
        "fetchedAt": "2026-04-13T00:00:00.000Z",
        "method": "hubspot-to-linkedin-agent"
      },
      "signals": {
        "titleMatch": true,
        "sectorMatch": true,
        "companyMatch": true
      },
      "hubspotId": "12345",
      "hubspotEmail": "jane@acmecorp.com"
    }
  ]
}
```

| Field | Description |
| --- | --- |
| `processed` | Total contacts fetched from HubSpot on this call |
| `eligible` | Contacts that had both a name and company (required for LinkedIn search) |
| `found` | Contacts for which a LinkedIn profile was found |
| `notFound` | Contacts where Gemini could not find a confident match |
| `nextCursor` | Pass as `after` in the next request to get the next page. `null` means no more pages. |

#### Recommended flow

```
1. POST /api/agent/hubspot-to-linkedin       → discover LinkedIn profiles for HubSpot contacts
2. POST /api/agent/rank-csuite-targets       → score & filter to C-suite leads
3. POST /api/agent/save-candidates           → persist accepted leads
```

---

### 6.1 Search Public Profiles
**POST** `/api/agent/search-public-profiles`

Builds company/sector-first public queries and returns candidate profile URLs with provenance.

```json
{
  "companies": ["Target", "Shopify"],
  "sectors": ["retail", "commerce"],
  "titles": ["CEO", "COO", "CTO"],
  "limit": 20,
  "seedProfileUrls": ["https://www.linkedin.com/in/example/"]
}
```

### 6.2 Extract Profile Signals
**POST** `/api/agent/extract-profile-signals`

Fetches public profile pages, extracts signals, and returns canonical candidates with confidence + provenance.

```json
{
  "profiles": [
    {
      "profileUrl": "https://www.linkedin.com/in/example/",
      "company": "Target",
      "sector": "retail"
    }
  ]
}
```

### 6.3 Rank C-Suite Targets
**POST** `/api/agent/rank-csuite-targets`

Ranks candidates and marks each as `accept` or `insufficient_public_data`.

```json
{
  "minConfidence": 0.65,
  "candidates": []
}
```

### 6.4 Save Candidates
**POST** `/api/agent/save-candidates`

Persists only candidates above confidence threshold and rejects low-evidence records.

```json
{
  "minConfidence": 0.65,
  "candidates": []
}
```

### Canonical Candidate Contract

```json
{
  "identifier": "https://linkedin.com/in/example",
  "name": "Jane Doe",
  "title": "Chief Operating Officer",
  "company": "Example Co",
  "sector": "retail",
  "isCSuite": true,
  "confidence": 0.82,
  "provenance": {
    "sourceUrl": "https://www.linkedin.com/in/example/",
    "fetchedAt": "2026-04-12T00:00:00.000Z",
    "method": "public-profile-fetch"
  },
  "signals": {
    "titleMatch": true,
    "sectorMatch": true,
    "companyMatch": true
  }
}
```

`POST /api/generate-email` now enforces a confidence guardrail for persisted agentic candidates and blocks generation when confidence is below threshold.

---

## 7. Group Management and Bulk Actions

### 7.1 Get All Groups
**GET** `/api/groups`
Returns an array of all saved groups.

### 7.2 Create a Group
**POST** `/api/groups`
```json
{
  "name": "Q3 CEO Campaign"
}
```

### 7.3 Update Contacts in a Group
**PUT** `/api/groups/:id/contacts`
Replace the entire list of contacts in a group.
```json
{
  "contacts": [
    { "identifier": "bill@example.com", "leadSource": "linkedin", "name": "Bill Gates" },
    { "identifier": "51", "leadSource": "hubspot" }
  ]
}
```

### 7.4 Add Contacts to a Group (Append)
**POST** `/api/groups/:id/contacts`
Appends new contacts to an existing group without deleting the old ones.
```json
{
  "contacts": [
    { "identifier": "newuser@example.com", "leadSource": "linkedin", "name": "New User" }
  ]
}
```

### 7.5 Remove a Contact from a Group
**DELETE** `/api/groups/:id/contacts/:identifier`
Removes a specific contact from the group by their exact `identifier`. (For emails and URLs, ensure the parameter is URL-encoded).

### 7.6 Generate Bulk Emails
**POST** `/api/bulk-generate-email`
Generates a unique, high-quality email template specifically for your provided `context` (the campaign topic). The backend automatically handles replacing `{{Name}}` and `{{Company}}` locally for everyone in the group, ensuring you never hit AI rate limits.

You can supply a `groupId` to target a saved group, or an array of raw `identifiers`.

**Request Body:**
```json
{
  "groupId": "64abcdef1234567890abcdef",
  "context": "We just published a new research brief on AI in retail. Ask if they are exploring this topic."
}
```

| Field | Type | Description |
| --- | --- | --- |
| `groupId` | `string` | The ID of the saved group. |
| `identifiers` | `array` | Optional alternative: Array of strings (HubSpot IDs/emails) to target directly instead of a `groupId`. |
| `context` | `string` | The campaign topic/instructions. The AI uses this exactly to craft the specific master group template! |

**Returns:**
```json
{
  "results": [
    { "identifier": "51", "success": true, "text": "Subject: ...", "leadName": "John" }
  ]
}
```

### 7.7 Send Bulk Emails
**POST** `/api/bulk-send-email`
Pass an array of emails to logically send them all concurrently.
```json
{
  "emails": [
    { "to": "test@example.com", "subject": "Hello", "text": "Hi there..." }
  ]
}
```

---

## 8. Lead Verification & Enrichment (NEW)

The verification system compares HubSpot CRM data against real-time LinkedIn profiles to detect job changes, promotions, and stale leads.

### 8.1 Run Verification
**POST** `/api/verification/run`

Triggers AI-powered verification for a batch of HubSpot contacts. For each contact, the agent:
1. Discovers their LinkedIn profile (using existing HubSpot URL or Gemini agent search)
2. Fetches the LinkedIn profile and extracts current company + title
3. Compares HubSpot data vs LinkedIn data using AI semantic matching
4. Categorizes the lead as `match`, `stale`, or `discrepancy`
5. Generates an AI summary blurb explaining the finding

#### Request Body

```json
{
  "filters": {
    "industry": "Retail",
    "company": "Nike",
    "role": "Director",
    "region": "California",
    "lastUpdatedDays": 90,
    "leadStatus": "New"
  },
  "limit": 10,
  "after": "optional-cursor-from-previous-response"
}
```

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `filters.industry` | `string` | — | Filter HubSpot contacts by industry |
| `filters.company` | `string` | — | Filter by company name |
| `filters.role` | `string` | — | Filter by job title |
| `filters.region` | `string` | — | Filter by state, city, or country |
| `filters.lastUpdatedDays` | `number` | — | Only include contacts whose `lastmodifieddate` is **older** than N days (converted to millisecond timestamp internally) |
| `filters.leadStatus` | `string` | — | Filter by HubSpot lead status. Valid values: `"NEW"`, `"IN_PROGRESS"`, `"CONNECTED"`, `"OPEN_DEAL"`, `"UNQUALIFIED"`, `"BAD_TIMING"` (case-sensitive, uses `EQ` operator) |
| `limit` | `number` | `10` | How many contacts to process per call. Max `25`. |
| `after` | `string` | — | Pagination cursor from a previous response |

#### Success Response

```json
{
  "batchId": "batch_1713020000000",
  "processed": 10,
  "results": {
    "match": 5,
    "stale": 3,
    "discrepancy": 1,
    "not_found": 1,
    "error": 0,
    "unverified": 0
  },
  "nextCursor": "abc123",
  "verifications": [
    {
      "_id": "663a...",
      "hubspotContactId": "12345",
      "hubspotData": {
        "firstName": "John",
        "lastName": "Smith",
        "fullName": "John Smith",
        "company": "Nike",
        "jobTitle": "Director of Marketing",
        "email": "john@nike.com",
        "industry": "Retail",
        "leadStatus": "New"
      },
      "linkedinData": {
        "profileUrl": "https://linkedin.com/in/johnsmith",
        "name": "John Smith",
        "currentCompany": "Adidas",
        "currentTitle": "Senior Director of Digital Commerce",
        "headline": "Senior Director at Adidas",
        "location": "Portland, OR"
      },
      "status": "stale",
      "changes": {
        "previousCompany": "Nike",
        "previousTitle": "Director of Marketing",
        "newCompany": "Adidas",
        "newTitle": "Senior Director of Digital Commerce",
        "companyChanged": true,
        "titleChanged": true
      },
      "aiSummary": "John moved from Nike to Adidas, now serving as Senior Director of Digital Commerce.",
      "aiConfidence": 0.92,
      "batchId": "batch_1713020000000",
      "verifiedAt": "2026-04-13T18:00:00.000Z",
      "hubspotSyncedAt": null,
      "discarded": false
    }
  ]
}
```

| Field | Description |
| --- | --- |
| `batchId` | Unique ID for this verification run. Use for filtering or bulk sync. |
| `processed` | Total contacts fetched from HubSpot |
| `results` | Count of verifications by status |
| `nextCursor` | Pass as `after` to process the next page. `null` = no more pages. |
| `verifications` | Array of full verification result objects |

---

### 8.2 Get Verification Results
**GET** `/api/verification/results`

Returns paginated, filterable verification results for the dashboard.

#### Query Parameters

| Param | Type | Default | Description |
| --- | --- | --- | --- |
| `status` | `string` | `all` | Filter by status: `match`, `stale`, `discrepancy`, `not_found`, `error`, or `all` |
| `batchId` | `string` | — | Filter by batch ID |
| `limit` | `number` | `50` | Max results per page (max: 200) |
| `offset` | `number` | `0` | Pagination offset |
| `search` | `string` | — | Search by name, company, or email |
| `discarded` | `boolean` | `false` | Set to `true` to include discarded results |

#### Success Response

```json
{
  "results": [ /* array of verification result objects */ ],
  "total": 150,
  "limit": 50,
  "offset": 0
}
```

---

### 8.3 Get Single Verification Result
**GET** `/api/verification/results/:id`

Returns a single verification result by its MongoDB `_id`.

---

### 8.4 Get Verification Stats
**GET** `/api/verification/stats`

Returns dashboard summary statistics.

```json
{
  "total": 500,
  "match": 380,
  "stale": 75,
  "discrepancy": 40,
  "not_found": 5,
  "error": 0,
  "unverified": 0,
  "lastRunAt": "2026-04-13T18:00:00.000Z",
  "averageConfidence": 0.87
}
```

---

### 8.5 Sync to HubSpot (Single)
**POST** `/api/verification/sync/:id`

Pushes corrected data back to HubSpot for a verified lead. Updates:
- `company` — if the lead moved (stale)
- `jobtitle` — if the lead has a new role (stale or discrepancy)
- `lead_verification_status` — custom property (auto-created if missing)
- `lead_last_verified_at` — custom property (auto-created if missing)

#### Success Response — Match (no update needed)

```json
{
  "success": true,
  "message": "No update needed — HubSpot data already matches LinkedIn.",
  "hubspotContactId": "12345"
}
```

#### Success Response — Stale/Discrepancy (updated)

```json
{
  "success": true,
  "message": "HubSpot contact 12345 updated successfully.",
  "updatedProperties": {
    "company": "Adidas",
    "jobtitle": "Senior Director of Digital Commerce",
    "lead_verification_status": "stale",
    "lead_last_verified_at": "2026-04-13T18:30:00.000Z"
  },
  "hubspotContactId": "12345"
}
```

---

### 8.6 Sync to HubSpot (Bulk)
**POST** `/api/verification/sync-bulk`

Bulk writes verified data back to HubSpot.

#### Request Body

```json
{
  "verificationIds": ["id1", "id2", "id3"]
}
```
*or:*
```json
{
  "batchId": "batch_1713020000000"
}
```

| Field | Type | Description |
| --- | --- | --- |
| `verificationIds` | `array` | Specific verification result IDs to sync |
| `batchId` | `string` | Sync all stale/discrepancy results from a batch |

#### Success Response

```json
{
  "success": true,
  "synced": 8,
  "failed": 1,
  "results": [
    {
      "id": "663a...",
      "hubspotContactId": "12345",
      "success": true,
      "status": "stale",
      "updatedProperties": { "company": "Adidas", "jobtitle": "Senior Director" }
    },
    {
      "id": "663b...",
      "hubspotContactId": "67890",
      "success": false,
      "status": "discrepancy",
      "error": "HubSpot returned 403"
    }
  ]
}
```

---

### 8.7 Discard Verification Result
**POST** `/api/verification/discard/:id`

Soft-deletes a verification result. It will no longer appear in default result queries but can be viewed with `?discarded=true`.

```json
{
  "success": true,
  "id": "663a...",
  "discarded": true
}
```

---

## Frontend Integration Examples

### Fetch All Leads

```javascript
const response = await fetch("http://localhost:5000/api/leads");
const leads = await response.json();
// leads is an array of lead objects
```

### Generate Email for a Lead

```javascript
const response = await fetch("http://localhost:5000/api/generate-email", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    identifier: "Bill Gates", // or use profileUrl / email
    context: "Pitch our AI analytics platform for nonprofits",
  }),
});

const data = await response.json();

if (data.success) {
  // data.text contains the plain text email — render directly
  console.log(data.text);
} else {
  console.error(data.error);
}
```

### Send an Email

```javascript
const response = await fetch("http://localhost:5000/api/send-email", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    to: "recipient@example.com",
    subject: "Let's Connect",
    text: generatedEmailText, // plain text from /api/generate-email
  }),
});

const data = await response.json();

if (data.success) {
  console.log("Sent! Message ID:", data.messageId);
} else {
  console.error(data.error, data.details);
}
```

### Run Lead Verification

```javascript
// Step 1: Trigger verification for a batch of contacts
const verifyResponse = await fetch("http://localhost:5000/api/verification/run", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    filters: {
      industry: "Retail",
      lastUpdatedDays: 90,
    },
    limit: 10,
  }),
});

const verifyData = await verifyResponse.json();
console.log(`Match: ${verifyData.results.match}, Stale: ${verifyData.results.stale}, Discrepancy: ${verifyData.results.discrepancy}`);

// Step 2: Browse results filtered by status
const staleResponse = await fetch("http://localhost:5000/api/verification/results?status=stale");
const staleLeads = await staleResponse.json();

// Step 3: Get dashboard stats
const statsResponse = await fetch("http://localhost:5000/api/verification/stats");
const stats = await statsResponse.json();

// Step 4: Sync a verified lead back to HubSpot
const syncResponse = await fetch(`http://localhost:5000/api/verification/sync/${verifyData.verifications[0]._id}`, {
  method: "POST",
});
const syncData = await syncResponse.json();

// Step 5: Bulk sync all stale/discrepancy results from a batch
const bulkSyncResponse = await fetch("http://localhost:5000/api/verification/sync-bulk", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ batchId: verifyData.batchId }),
});
```

---

## CORS

CORS is enabled for all origins (`*`), so the frontend can call the API from any domain during development.

---

## Environment Variables

| Variable         | Description                                                  |
| ---------------- | ------------------------------------------------------------ |
| `GEMINI_API_KEY` | Your Google Gemini API key (required for email generation and verification) |
| `HUBSPOT_TOKEN`  | HubSpot Private App Token for CRM read/write operations      |
| `MONGODB_URI`    | MongoDB connection string (required for groups, agent leads, and verification) |
| `SMTP_USER`      | SMTP sender email (defaults to `elijahandrew1610@gmail.com`) |
| `SMTP_PASS`      | SMTP password / app password for Gmail                       |
| `AGENT_MIN_CONFIDENCE` | Minimum confidence threshold for agent leads (default: `0.65`) |

### Running the Server

```bash
# Development (with hot reload)
GEMINI_API_KEY="your-key" npm run dev

# Production
npm run build
GEMINI_API_KEY="your-key" npm start
```
