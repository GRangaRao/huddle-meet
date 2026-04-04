# Huddle Meet — Compliance & Privacy Integration Plan

**Document Version:** 1.0  
**Date:** April 4, 2026  
**Author:** Engineering Team  
**Status:** Draft  

---

## 1. Data Retention Policy & Auto-Cleanup

### 1.1 Retention Periods

| Data Type | Retention Period | Storage Location | Cleanup Method |
|---|---|---|---|
| Chat messages (in-room) | 30 days | In-memory / PostgreSQL | Background task purge |
| Meeting recordings | 7 days or user-deleted | Server filesystem | Scheduled deletion |
| Scheduled meetings (past) | 90 days after meeting date | GitHub flat-file / PostgreSQL | Background task purge |
| Room session data | Room close + 24 hours | In-memory | Auto-cleanup on room close |
| Auth sessions | 7 days | In-memory (`auth_sessions`) | TTL-based expiry |
| Shared files (in-room) | 30 days | Server filesystem | Scheduled deletion |
| PIN tokens | 365 days (yearly rotation) | Client-side localStorage | Token expiry validation |
| Audit logs | 1 year | PostgreSQL / flat-file | Annual rotation |

### 1.2 Server-Side Changes Required

#### 1.2.1 Environment Variables

```
CHAT_RETENTION_DAYS=30
MEETING_RETENTION_DAYS=90
RECORDING_RETENTION_DAYS=7
FILE_RETENTION_DAYS=30
AUDIT_LOG_RETENTION_DAYS=365
SESSION_MAX_AGE_HOURS=168
```

#### 1.2.2 Background Cleanup Task (`server.py`)

Add an `asyncio` background task that runs every hour:

```python
async def data_cleanup_task():
    """Periodic task to purge expired data per retention policy."""
    while True:
        await asyncio.sleep(3600)  # Run every hour
        now = time.time()

        # 1. Expire auth sessions
        expired = [sid for sid, s in auth_sessions.items()
                   if now - s["created"] > SESSION_MAX_AGE]
        for sid in expired:
            del auth_sessions[sid]

        # 2. Purge old chat messages from DB
        if db_pool:
            cutoff = datetime.utcnow() - timedelta(days=CHAT_RETENTION_DAYS)
            await db_pool.execute("DELETE FROM messages WHERE created_at < $1", cutoff)

        # 3. Purge past scheduled meetings
        if db_pool:
            cutoff = datetime.utcnow() - timedelta(days=MEETING_RETENTION_DAYS)
            await db_pool.execute("DELETE FROM scheduled_meetings WHERE date < $1", cutoff)

        # 4. Delete expired uploaded files
        purge_expired_files(FILE_RETENTION_DAYS)

        # 5. Clean up stale room data
        stale = [rid for rid, meta in room_meta.items()
                 if rid not in rooms and
                 now - parse_iso(meta["created"]) > 86400]
        for rid in stale:
            room_meta.pop(rid, None)

        print(f"[cleanup] Purged {len(expired)} sessions, {len(stale)} stale rooms")
```

Register on startup:
```python
async def on_startup(app):
    asyncio.create_task(data_cleanup_task())
```

#### 1.2.3 User Data Erasure Endpoint (GDPR Art. 17)

```
DELETE /api/user/data
```

- Requires authenticated session
- Deletes all data associated with the user's email/UID:
  - Chat messages authored by user
  - Scheduled meetings created by user
  - Uploaded files
  - Auth session
- Returns confirmation of deletion

---

## 2. Privacy Policy & Cookie Consent Banner

### 2.1 Privacy Policy Page

**File:** `static/privacy.html`

Must cover the following sections per GDPR Articles 13–14:

| Section | Content |
|---|---|
| **Data Controller** | Organisation name, contact email |
| **Data Collected** | Display name, email, profile picture (via Google Sign-in), IP address, meeting metadata, chat messages |
| **Purpose of Processing** | Providing video call service, meeting scheduling, user authentication |
| **Legal Basis** | Consent (cookie banner), Legitimate interest (service operation), Contract (providing the service) |
| **Data Processors** | Firebase/Google (authentication), Render.com (hosting), GitHub (meeting persistence) |
| **Data Retention** | Per retention table in Section 1.1 |
| **User Rights** | Access (Art. 15), Rectification (Art. 16), Erasure (Art. 17), Portability (Art. 20), Objection (Art. 21) |
| **International Transfers** | Data may be processed in US (Google/Firebase, Render, GitHub) — covered by EU-US Data Privacy Framework |
| **Cookie Information** | See Section 2.2 |
| **Contact / DPO** | Email address for data protection requests |

### 2.2 Cookies & Local Storage Used

| Name | Type | Purpose | Duration | Category |
|---|---|---|---|---|
| `huddle_session` | Cookie (HttpOnly) | Server session for authenticated user | 7 days | Strictly necessary |
| `huddle_pin_token` | localStorage | PIN authentication token | ~1 year | Strictly necessary |
| Firebase Auth cookies | Cookie (3rd party) | Google Sign-in session | Session | Functional |

### 2.3 Cookie Consent Banner

**Implementation in `index.html`:**

```html
<div id="cookieBanner" class="cookie-banner">
    <p>We use cookies for authentication and to provide our video call service.
       <a href="/static/privacy.html" target="_blank">Privacy Policy</a></p>
    <div class="cookie-actions">
        <button onclick="acceptCookies()">Accept</button>
        <button onclick="declineCookies()">Decline non-essential</button>
    </div>
</div>
```

**Logic:**
- Show banner on first visit (check `localStorage.getItem('cookie_consent')`)
- If declined: do not load Firebase Auth SDK (disable Google Sign-in)
- If accepted: proceed normally, store `cookie_consent=accepted`
- Must appear BEFORE any Firebase scripts load (for EU compliance)

### 2.4 Routes to Add

```
GET /static/privacy.html     — Privacy policy page
GET /api/privacy/consent      — Check consent status
POST /api/privacy/consent     — Record consent choice
DELETE /api/user/data          — User data erasure (GDPR Art. 17)
GET /api/user/data             — User data export (GDPR Art. 20)
```

---

## 3. Formal Compliance Requirements

### 3.1 ISO 27001 — Information Security Management System

| Control Domain | Current Status | Gap | Action Required |
|---|---|---|---|
| **A.5 Access Control** | PIN + Google Auth | No MFA beyond Google | Document access control policy |
| **A.8 Asset Management** | Partial | No data classification | Classify data types (public/internal/confidential) |
| **A.10 Cryptography** | WebRTC SRTP (in-transit) ✓ | No encryption at rest | Encrypt stored meeting data, chat logs |
| **A.12 Operations Security** | Basic logging | No structured audit trail | Implement audit logging (Section 3.4) |
| **A.14 System Acquisition** | Ad-hoc development | No SDLC documentation | Document secure development lifecycle |
| **A.16 Incident Management** | None | No incident response plan | Create incident response procedure |
| **A.18 Compliance** | None | No compliance documentation | Create ISMS documentation set |

**Key code changes for ISO 27001:**
1. Audit logging (see Section 3.4)
2. Encryption at rest for PostgreSQL data (enable `pgcrypto` or application-level AES-256)
3. Session timeout enforcement
4. Failed login attempt tracking and lockout

### 3.2 BSI C5 — Cloud Computing Compliance Criteria Catalogue

| C5 Domain | Requirement | Current Status | Action |
|---|---|---|---|
| **OIS** Organisation of InfoSec | Security roles defined | Not documented | Document roles & responsibilities |
| **AM** Asset Management | Data inventory | Not documented | Create data flow diagram |
| **COS** Cloud Ops Security | Logging & monitoring | Minimal logging | Implement audit logging |
| **KRY** Cryptography | Encryption in transit + at rest | Transit only (SRTP) | Add encryption at rest |
| **KOS** Communications Security | Network segmentation | N/A (single service) | Document architecture |
| **IDM** Identity & Access Mgmt | Authentication controls | Google Auth + PIN | Document IAM policy |
| **PSS** Physical Security | Data centre security | Render.com managed | Obtain Render's SOC 2 / ISO cert |
| **BEI** Ops & Comms Mgmt | Change management | Git-based | Document change control process |
| **SIM** Security Incident Mgmt | Incident response | None | Create incident response plan |
| **BCM** Business Continuity | Backup & recovery | GitHub persistence | Document backup & recovery plan |

**Key C5 requirements needing code changes:**
1. Structured audit logging with tamper protection
2. Data residency documentation (where is data stored geographically)
3. Automated vulnerability scanning integration

### 3.3 eIDAS — Electronic Identification and Trust Services

| eIDAS Component | Relevance to Huddle | Required Action |
|---|---|---|
| **Electronic Identification** | Google Sign-in provides authentication but is NOT a notified eID scheme | For formal eIDAS compliance: integrate national eID (BankID, eHerkenning, FranceConnect, etc.) |
| **Trust Services** | Not applicable unless providing electronic signatures | No action unless adding document signing |
| **Qualified Certificates** | Not applicable | No action |
| **eIDAS Level of Assurance** | Google Sign-in ≈ "Low" | For "Substantial" or "High": require government eID |

**eIDAS is only mandatory if:**
- The service is used by EU government agencies
- The service provides legally binding electronic signatures
- Cross-border identity verification is required

**For most commercial video calling, eIDAS compliance is NOT required.**

### 3.4 Audit Logging Implementation

**All three standards require structured audit logging.**

#### Server-side audit log function:

```python
async def audit_log(event: str, user: str, room_id: str, ip: str, details: str = ""):
    """Record a tamper-evident audit log entry."""
    entry = {
        "timestamp": datetime.utcnow().isoformat() + "Z",
        "event": event,
        "user": user,
        "room_id": room_id,
        "ip": ip,
        "details": details,
    }
    # Compute hash chain for tamper detection
    entry["hash"] = hashlib.sha256(
        json.dumps(entry, sort_keys=True).encode()
    ).hexdigest()

    if db_pool:
        await db_pool.execute(
            "INSERT INTO audit_log (timestamp, event, user_id, room_id, ip, details, hash) "
            "VALUES ($1, $2, $3, $4, $5, $6, $7)",
            entry["timestamp"], event, user, room_id, ip, details, entry["hash"]
        )
    else:
        print(f"[AUDIT] {json.dumps(entry)}")
```

#### Events to log:

| Event | When | Data Captured |
|---|---|---|
| `auth.login` | User signs in | email, IP, method (Google/PIN) |
| `auth.logout` | User signs out | email, IP |
| `auth.failed` | Failed login attempt | IP, method, reason |
| `room.create` | Room created | room_id, creator |
| `room.join` | Participant joins | room_id, user, IP, role |
| `room.leave` | Participant leaves | room_id, user, duration |
| `media.start` | Audio/video/screenshare started | room_id, user, media type |
| `media.stop` | Audio/video/screenshare stopped | room_id, user, media type |
| `chat.message` | Chat message sent | room_id, user (not message content) |
| `file.upload` | File shared | room_id, user, filename, size |
| `file.delete` | File removed | room_id, user, filename |
| `host.mute` | Host mutes participant | room_id, host, target |
| `host.kick` | Host removes participant | room_id, host, target |
| `meeting.schedule` | Meeting scheduled | meeting_id, creator |
| `meeting.cancel` | Meeting cancelled | meeting_id, user |
| `data.export` | User requests data export | user, IP |
| `data.delete` | User requests data deletion | user, IP |

---

## 4. Implementation Priority & Effort

| Priority | Item | Effort | Dependencies |
|---|---|---|---|
| **P0** | Cookie consent banner | 2 hours | None |
| **P0** | Privacy policy page | 4 hours | Legal review |
| **P1** | Audit logging | 4 hours | None |
| **P1** | Session timeout & expiry cleanup | 2 hours | None |
| **P1** | Auto-cleanup background task | 3 hours | None |
| **P2** | User data erasure endpoint | 3 hours | Audit logging |
| **P2** | User data export endpoint | 3 hours | Audit logging |
| **P2** | Encryption at rest | 4 hours | PostgreSQL |
| **P3** | ISO 27001 documentation set | 20+ hours | Organisational |
| **P3** | BSI C5 self-assessment | 20+ hours | Organisational |
| **P4** | eIDAS eID integration | 40+ hours | National eID provider |

---

## 5. Summary

| Standard | Code Changes Needed | Documentation Needed |
|---|---|---|
| **GDPR / Privacy** | Cookie consent, privacy page, data erasure/export endpoints, auto-cleanup | Privacy policy, data processing records |
| **ISO 27001** | Audit logging, encryption at rest, session management | ISMS policies, risk assessment, incident response plan |
| **BSI C5** | Audit logging, encryption at rest | C5 self-assessment, data residency docs, architecture diagram |
| **eIDAS** | Only if government/legal use: national eID integration | Assurance level documentation |

---

*This document serves as the integration plan. Each section should be reviewed by legal counsel before implementation.*
