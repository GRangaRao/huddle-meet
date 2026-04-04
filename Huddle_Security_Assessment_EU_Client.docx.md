# Huddle Video Call — Security & Compliance Assessment
## European Client Q&A Response
### Date: April 2, 2026

---

## 1. Authorization of Protocols

- **Authentication:** Google Firebase Sign-In (OAuth2). Server issues HMAC-signed session cookies (HttpOnly, SameSite, 7-day expiry).
- **Room authorization:** Host controls (mute/kick/admit/lock/waiting room) enforced server-side.
- **Gap:** Room join and scheduling APIs currently lack server-side auth checks. This needs hardening for enterprise use.

---

## 2. Security Protocols / European Standards

- **Media encryption:** DTLS-SRTP (mandatory) via mediasoup SFU — all audio/video encrypted in transit.
- **Signaling encryption:** WSS (TLS 1.2+) for all WebSocket signaling.
- **Standards gap:** No formal compliance with ISO 27001, BSI C5, or eIDAS. No penetration test reports or SOC 2 Type II certification yet.

---

## 3. Regional Standards

- The app is hosted on Render (US-based infrastructure). For EU deployment, it can be self-hosted on EU infrastructure (Docker container provided).
- No data residency guarantees with current cloud setup.
- For DACH/EU clients: Would need deployment on EU region (e.g., AWS eu-west, Hetzner, OVH).

---

## 4. Data Security / Sensitivity

- **Media:** Never stored on any server. DTLS-SRTP encrypted in transit, decrypted only at mediasoup SFU for routing (standard for all SFU architectures — same as Zoom, Teams, Meet).
- **Recordings:** Client-side only (browser MediaRecorder), downloaded as .webm directly to user's device. No cloud recording storage.
- **Chat messages:** Persisted in PostgreSQL if DB configured. No encryption at rest currently.
- **Shared files:** In-memory only, lost on room close/server restart. Never written to disk.
- **Meeting passcodes:** Currently stored in plaintext. Needs hashing for production.

---

## 5. How We Compare to Zoom's Post-COVID Security Improvements

| Feature | Zoom (post-2020) | Huddle |
|---|---|---|
| E2E encryption | Optional (Phase 2) | DTLS-SRTP (end-to-hop via SFU) |
| Waiting room | Yes | Yes (server-enforced) |
| Meeting passcodes | Hashed | Plaintext — needs fix |
| Host controls (mute/kick/lock) | Yes | Yes (server-enforced) |
| Server-side recording | Cloud recording | No server recording at all — client-only |
| Attention tracking | Removed | Never had it |
| Data routing control | Geo-fencing | Self-hostable Docker for EU |

---

## 6. Cost & Conversation Privacy (No 3rd Party Exposure)

- **Media path:** Client → (DTLS-SRTP) → mediasoup SFU → (DTLS-SRTP) → Other clients. No media data leaves the server. No third-party analytics, AI transcription, or ad-tech touches the media stream.
- **Third parties involved:** Firebase (auth only — no media), Render (hosting), Vercel (static landing page only). None of these see media content.
- **Self-hosting option:** Docker image available — deploy entirely on your own EU infrastructure with zero third-party dependencies (replace Firebase with local auth).

---

## 7. Video Recordings and Content on Cloud

- **No cloud recording exists.** Recordings are captured in the user's browser and downloaded as a local file. The server never sees the recording.
- **No S3, no Firebase Storage, no cloud storage** of any kind for recordings.
- For enterprise clients who WANT cloud recording, this would need to be built as a feature with encrypted storage (AES-256 at rest) and user-controlled retention.

---

## Summary: Approvals, Confidentiality & Data Security

| Question | Answer |
|---|---|
| Is media encrypted? | Yes — DTLS-SRTP via mediasoup (end-to-hop to SFU) or browser WebRTC (end-to-end in P2P fallback) |
| Are recordings stored in the cloud? | No — recordings are client-side only, downloaded directly to the user's device |
| What data is persisted on servers? | Scheduled meetings (topic, passcode, date, creator), chat messages (if PostgreSQL enabled) |
| Which third parties access data? | Firebase/Google (auth only), Render (hosting), Vercel (static pages only). None see media. |
| Is the app GDPR-compliant? | Not fully yet — lacks privacy policy, consent mechanisms, data subject rights, retention policies, and DPAs |
| Are passcodes secure? | Stored in plaintext currently — needs hashing for production |
| Is there server-side recording? | No |

---

## Roadmap: EU/Enterprise Readiness

### P0 — Critical (Before EU Deployment)
- Privacy policy + cookie consent banner
- Hash meeting passcodes (bcrypt/argon2)
- Add server-side authentication to all API endpoints

### P1 — High Priority
- EU-hosted deployment option (Docker on EU infrastructure)
- Data retention policy + auto-cleanup for chat/meetings
- GDPR data subject rights implementation (export/delete user data)
- Data Processing Agreements with Firebase/Render

### P2 — Planned
- Penetration test + SOC 2 / ISO 27001 roadmap
- End-to-end encryption option (Insertable Streams API)

---

## Technical Architecture Overview

```
Client Browser
    ├── WSS (TLS signaling) ──→ Python aiohttp server (Render/EU host)
    │                               ├── HTTP (localhost) → Node.js mediasoup worker
    │                               ├── PostgreSQL (optional)
    │                               └── GitHub API (meeting backup)
    └── WebRTC (DTLS-SRTP media) ──→ mediasoup SFU (same host)
                                        └── SRTP media routed to other clients
```

- **Signaling:** Client ↔ (TLS) ↔ Python WebSocket server
- **Media (SFU mode):** Client ↔ (DTLS-SRTP) ↔ mediasoup ↔ (DTLS-SRTP) ↔ Other clients
- **Media (P2P fallback):** Client ↔ (DTLS-SRTP) ↔ Client directly

---

*This document is based on codebase analysis as of April 2, 2026. Huddle v1.1.0.*
