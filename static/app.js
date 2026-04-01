/* Huddle Video Call App - WebRTC Client (v2.2-calendar) */

// ── Cloud URL for shareable links (desktop app runs on localhost) ─────────
let _shareBaseUrl = "https://huddle-meet.onrender.com";
function getShareableOrigin() {
    return _shareBaseUrl;
}

// ── State ────────────────────────────────────────────────────────────────
let ws = null;
let localStream = null;
let screenStream = null;
let myPeerId = null;
let myName = "Guest";
let roomId = null;
let micEnabled = true;
let camEnabled = false;
let screenSharing = false;
let chatOpen = false;
let recording = false;
let mediaRecorder = null;
let recordedChunks = [];
let recordingStartTime = null;
let recordingTimerInterval = null;
let myRole = "participant";
let handRaised = false;
let meetingStartTime = null;
let meetingTimerInterval = null;
let bgBlurEnabled = false;
let bgBlurCanvas = null;
let bgBlurCtx = null;
let bgBlurStream = null;
let selfieSegmenter = null;
let segMask = null;
let vbgTempVideo = null;
let vbgSceneBg = null;
let vbgMode = null; // 'blur' | 'scene'
let vbgPersonCanvas = null;
let vbgPersonCtx = null;
let vbgMaskCanvas = null;
let vbgMaskCtx = null;
let vbgTempMaskCanvas = null;
let vbgTempMaskCtx = null;
let vbgPrevMask = null; // Uint8Array for temporal smoothing
let vbgUseFallback = false;
let vbgFallbackMask = null;
let viewMode = "gallery"; // "gallery" | "speaker"
let pinnedPeerId = null;
let currentVbg = "none";
let audioAnalysers = {}; // peer_id -> { analyser, dataArray }
let isAuthenticated = false; // true after Firebase sign-in
let authenticatedUserName = ""; // Google sign-in display name

// Map of peer_id -> { videoEl, tile, name }
const peerConnections = {};

// ── mediasoup SFU State ──────────────────────────────────────────────────
let msDevice = null;         // mediasoup-client Device
let sendTransport = null;    // Send transport (local → SFU)
let recvTransport = null;    // Receive transport (SFU → local)
let audioProducer = null;    // Our audio Producer
let videoProducer = null;    // Our video Producer
let screenProducer = null;   // Our screen share Producer
let consumers = {};          // consumerId → { consumer, peerId, kind, source }
let myRtpCapabilities = null;

// ── Elements ─────────────────────────────────────────────────────────────
const joinScreen = document.getElementById("joinScreen");
const callScreen = document.getElementById("callScreen");
const nameInput = document.getElementById("nameInput");
const roomInput = document.getElementById("roomInput");
const newMeetingBtn = document.getElementById("newMeetingBtn");
const joinBtn = document.getElementById("joinBtn");
const previewVideo = document.getElementById("previewVideo");
const previewPlaceholder = document.getElementById("previewPlaceholder");
const previewMic = document.getElementById("previewMic");
const previewCam = document.getElementById("previewCam");
const videoGrid = document.getElementById("videoGrid");
const localVideo = document.getElementById("localVideo");
const localVideoOff = document.getElementById("localVideoOff");
const localName = document.getElementById("localName");
const localMicIndicator = document.getElementById("localMicIndicator");
const micBtn = document.getElementById("micBtn");
const camBtn = document.getElementById("camBtn");
const screenBtn = document.getElementById("screenBtn");
const chatBtn = document.getElementById("chatBtn");
const leaveBtn = document.getElementById("leaveBtn");
const copyLinkBtn = document.getElementById("copyLinkBtn");
const roomInfo = document.getElementById("roomInfo");
const peerCount = document.getElementById("peerCount");
const chatPanel = document.getElementById("chatPanel");
const chatMessages = document.getElementById("chatMessages");
const chatInput = document.getElementById("chatInput");
const sendChatBtn = document.getElementById("sendChatBtn");
const closeChatBtn = document.getElementById("closeChatBtn");
const toast = document.getElementById("toast");
const recordBtn = document.getElementById("recordBtn");

// ── Init ─────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
    // Check if URL has a room code
    const pathMatch = window.location.pathname.match(/^\/room\/([a-zA-Z0-9]+)/);
    if (pathMatch) {
        roomInput.value = pathMatch[1];
    }

    // Restore name from localStorage
    const savedName = localStorage.getItem("huddle_name");
    if (savedName) nameInput.value = savedName;

    // Check Google OAuth sign-in status
    checkAuthStatus();

    startPreview();
    setupJoinListeners();
});

// ── Firebase Auth ────────────────────────────────────────────────────────
let firebaseApp = null;
let firebaseAuth = null;

function initFirebase() {
    const cfg = window.HUDDLE_FIREBASE_CONFIG;
    if (!cfg || !cfg.apiKey) return false;
    try {
        firebaseApp = firebase.initializeApp(cfg);
        firebaseAuth = firebase.auth();
        return true;
    } catch (e) {
        console.warn("Firebase init failed:", e);
        return false;
    }
}

async function checkAuthStatus() {
    // First check if we have a server session
    try {
        const resp = await fetch("/api/auth/me");
        if (resp.ok) {
            const user = await resp.json();
            if (user.authenticated) {
                showSignedIn(user);
                return;
            }
        }
    } catch (e) { /* not signed in */ }

    // Fetch Firebase config from server and init
    try {
        const cfgResp = await fetch("/api/auth/config");
        if (cfgResp.ok) {
            const cfg = await cfgResp.json();
            if (cfg.shareBaseUrl) {
                _shareBaseUrl = cfg.shareBaseUrl;
            }
            if (cfg.configured) {
                window.HUDDLE_FIREBASE_CONFIG = cfg;
                initFirebase();
            }
        }
    } catch (e) { /* Firebase not available */ }

    // Show sign-in button (no guest option — sign-in required)
    showGoogleButton();
}

function showSignedIn(user) {
    isAuthenticated = true;
    authenticatedUserName = user.name || user.email || "";
    const btn = document.getElementById("googleSignInBtn");
    const info = document.getElementById("userInfo");
    const avatar = document.getElementById("userAvatar");
    const uname = document.getElementById("userName");
    const guestBtn = document.getElementById("authGuestBtn");

    if (btn) btn.style.display = "none";
    if (guestBtn) guestBtn.style.display = "none";
    if (info) {
        info.style.display = "flex";
        if (user.picture) {
            avatar.src = user.picture;
            avatar.style.display = "block";
        } else {
            avatar.style.display = "none";
        }
        uname.textContent = user.name || user.email;
    }
    if (nameInput && !nameInput.value.trim()) {
        nameInput.value = user.name || "";
    }
    document.getElementById("signOutBtn")?.addEventListener("click", async () => {
        if (firebaseAuth) {
            try { await firebaseAuth.signOut(); } catch (e) {}
        }
        await fetch("/api/auth/logout", { method: "POST" });
        location.reload();
    });
}

function showGoogleButton() {
    const btn = document.getElementById("googleSignInBtn");
    if (!btn) return;
    btn.style.display = "inline-flex";
    btn.addEventListener("click", async () => {
        if (!firebaseAuth) {
            showToast("Google sign-in not configured yet — joining as Guest");
            return;
        }
        try {
            const provider = new firebase.auth.GoogleAuthProvider();
            provider.setCustomParameters({ prompt: "select_account" });
            const result = await firebaseAuth.signInWithPopup(provider);
            const idToken = await result.user.getIdToken();

            // Send token to our server to create a session
            const resp = await fetch("/api/auth/firebase", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ idToken }),
            });
            if (resp.ok) {
                const data = await resp.json();
                showSignedIn(data);
            } else {
                showToast("Sign-in failed");
            }
        } catch (e) {
            if (e.code !== "auth/popup-closed-by-user") {
                console.error("Google sign-in error:", e);
                showToast("Sign-in error");
            }
        }
    });
}

// ── Camera Preview ───────────────────────────────────────────────────────
async function startPreview() {
    try {
        // Only acquire audio on page load — camera stays off until user toggles it
        localStream = await navigator.mediaDevices.getUserMedia({
            video: false,
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
            },
        });
        previewVideo.muted = true;
        previewPlaceholder.style.display = "flex";
        previewCam.classList.remove("active");
        camEnabled = false;
    } catch (e) {
        console.warn("Could not access mic:", e);
        previewPlaceholder.querySelector("p").textContent = "Camera not available";
    }
}

// ── Join Screen Listeners ────────────────────────────────────────────────
function setupJoinListeners() {
    previewMic.addEventListener("click", () => {
        micEnabled = !micEnabled;
        previewMic.classList.toggle("active", micEnabled);
        if (localStream) {
            localStream.getAudioTracks().forEach(t => t.enabled = micEnabled);
        }
    });

    previewCam.addEventListener("click", async () => {
        camEnabled = !camEnabled;
        previewCam.classList.toggle("active", camEnabled);
        if (camEnabled) {
            try {
                const videoStream = await navigator.mediaDevices.getUserMedia({ video: true });
                const videoTrack = videoStream.getVideoTracks()[0];
                // Remove any existing video tracks
                localStream.getVideoTracks().forEach(t => { t.stop(); localStream.removeTrack(t); });
                localStream.addTrack(videoTrack);
                previewVideo.srcObject = localStream;
                previewPlaceholder.style.display = "none";
            } catch (e) {
                console.warn("Could not access camera:", e);
                camEnabled = false;
                previewCam.classList.remove("active");
                showToast("Camera not available");
            }
        } else {
            localStream.getVideoTracks().forEach(t => { t.stop(); localStream.removeTrack(t); });
            previewPlaceholder.style.display = "flex";
        }
    });

    newMeetingBtn.addEventListener("click", async () => {
        if (!isAuthenticated) {
            showToast("Please sign in with Google to create or join a meeting");
            return;
        }
        try {
            const resp = await fetch("/api/create-room", { method: "POST" });
            const data = await resp.json();
            joinRoom(data.room_id);
        } catch (e) {
            showToast("Failed to create room");
        }
    });

    joinBtn.addEventListener("click", () => {
        const code = roomInput.value.trim();
        if (!code) {
            showToast("Please enter a room code");
            return;
        }
        joinRoom(code);
    });

    roomInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") joinBtn.click();
    });

    nameInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") newMeetingBtn.click();
    });
}

// ── Join Room ────────────────────────────────────────────────────────────
function joinRoom(id) {
    roomId = id;
    myName = nameInput.value.trim() || "Guest";
    localStorage.setItem("huddle_name", myName);

    // Ensure we have a stream with audio; add video only if camera was toggled on
    if (!localStream) {
        navigator.mediaDevices.getUserMedia({
            video: camEnabled,
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
            },
        })
            .then(stream => {
                localStream = stream;
                connectWebSocket();
            })
            .catch(() => {
                // Join without media
                connectWebSocket();
            });
    } else {
        connectWebSocket();
    }
}

// ── WebSocket Connection ─────────────────────────────────────────────────
function connectWebSocket() {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${window.location.host}/ws`);

    ws.onopen = () => {
        ws.send(JSON.stringify({
            action: "join",
            room_id: roomId,
            name: myName,
        }));
    };

    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        handleSignal(msg);
    };

    ws.onclose = () => {
        showToast("Disconnected from server");
    };

    ws.onerror = (err) => {
        console.error("WebSocket error:", err);
    };
}

// ── Signal Handler ───────────────────────────────────────────────────────
async function handleSignal(msg) {
    console.log("[signal]", msg.action, msg);
    switch (msg.action) {
        case "joined":
            myPeerId = msg.peer_id;
            myRole = msg.role || "participant";
            console.log("[me] My peer ID:", myPeerId, "role:", myRole);
            enterCallScreen();
            // Create peer tiles for existing participants
            for (const peer of msg.peers) {
                getOrCreatePeerTile(peer.id, peer.name);
            }
            // Start mediasoup device/transport setup
            await loadDevice();
            break;

        case "peer-joined":
            showToast(`${msg.name} joined`);
            console.log("[peer-joined]", msg.peer_id, msg.name);
            getOrCreatePeerTile(msg.peer_id, msg.name);
            updatePeerCount();
            updateParticipantList();
            break;

        case "peer-left":
            removePeer(msg.peer_id);
            updatePeerCount();
            updateParticipantList();
            break;

        // ── mediasoup SFU messages ──────────────────────────
        case "router-rtp-capabilities":
            await onRouterRtpCapabilities(msg.rtpCapabilities);
            break;

        case "transport-created":
            if (msg.direction === "send") {
                onSendTransportCreated(msg);
            } else {
                onRecvTransportCreated(msg);
            }
            break;

        case "transport-connected":
            console.log("[ms] Transport connected:", msg.transportId);
            break;

        case "produced": {
            const pSource = (msg.appData && msg.appData.source) || msg.kind;
            console.log("[ms] Produced:", msg.kind, msg.producerId, "source:", pSource);
            if (sendTransport && sendTransport._produceCallbacks) {
                const cb = sendTransport._produceCallbacks[pSource];
                if (cb) {
                    cb({ id: msg.producerId });
                    delete sendTransport._produceCallbacks[pSource];
                }
            }
            break;
        }

        case "consumed":
            onConsumed(msg);
            break;

        case "new-producer":
            onNewProducer(msg.producerId, msg.peerId, msg.kind, msg.appData);
            break;

        case "producer-closed":
            onProducerClosed(msg.producerId, msg.peerId);
            break;

        case "producer-paused":
            onProducerPaused(msg.peerId, msg.producerId, msg.kind, msg.paused);
            break;

        case "room-producers":
            for (const prod of (msg.producers || [])) {
                consumeProducer(prod.producerId, prod.peerId);
            }
            break;

        // ── Legacy P2P fallback ─────────────────────────────
        case "offer":
            handleP2POffer(msg.from, msg.data);
            break;

        case "answer":
            handleP2PAnswer(msg.from, msg.data);
            break;

        case "ice-candidate":
            handleP2PIce(msg.from, msg.data);
            break;

        case "chat":
            addChatMessage(msg.name, msg.text, msg.time);
            logTranscript('chat', msg.name, msg.text);
            if (!chatOpen) showToast(`${msg.name}: ${msg.text}`);
            break;

        case "error":
            showToast(msg.message);
            break;

        // ── Waiting room ────────────────────────────────────
        case "waiting-room":
            showWaitingRoom(msg.message);
            break;

        case "waiting-room-update":
            updateWaitingList(msg.waiting);
            break;

        case "denied":
            showToast(msg.message);
            leaveCall();
            break;

        // ── Hand raise ──────────────────────────────────────
        case "hand-raise":
            handleHandRaise(msg.peer_id, msg.name, msg.raised);
            break;

        case "all-hands-lowered":
            handleAllHandsLowered();
            break;

        // ── Reactions ───────────────────────────────────────
        case "reaction":
            showReaction(msg.emoji, msg.name);
            break;

        // ── Host controls ───────────────────────────────────
        case "host-changed":
            if (msg.new_host === myPeerId) {
                myRole = "host";
                showToast("You are now the host");
                showHostControls();
            } else {
                showToast(`${msg.name} is now the host`);
            }
            updateParticipantList();
            break;

        case "muted-by-host":
            micEnabled = false;
            micBtn.classList.remove("active");
            if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = false);
            // Pause mediasoup audio producer so audio stops at the SFU
            if (audioProducer && !audioProducer.paused) {
                audioProducer.pause();
                if (ws && ws.readyState === 1) {
                    ws.send(JSON.stringify({
                        action: "pause-producer",
                        producerId: audioProducer.id,
                        kind: "audio",
                        paused: true,
                    }));
                }
            }
            localMicIndicator.textContent = "🔇";
            localMicIndicator.classList.add("muted");
            updateParticipantList();
            showToast(msg.message);
            break;

        case "unmuted-by-host":
            micEnabled = true;
            micBtn.classList.add("active");
            if (localStream) {
                localStream.getAudioTracks().forEach(t => t.enabled = true);
            }
            if (audioProducer) {
                if (audioProducer.paused) audioProducer.resume();
                if (ws && ws.readyState === 1) {
                    ws.send(JSON.stringify({
                        action: "pause-producer",
                        producerId: audioProducer.id,
                        kind: "audio",
                        paused: false,
                    }));
                }
            }
            localMicIndicator.textContent = "🎤";
            localMicIndicator.classList.remove("muted");
            updateParticipantList();
            showToast(msg.message || "Host unmuted everyone");
            break;

        case "kicked":
            showToast(msg.message);
            leaveCall();
            break;

        case "setting-changed":
            showToast(`${msg.setting.replace('_', ' ')} ${msg.value ? 'enabled' : 'disabled'}`);
            if (msg.setting === "waiting_room") {
                const toggle = document.getElementById("waitingRoomToggle");
                if (toggle) toggle.checked = msg.value;
            }
            break;

        // ── Polls ───────────────────────────────────────────
        case "poll-started":
            renderPoll(msg.poll);
            showToast("New poll started!");
            break;

        case "poll-update":
            updatePollResults(msg.poll_id, msg.results, msg.total_votes);
            break;

        case "poll-ended":
            endPollDisplay(msg.poll_id, msg.results, msg.total_votes);
            break;

        // ── Whiteboard ──────────────────────────────────────
        case "whiteboard-sync":
            replayWhiteboardStrokes(msg.strokes);
            break;

        case "whiteboard-stroke":
            drawRemoteStroke(msg.stroke);
            break;

        case "whiteboard-clear":
            clearWhiteboardLocal();
            break;

        // ── Breakout rooms ──────────────────────────────────
        case "breakout-started":
            showToast("Breakout rooms started!");
            renderBreakoutActive(msg.rooms);
            break;

        case "breakout-ended":
            showToast("Breakout rooms ended");
            hideBreakoutActive();
            break;

        // ── Captions ────────────────────────────────────────
        case "caption":
            showCaption(msg.name, msg.text);
            logTranscript('speech', msg.name, msg.text);
            break;

        // ── Files ───────────────────────────────────────────
        case "file-shared":
            onFileShared(msg.file);
            break;

        case "file-deleted":
            onFileDeleted(msg.file_id);
            break;
    }
}

// ── Enter Call Screen ────────────────────────────────────────────────────
function enterCallScreen() {
    joinScreen.classList.remove("active");
    callScreen.classList.add("active");

    if (localStream) {
        localVideo.srcObject = localStream;
        localVideo.muted = true;
    }
    localVideoOff.style.display = camEnabled ? "none" : "";
    localName.textContent = `${myName} (You)`;
    localMicIndicator.textContent = micEnabled ? "🎤" : "🔇";
    localMicIndicator.classList.toggle("muted", !micEnabled);

    history.replaceState(null, "", `/room/${roomId}`);
    document.title = `Huddle - ${roomId}`;
    roomInfo.textContent = `Room: ${roomId}`;

    micBtn.classList.toggle("active", micEnabled);
    camBtn.classList.toggle("active", camEnabled);

    setupCallControls();
    updateGridLayout();
    updatePeerCount();
    updateParticipantList();

    // Start meeting timer
    meetingStartTime = Date.now();
    meetingTimerInterval = setInterval(updateMeetingTimer, 1000);
    updateMeetingTimer();

    // Show host controls if host
    if (myRole === "host") {
        showHostControls();
    }

    // Start speaker detection
    startSpeakerDetectionLoop();
    applyViewMode();
}

// ── Call Control Listeners ───────────────────────────────────────────────
function setupCallControls() {
    micBtn.addEventListener("click", toggleMic);
    camBtn.addEventListener("click", toggleCam);
    screenBtn.addEventListener("click", toggleScreenShare);
    recordBtn.addEventListener("click", toggleRecording);
    leaveBtn.addEventListener("click", leaveCall);

    // Chat
    chatBtn.addEventListener("click", () => {
        chatOpen = !chatOpen;
        chatPanel.classList.toggle("open", chatOpen);
        chatBtn.classList.toggle("active", chatOpen);
        closeSidePanels("chatPanel");
        if (chatOpen) chatInput.focus();
    });

    closeChatBtn.addEventListener("click", () => {
        chatOpen = false;
        chatPanel.classList.remove("open");
        chatBtn.classList.remove("active");
    });

    copyLinkBtn.addEventListener("click", () => {
        const shareOrigin = (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") ? "https://huddle-meet.onrender.com" : window.location.origin;
        const url = `${shareOrigin}/room/${roomId}`;
        navigator.clipboard.writeText(url).then(() => {
            showToast("Invite link copied!");
        }).catch(() => {
            showToast(url);
        });
    });

    sendChatBtn.addEventListener("click", sendChat);
    chatInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") sendChat();
    });

    // Hand raise
    document.getElementById("handBtn").addEventListener("click", toggleHandRaise);

    // Reactions
    document.querySelectorAll(".reaction-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            if (ws) ws.send(JSON.stringify({ action: "reaction", emoji: btn.dataset.emoji }));
        });
    });

    // Participants panel
    document.getElementById("participantsBtn").addEventListener("click", () => {
        const panel = document.getElementById("participantsPanel");
        const open = !panel.classList.contains("open");
        closeSidePanels("participantsPanel");
        panel.classList.toggle("open", open);
        document.getElementById("participantsBtn").classList.toggle("active", open);
        if (open) updateParticipantList();
    });
    document.getElementById("closeParticipantsBtn").addEventListener("click", () => {
        document.getElementById("participantsPanel").classList.remove("open");
        document.getElementById("participantsBtn").classList.remove("active");
    });

    // Host controls
    let allMuted = false;
    document.getElementById("muteAllBtn").addEventListener("click", () => {
        if (!ws) return;
        allMuted = !allMuted;
        const btn = document.getElementById("muteAllBtn");
        if (allMuted) {
            ws.send(JSON.stringify({ action: "mute-all" }));
            btn.textContent = "Unmute All";
        } else {
            ws.send(JSON.stringify({ action: "unmute-all" }));
            btn.textContent = "Mute All";
        }
        // Update all peer mic indicators on host side
        for (const pid in peerConnections) {
            if (pid.endsWith("_screen")) continue;
            const conn = peerConnections[pid];
            conn.muted = allMuted;
            const micInd = conn.tile ? conn.tile.querySelector(".mic-indicator") : null;
            if (micInd) {
                micInd.textContent = allMuted ? "\uD83D\uDD07" : "\uD83C\uDFA4";
                micInd.classList.toggle("muted", allMuted);
            }
        }
        updateParticipantList();
    });
    document.getElementById("lowerAllHandsBtn").addEventListener("click", () => {
        if (ws) ws.send(JSON.stringify({ action: "lower-all-hands" }));
    });
    document.getElementById("waitingRoomToggle").addEventListener("change", (e) => {
        if (ws) ws.send(JSON.stringify({ action: "toggle-waiting-room", enabled: e.target.checked }));
    });
    document.getElementById("lockMeetingToggle").addEventListener("change", (e) => {
        if (ws) ws.send(JSON.stringify({ action: "lock-meeting", locked: e.target.checked }));
    });

    // Waiting room leave
    document.getElementById("waitingLeaveBtn").addEventListener("click", leaveCall);

    // Whiteboard
    document.getElementById("whiteboardBtn").addEventListener("click", () => {
        const panel = document.getElementById("whiteboardPanel");
        const open = !panel.classList.contains("open");
        closeSidePanels("whiteboardPanel");
        panel.classList.toggle("open", open);
        if (open) initWhiteboard();
    });
    document.getElementById("closeWhiteboardBtn").addEventListener("click", () => {
        document.getElementById("whiteboardPanel").classList.remove("open");
    });

    // Polls
    document.getElementById("pollsBtn").addEventListener("click", () => {
        const panel = document.getElementById("pollsPanel");
        const open = !panel.classList.contains("open");
        closeSidePanels("pollsPanel");
        panel.classList.toggle("open", open);
        if (open && myRole === "host") {
            document.getElementById("createPollSection").style.display = "block";
        }
    });
    document.getElementById("closePollsBtn").addEventListener("click", () => {
        document.getElementById("pollsPanel").classList.remove("open");
    });
    document.getElementById("addPollOption").addEventListener("click", () => {
        const container = document.getElementById("pollOptionsContainer");
        const count = container.children.length + 1;
        const input = document.createElement("input");
        input.type = "text";
        input.className = "poll-option-input";
        input.placeholder = `Option ${count}`;
        input.maxLength = 100;
        container.appendChild(input);
    });
    document.getElementById("launchPollBtn").addEventListener("click", () => {
        const question = document.getElementById("pollQuestion").value.trim();
        const options = [...document.querySelectorAll(".poll-option-input")]
            .map(i => i.value.trim()).filter(Boolean);
        if (!question || options.length < 2) {
            showToast("Need a question and at least 2 options");
            return;
        }
        if (ws) ws.send(JSON.stringify({ action: "create-poll", question, options }));
        document.getElementById("pollQuestion").value = "";
        document.querySelectorAll(".poll-option-input").forEach((i, idx) => {
            i.value = "";
            if (idx >= 2) i.remove();
        });
    });

    // Breakout rooms
    document.getElementById("breakoutBtn").addEventListener("click", () => {
        const panel = document.getElementById("breakoutPanel");
        const open = !panel.classList.contains("open");
        closeSidePanels("breakoutPanel");
        panel.classList.toggle("open", open);
        if (open && myRole === "host") {
            document.getElementById("breakoutSetup").style.display = "block";
            initBreakoutSetup();
        }
    });
    document.getElementById("closeBreakoutBtn").addEventListener("click", () => {
        document.getElementById("breakoutPanel").classList.remove("open");
    });
    document.getElementById("addBreakoutRoom").addEventListener("click", addBreakoutRoomRow);
    document.getElementById("startBreakoutBtn").addEventListener("click", startBreakout);
    document.getElementById("endBreakoutBtn").addEventListener("click", () => {
        if (ws) ws.send(JSON.stringify({ action: "end-breakout" }));
    });

    // Background blur
    document.getElementById("bgBlurBtn").addEventListener("click", toggleBgBlur);

    // Meeting Notes
    document.getElementById("notesBtn").addEventListener("click", () => {
        const panel = document.getElementById("notesPanel");
        const open = !panel.classList.contains("open");
        closeSidePanels("notesPanel");
        panel.classList.toggle("open", open);
        if (open) refreshNotesSummaries();
    });
    document.getElementById("closeNotesBtn").addEventListener("click", () => {
        document.getElementById("notesPanel").classList.remove("open");
    });
    document.getElementById("saveNotesBtn").addEventListener("click", saveNotes);
    document.getElementById("generateSummaryBtn").addEventListener("click", generateAndInsertSummary);

    // Files panel
    document.getElementById("filesBtn").addEventListener("click", () => {
        const panel = document.getElementById("filesPanel");
        const open = !panel.classList.contains("open");
        closeSidePanels("filesPanel");
        panel.classList.toggle("open", open);
        if (open) loadRoomFiles();
    });
    document.getElementById("closeFilesBtn").addEventListener("click", () => {
        document.getElementById("filesPanel").classList.remove("open");
    });
    document.getElementById("fileInput").addEventListener("change", (e) => {
        for (const file of e.target.files) uploadFile(file);
        e.target.value = "";
    });
    // Drag & drop
    const dropZone = document.getElementById("filesDropZone");
    dropZone.addEventListener("dragover", (e) => { e.preventDefault(); dropZone.classList.add("dragover"); });
    dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
    dropZone.addEventListener("drop", (e) => {
        e.preventDefault();
        dropZone.classList.remove("dragover");
        for (const file of e.dataTransfer.files) uploadFile(file);
    });

    // View toggle
    document.getElementById("viewToggleBtn").addEventListener("click", toggleViewMode);

    // Captions toggle
    document.getElementById("captionBtn").addEventListener("click", toggleCaptions);

    // More menu click toggle (for mobile/touch)
    document.getElementById("moreBtn").addEventListener("click", (e) => {
        e.stopPropagation();
        const menu = document.getElementById("moreMenu");
        menu.classList.toggle("open");
    });
    document.addEventListener("click", () => {
        document.getElementById("moreMenu").classList.remove("open");
    });

    // Device selector
    document.getElementById("deviceSelectBtn").addEventListener("click", openDeviceSelector);
    document.getElementById("closeDeviceModal").addEventListener("click", () => {
        document.getElementById("deviceModal").style.display = "none";
    });
    document.getElementById("camSelect").addEventListener("change", (e) => switchCamera(e.target.value));
    document.getElementById("micSelect").addEventListener("change", (e) => switchMicrophone(e.target.value));
    document.getElementById("speakerSelect").addEventListener("change", (e) => switchSpeaker(e.target.value));

    // Virtual background
    document.getElementById("virtualBgBtn").addEventListener("click", openVirtualBgModal);
    document.getElementById("closeVbgModal").addEventListener("click", () => {
        document.getElementById("vbgModal").style.display = "none";
    });
    document.querySelectorAll(".vbg-option").forEach(opt => {
        opt.addEventListener("click", () => {
            document.querySelectorAll(".vbg-option").forEach(o => o.classList.remove("active"));
            opt.classList.add("active");
            applyVirtualBg(opt.dataset.bg);
            document.getElementById("vbgModal").style.display = "none";
        });
    });

    // Keyboard shortcuts modal
    document.getElementById("shortcutsBtn").addEventListener("click", () => {
        document.getElementById("shortcutsModal").style.display = "flex";
    });
    document.getElementById("closeShortcutsModal").addEventListener("click", () => {
        document.getElementById("shortcutsModal").style.display = "none";
    });

    // Close modals on overlay click
    document.querySelectorAll(".modal-overlay").forEach(overlay => {
        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) overlay.style.display = "none";
        });
    });

    // Pin local video
    document.getElementById("localTile")?.addEventListener("dblclick", () => togglePin("local"));

    // Keyboard shortcuts
    setupKeyboardShortcuts();
}

function toggleMic() {
    micEnabled = !micEnabled;
    micBtn.classList.toggle("active", micEnabled);
    if (localStream) {
        localStream.getAudioTracks().forEach(t => t.enabled = micEnabled);
    }
    // Pause/resume mediasoup audio producer
    if (audioProducer) {
        if (micEnabled) audioProducer.resume();
        else audioProducer.pause();
        ws.send(JSON.stringify({
            action: "pause-producer",
            producerId: audioProducer.id,
            kind: "audio",
            paused: !micEnabled,
        }));
    }
    localMicIndicator.textContent = micEnabled ? "🎤" : "🔇";
    localMicIndicator.classList.toggle("muted", !micEnabled);
    updateParticipantList();
}

async function toggleCam() {
    camEnabled = !camEnabled;
    camBtn.classList.toggle("active", camEnabled);

    if (camEnabled) {
        // If localStream has no video track, acquire one
        const existingVideo = localStream ? localStream.getVideoTracks() : [];
        if (existingVideo.length === 0) {
            try {
                const camStream = await navigator.mediaDevices.getUserMedia({ video: true });
                const newTrack = camStream.getVideoTracks()[0];
                if (localStream) {
                    localStream.addTrack(newTrack);
                } else {
                    localStream = camStream;
                }
                localVideo.srcObject = localStream;
                // Create mediasoup video producer if in a call
                if (sendTransport && !videoProducer) {
                    try {
                        videoProducer = await sendTransport.produce({
                            track: newTrack,
                            encodings: [
                                { maxBitrate: 100000 },
                                { maxBitrate: 300000 },
                                { maxBitrate: 900000 },
                            ],
                            codecOptions: { videoGoogleStartBitrate: 1000 },
                        });
                        console.log("[ms] Video producer created on toggle:", videoProducer.id);
                    } catch (e) {
                        console.error("[ms] Video produce on toggle failed:", e);
                    }
                }
            } catch (e) {
                console.warn("Could not access camera:", e);
                camEnabled = false;
                camBtn.classList.toggle("active", false);
                showToast("Camera not available");
            }
        } else {
            existingVideo.forEach(t => t.enabled = true);
        }
        // Resume existing producer
        if (videoProducer && videoProducer.paused) {
            videoProducer.resume();
            ws.send(JSON.stringify({
                action: "pause-producer",
                producerId: videoProducer.id,
                kind: "video",
                paused: false,
            }));
        }
    } else {
        // Disable video tracks
        if (localStream) {
            localStream.getVideoTracks().forEach(t => t.enabled = false);
        }
        // Pause mediasoup video producer
        if (videoProducer) {
            videoProducer.pause();
            ws.send(JSON.stringify({
                action: "pause-producer",
                producerId: videoProducer.id,
                kind: "video",
                paused: true,
            }));
        }
    }
    localVideoOff.style.display = camEnabled ? "none" : "";
}

async function toggleScreenShare() {
    if (screenSharing) {
        stopScreenShare();
        return;
    }
    try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({
            video: { cursor: "always" },
            audio: false,
        });
        screenSharing = true;
        screenBtn.classList.add("active");

        const screenTrack = screenStream.getVideoTracks()[0];
        screenTrack.onended = () => stopScreenShare();

        // Produce screen as a SEPARATE producer via mediasoup
        if (sendTransport) {
            try {
                screenProducer = await sendTransport.produce({
                    track: screenTrack,
                    appData: { source: "screen" },
                });
                console.log("[ms] Screen producer created:", screenProducer.id);
            } catch (e) {
                console.error("[ms] Screen produce failed:", e);
            }
        }

        // Show screen share in own local tile
        localVideo.srcObject = screenStream;
        localVideoOff.style.display = "none";

        // Broadcast to peers via WS for UI update
        if (ws && ws.readyState === 1) {
            ws.send(JSON.stringify({ action: "screen-share-started" }));
        }

        showToast("Screen sharing started");
    } catch (e) {
        console.warn("Screen share cancelled:", e);
    }
}

function stopScreenShare() {
    if (screenStream) {
        screenStream.getTracks().forEach(t => t.stop());
        screenStream = null;
    }
    screenSharing = false;
    screenBtn.classList.remove("active");

    // Close the separate screen producer
    if (screenProducer) {
        // Notify server to close and broadcast to peers
        if (ws && ws.readyState === 1) {
            ws.send(JSON.stringify({
                action: "close-producer",
                producerId: screenProducer.id,
            }));
        }
        screenProducer.close();
        screenProducer = null;
    }

    // Restore local video to camera
    localVideo.srcObject = localStream;
    localVideoOff.style.display = camEnabled ? "none" : "";

    // Broadcast to peers via WS
    if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ action: "screen-share-stopped" }));
    }

    showToast("Screen sharing stopped");
}

function leaveCall() {
    if (recording) stopRecording();

    // Close mediasoup producers
    if (audioProducer) { audioProducer.close(); audioProducer = null; }
    if (videoProducer) { videoProducer.close(); videoProducer = null; }
    if (screenProducer) { screenProducer.close(); screenProducer = null; }
    // Close all consumers
    for (const cid in consumers) {
        consumers[cid].consumer.close();
    }
    consumers = {};
    // Close transports
    if (sendTransport) { sendTransport.close(); sendTransport = null; }
    if (recvTransport) { recvTransport.close(); recvTransport = null; }
    msDevice = null;
    myRtpCapabilities = null;

    for (const pid in peerConnections) {
        peerConnections[pid].tile.remove();
        delete peerConnections[pid];
    }

    if (ws) { ws.close(); ws = null; }

    if (screenStream) {
        screenStream.getTracks().forEach(t => t.stop());
        screenStream = null;
    }

    if (bgBlurStream) {
        bgBlurStream.getTracks().forEach(t => t.stop());
        bgBlurStream = null;
    }
    bgBlurEnabled = false;

    screenSharing = false;
    chatOpen = false;
    handRaised = false;
    myRole = "participant";
    pinnedPeerId = null;
    viewMode = "gallery";
    currentVbg = "none";
    chatPanel.classList.remove("open");
    document.querySelectorAll(".side-panel").forEach(p => p.classList.remove("open"));
    document.querySelectorAll(".modal-overlay").forEach(m => m.style.display = "none");

    clearInterval(meetingTimerInterval);
    meetingTimerInterval = null;

    stopSpeakerDetectionLoop();
    for (const pid in audioAnalysers) cleanupSpeakerDetection(pid);

    // Hide waiting room overlay
    document.getElementById("waitingRoomOverlay").style.display = "none";

    callScreen.classList.remove("active");
    joinScreen.classList.add("active");
    history.replaceState(null, "", "/");
    document.title = "Huddle - Video Calls";

    if (localStream) {
        previewVideo.srcObject = localStream;
    }
}

// ── Recording ───────────────────────────────────────────────────────────
function toggleRecording() {
    if (recording) {
        stopRecording();
    } else {
        startRecording();
    }
}

function startRecording() {
    const audioCtx = new AudioContext();
    const dest = audioCtx.createMediaStreamDestination();

    // Mix local audio
    if (localStream) {
        const localAudioTracks = localStream.getAudioTracks();
        if (localAudioTracks.length > 0) {
            const localSource = audioCtx.createMediaStreamSource(
                new MediaStream(localAudioTracks)
            );
            localSource.connect(dest);
        }
    }

    // Mix remote audio from all peers
    for (const pid in peerConnections) {
        const remoteStream = peerConnections[pid].videoEl.srcObject;
        if (remoteStream) {
            const remoteTracks = remoteStream.getAudioTracks();
            if (remoteTracks.length > 0) {
                const remoteSource = audioCtx.createMediaStreamSource(
                    new MediaStream(remoteTracks)
                );
                remoteSource.connect(dest);
            }
        }
    }

    // Capture the video grid as a canvas stream
    const gridEl = document.getElementById("videoGrid");
    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext("2d");

    // Draw all video elements onto canvas at 30fps
    const drawInterval = setInterval(() => {
        ctx.fillStyle = "#f5f7fb";
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const videos = gridEl.querySelectorAll("video");
        const count = videos.length;
        if (count === 0) return;

        const cols = count <= 1 ? 1 : count <= 4 ? 2 : 3;
        const rows = Math.ceil(count / cols);
        const tileW = canvas.width / cols;
        const tileH = canvas.height / rows;

        videos.forEach((video, i) => {
            if (!video.srcObject || video.videoWidth === 0) return;
            const col = i % cols;
            const row = Math.floor(i / cols);
            const x = col * tileW;
            const y = row * tileH;

            const vw = video.videoWidth;
            const vh = video.videoHeight;
            const vAspect = vw / vh;
            const tAspect = tileW / tileH;
            let sx, sy, sw, sh;
            if (vAspect > tAspect) {
                sh = vh; sw = vh * tAspect;
                sx = (vw - sw) / 2; sy = 0;
            } else {
                sw = vw; sh = vw / tAspect;
                sx = 0; sy = (vh - sh) / 2;
            }

            ctx.drawImage(video, sx, sy, sw, sh, x + 2, y + 2, tileW - 4, tileH - 4);
        });
    }, 1000 / 30);

    const canvasStream = canvas.captureStream(30);

    // Combine canvas video + mixed audio
    const combined = new MediaStream([
        ...canvasStream.getVideoTracks(),
        ...dest.stream.getAudioTracks(),
    ]);

    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
        ? "video/webm;codecs=vp9,opus"
        : "video/webm";

    recordedChunks = [];
    mediaRecorder = new MediaRecorder(combined, { mimeType });

    mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordedChunks.push(e.data);
    };

    mediaRecorder.onstop = () => {
        clearInterval(drawInterval);
        audioCtx.close();

        const blob = new Blob(recordedChunks, { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        a.href = url;
        a.download = `Huddle-${roomId}-${timestamp}.webm`;
        a.click();
        URL.revokeObjectURL(url);
        showToast("Recording saved!");
    };

    mediaRecorder._drawInterval = drawInterval;
    mediaRecorder._audioCtx = audioCtx;
    mediaRecorder.start(1000);

    recording = true;
    recordBtn.classList.add("active");
    recordBtn.classList.add("recording");
    recordingStartTime = Date.now();
    updateRecordingTimer();
    recordingTimerInterval = setInterval(updateRecordingTimer, 1000);
    showToast("Recording started");
}

function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
        mediaRecorder.stop();
    }
    recording = false;
    recordBtn.classList.remove("active");
    recordBtn.classList.remove("recording");
    clearInterval(recordingTimerInterval);
    const timerEl = document.getElementById("recordTimer");
    if (timerEl) timerEl.remove();
    showToast("Recording stopped — downloading...");
}

function updateRecordingTimer() {
    const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
    const mins = String(Math.floor(elapsed / 60)).padStart(2, "0");
    const secs = String(elapsed % 60).padStart(2, "0");
    let timerEl = document.getElementById("recordTimer");
    if (!timerEl) {
        timerEl = document.createElement("span");
        timerEl.id = "recordTimer";
        timerEl.className = "record-timer";
        recordBtn.parentElement.insertBefore(timerEl, recordBtn.nextSibling);
    }
    timerEl.textContent = `${mins}:${secs}`;
}

function sendChat() {
    const text = chatInput.value.trim();
    if (!text || !ws) return;
    ws.send(JSON.stringify({ action: "chat", text }));
    chatInput.value = "";
}

// ── WebRTC via mediasoup SFU ─────────────────────────────────────────────

function getOrCreatePeerTile(peerId, peerName) {
    if (peerConnections[peerId]) {
        if (peerName && peerName !== "Peer") {
            peerConnections[peerId].name = peerName;
            const nameEl = peerConnections[peerId].tile.querySelector(".tile-name");
            if (nameEl) nameEl.textContent = peerName;
        }
        return peerConnections[peerId];
    }

    const tile = document.createElement("div");
    tile.className = "video-tile";
    tile.dataset.peer = peerId;
    tile.innerHTML = `
        <video autoplay playsinline></video>
        <div class="video-off-overlay" style="display:flex"><div class="avatar">👤</div></div>
        <button class="pin-btn" title="Pin video"><span class="material-icons-round">push_pin</span></button>
        <div class="tile-label">
            <span class="tile-name">${escapeHtml(peerName || "Peer")}</span>
            <span class="mic-indicator">🎤</span>
        </div>
    `;
    videoGrid.appendChild(tile);

    const videoEl = tile.querySelector("video");
    videoEl.muted = false;
    videoEl.volume = 1.0;
    const offOverlay = tile.querySelector(".video-off-overlay");

    tile.querySelector(".pin-btn").addEventListener("click", () => togglePin(peerId));

    const conn = { videoEl, tile, name: peerName, offOverlay, stream: new MediaStream(), muted: false };
    videoEl.srcObject = conn.stream;
    peerConnections[peerId] = conn;

    updateGridLayout();
    updatePeerCount();
    return conn;
}

// Alias for code that still calls getOrCreatePeer
function getOrCreatePeer(peerId, peerName) {
    return getOrCreatePeerTile(peerId, peerName);
}

// ── mediasoup: Load device ───────────────────────────────────────────────
async function loadDevice() {
    if (msDevice) return;
    ws.send(JSON.stringify({ action: "get-router-rtp-capabilities" }));
}

async function onRouterRtpCapabilities(rtpCapabilities) {
    try {
        const mediasoupClient = window.mediasoupClient;
        msDevice = new mediasoupClient.Device();
        await msDevice.load({ routerRtpCapabilities: rtpCapabilities });
        myRtpCapabilities = msDevice.rtpCapabilities;
        console.log("[ms] Device loaded");
        // Create transports
        await createSendTransport();
        await createRecvTransport();
    } catch (e) {
        console.error("[ms] Failed to load device:", e);
    }
}

// ── mediasoup: Create Send Transport ─────────────────────────────────────
async function createSendTransport() {
    ws.send(JSON.stringify({ action: "create-transport", direction: "send" }));
}

function onSendTransportCreated(data) {
    sendTransport = msDevice.createSendTransport({
        id: data.id,
        iceParameters: data.iceParameters,
        iceCandidates: data.iceCandidates,
        dtlsParameters: data.dtlsParameters,
    });

    sendTransport.on("connect", ({ dtlsParameters }, callback, errback) => {
        ws.send(JSON.stringify({
            action: "connect-transport",
            transportId: sendTransport.id,
            dtlsParameters,
        }));
        // Server will respond with transport-connected; for simplicity, resolve now
        callback();
    });

    sendTransport.on("produce", ({ kind, rtpParameters, appData }, callback, errback) => {
        // Use source-aware key so camera and screen don't collide
        if (!sendTransport._produceCallbacks) sendTransport._produceCallbacks = {};
        const source = (appData && appData.source) || kind;
        sendTransport._produceCallbacks[source] = callback;
        ws.send(JSON.stringify({
            action: "produce",
            transportId: sendTransport.id,
            kind,
            rtpParameters,
            appData: appData || {},
        }));
    });

    console.log("[ms] Send transport created:", sendTransport.id);
    // Now produce local tracks
    produceLocalTracks();
}

// ── mediasoup: Create Recv Transport ─────────────────────────────────────
async function createRecvTransport() {
    ws.send(JSON.stringify({ action: "create-transport", direction: "recv" }));
}

function onRecvTransportCreated(data) {
    recvTransport = msDevice.createRecvTransport({
        id: data.id,
        iceParameters: data.iceParameters,
        iceCandidates: data.iceCandidates,
        dtlsParameters: data.dtlsParameters,
    });

    recvTransport.on("connect", ({ dtlsParameters }, callback, errback) => {
        ws.send(JSON.stringify({
            action: "connect-transport",
            transportId: recvTransport.id,
            dtlsParameters,
        }));
        callback();
    });

    console.log("[ms] Recv transport created:", recvTransport.id);
    // Ask for existing producers in room
    ws.send(JSON.stringify({ action: "get-room-producers" }));
}

// ── mediasoup: Produce local tracks ──────────────────────────────────────
async function produceLocalTracks() {
    if (!sendTransport || !localStream) return;

    // Produce audio
    const audioTrack = localStream.getAudioTracks()[0];
    if (audioTrack) {
        try {
            audioProducer = await sendTransport.produce({ track: audioTrack });
            console.log("[ms] Audio producer created:", audioProducer.id);
            if (!micEnabled) audioProducer.pause();
        } catch (e) {
            console.error("[ms] Audio produce failed:", e);
        }
    }

    // Produce video
    const videoTrack = localStream.getVideoTracks()[0];
    if (videoTrack) {
        try {
            videoProducer = await sendTransport.produce({
                track: videoTrack,
                encodings: [
                    { maxBitrate: 100000 },
                    { maxBitrate: 300000 },
                    { maxBitrate: 900000 },
                ],
                codecOptions: { videoGoogleStartBitrate: 1000 },
            });
            console.log("[ms] Video producer created:", videoProducer.id);
            if (!camEnabled) videoProducer.pause();
        } catch (e) {
            console.error("[ms] Video produce failed:", e);
        }
    }
}

// ── mediasoup: Consume a remote producer ─────────────────────────────────
async function consumeProducer(producerId, producerPeerId) {
    if (!myRtpCapabilities || !recvTransport) return;

    ws.send(JSON.stringify({
        action: "consume",
        producerId,
        producerPeerId,
        rtpCapabilities: myRtpCapabilities,
    }));
}

function onConsumed(data) {
    const { consumerId, producerId, kind, rtpParameters, producerPeerId } = data;
    const source = (data.appData && data.appData.source) || kind;
    const isScreen = source === "screen";
    if (!recvTransport) return;

    recvTransport.consume({
        id: consumerId,
        producerId,
        kind,
        rtpParameters,
    }).then(consumer => {
        consumers[consumerId] = { consumer, peerId: producerPeerId, kind, source };

        if (isScreen) {
            // Screen share gets its own tile
            const screenPeerId = producerPeerId + "_screen";
            const conn = getOrCreatePeerTile(screenPeerId, null);
            // Label it as screen share
            const nameEl = conn.tile.querySelector(".tile-name");
            const peerName = (peerConnections[producerPeerId] && peerConnections[producerPeerId].name) || "Peer";
            if (nameEl) nameEl.textContent = peerName + " (Screen)";
            conn.tile.classList.add("screen-share-tile");
            conn.stream.getVideoTracks().forEach(t => conn.stream.removeTrack(t));
            conn.stream.addTrack(consumer.track);
            conn.videoEl.srcObject = conn.stream;
            conn.offOverlay.style.display = "none";
            conn.videoEl.play().catch(() => {});
        } else {
            // Camera/audio — add to peer's regular tile
            const conn = getOrCreatePeerTile(producerPeerId, null);
            if (kind === "video") {
                conn.stream.getVideoTracks().forEach(t => conn.stream.removeTrack(t));
            } else if (kind === "audio") {
                conn.stream.getAudioTracks().forEach(t => conn.stream.removeTrack(t));
            }
            conn.stream.addTrack(consumer.track);
            conn.videoEl.srcObject = conn.stream;
            if (kind === "video") {
                conn.offOverlay.style.display = "none";
            }
            if (kind === "audio") {
                setupSpeakerDetection(producerPeerId, conn.stream);
            }
            conn.videoEl.play().catch(() => {});
        }

        // Resume the consumer on the server
        ws.send(JSON.stringify({ action: "resume-consumer", consumerId }));
        console.log("[ms] Consuming", kind, "from", producerPeerId, isScreen ? "(screen)" : "");
    }).catch(e => {
        console.error("[ms] Consume failed:", e);
    });
}

// ── mediasoup: Handle new producer notification ──────────────────────────
function onNewProducer(producerId, producerPeerId, kind, appData) {
    const source = (appData && appData.source) || kind;
    console.log("[ms] New producer:", kind, "from", producerPeerId, "source:", source);
    consumeProducer(producerId, producerPeerId);
}

// ── mediasoup: Handle remote producer closed ─────────────────────────────
function onProducerClosed(producerId, peerId) {
    // Find and close any consumer for this producer
    for (const [cid, cinfo] of Object.entries(consumers)) {
        if (cinfo.consumer.producerId === producerId || cid === producerId) {
            // If it was a screen share, remove the screen tile
            if (cinfo.source === "screen") {
                const screenPeerId = cinfo.peerId + "_screen";
                const conn = peerConnections[screenPeerId];
                if (conn) {
                    conn.tile.remove();
                    delete peerConnections[screenPeerId];
                }
            }
            cinfo.consumer.close();
            delete consumers[cid];
        }
    }
    updateLayout();
}

// ── mediasoup: Handle producer paused/resumed (mic/cam indicator) ────────
function onProducerPaused(peerId, producerId, kind, paused) {
    // Determine kind from consumers if not provided
    if (!kind) {
        for (const [cid, cinfo] of Object.entries(consumers)) {
            if (cinfo.consumer.producerId === producerId || cid === producerId) {
                kind = cinfo.kind;
                break;
            }
        }
    }
    if (kind === "audio") {
        const conn = peerConnections[peerId];
        if (conn) {
            conn.muted = !!paused;
            // Update mic indicator on the peer's video tile
            const micInd = conn.tile ? conn.tile.querySelector(".mic-indicator") : null;
            if (micInd) {
                micInd.textContent = paused ? "\uD83D\uDD07" : "\uD83C\uDFA4";
                micInd.classList.toggle("muted", !!paused);
            }
            updateParticipantList();
        }
    }
}

function removePeer(peerId) {
    const conn = peerConnections[peerId];
    if (!conn) return;

    // Close consumers for this peer (including screen share)
    for (const [cid, cinfo] of Object.entries(consumers)) {
        if (cinfo.peerId === peerId) {
            cinfo.consumer.close();
            delete consumers[cid];
        }
    }

    // Also remove screen share tile if it exists
    const screenPeerId = peerId + "_screen";
    const screenConn = peerConnections[screenPeerId];
    if (screenConn) {
        screenConn.tile.remove();
        delete peerConnections[screenPeerId];
    }

    conn.tile.remove();
    delete peerConnections[peerId];
    cleanupSpeakerDetection(peerId);
    if (pinnedPeerId === peerId) pinnedPeerId = null;

    const name = conn.name || "Someone";
    showToast(`${name} left`);
    updateGridLayout();
    updatePeerCount();
}

// ── Grid Layout ──────────────────────────────────────────────────────────
function updateGridLayout() {
    const count = videoGrid.children.length;
    videoGrid.dataset.count = Math.min(count, 9);
}

function updatePeerCount() {
    const count = Object.keys(peerConnections).length + 1; // +1 for self
    peerCount.textContent = `${count} participant${count !== 1 ? "s" : ""}`;
}

// ── Chat ─────────────────────────────────────────────────────────────────
function addChatMessage(name, text, time) {
    const div = document.createElement("div");
    div.className = "chat-msg";
    div.innerHTML = `<span class="chat-name">${escapeHtml(name)}</span><span class="chat-time">${time || ""}</span><br><span class="chat-text">${escapeHtml(text)}</span>`;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ── Helpers ──────────────────────────────────────────────────────────────
function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str || "";
    return div.innerHTML;
}

function showToast(message) {
    toast.textContent = message;
    toast.classList.add("visible");
    setTimeout(() => toast.classList.remove("visible"), 3000);
}

// ═══════════════════════════════════════════════════════════════════════════
// NEW ZOOM-LIKE FEATURES
// ═══════════════════════════════════════════════════════════════════════════

// ── Side Panel Helper ───────────────────────────────────────────────────
function closeSidePanels(except) {
    const panels = ["chatPanel", "participantsPanel", "whiteboardPanel", "pollsPanel", "breakoutPanel", "notesPanel", "filesPanel"];
    panels.forEach(id => {
        if (id !== except) document.getElementById(id).classList.remove("open");
    });
    if (except !== "chatPanel") { chatOpen = false; chatBtn.classList.remove("active"); }
}

// ── Meeting Timer ───────────────────────────────────────────────────────
function updateMeetingTimer() {
    if (!meetingStartTime) return;
    const elapsed = Math.floor((Date.now() - meetingStartTime) / 1000);
    const h = Math.floor(elapsed / 3600);
    const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, "0");
    const s = String(elapsed % 60).padStart(2, "0");
    const el = document.getElementById("meetingTimer");
    if (el) el.textContent = h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
}

// ── Host Controls ───────────────────────────────────────────────────────
function showHostControls() {
    const el = document.getElementById("hostControls");
    if (el) el.style.display = "flex";
    const createPoll = document.getElementById("createPollSection");
    if (createPoll) createPoll.style.display = "block";
    const breakout = document.getElementById("breakoutSetup");
    if (breakout) breakout.style.display = "block";
}

// ── Hand Raise ──────────────────────────────────────────────────────────
function toggleHandRaise() {
    handRaised = !handRaised;
    const btn = document.getElementById("handBtn");
    btn.classList.toggle("raised", handRaised);
    document.getElementById("localHand").style.display = handRaised ? "" : "none";
    if (ws) ws.send(JSON.stringify({ action: "hand-raise", raised: handRaised }));
    showToast(handRaised ? "Hand raised" : "Hand lowered");
}

function handleHandRaise(peerId, name, raised) {
    const conn = peerConnections[peerId];
    if (conn) {
        let indicator = conn.tile.querySelector(".hand-indicator");
        if (!indicator) {
            indicator = document.createElement("div");
            indicator.className = "hand-indicator";
            indicator.textContent = "✋";
            conn.tile.appendChild(indicator);
        }
        indicator.style.display = raised ? "" : "none";
        conn.hand = raised;
    }
    if (raised) showToast(`${name} raised hand ✋`);
    updateParticipantList();
}

function handleAllHandsLowered() {
    handRaised = false;
    document.getElementById("handBtn").classList.remove("raised");
    document.getElementById("localHand").style.display = "none";
    for (const pid in peerConnections) {
        peerConnections[pid].hand = false;
        const indicator = peerConnections[pid].tile.querySelector(".hand-indicator");
        if (indicator) indicator.style.display = "none";
    }
    showToast("All hands lowered");
    updateParticipantList();
}

// ── Reactions ───────────────────────────────────────────────────────────
function showReaction(emoji, name) {
    const overlay = document.getElementById("reactionsOverlay");
    const el = document.createElement("div");
    el.className = "reaction-float";
    el.textContent = emoji;
    el.style.left = Math.random() * 250 + "px";
    overlay.appendChild(el);
    setTimeout(() => el.remove(), 2600);
}

// ── Waiting Room ────────────────────────────────────────────────────────
function showWaitingRoom(message) {
    joinScreen.classList.remove("active");
    callScreen.classList.add("active");
    document.getElementById("waitingRoomOverlay").style.display = "flex";
    document.getElementById("waitingRoomMsg").textContent = message;
}

function updateWaitingList(waiting) {
    const container = document.getElementById("waitingListContent");
    const wrapper = document.getElementById("waitingList");
    if (!waiting || !waiting.length) {
        wrapper.style.display = "none";
        return;
    }
    wrapper.style.display = "block";
    container.innerHTML = waiting.map(w => `
        <div class="waiting-item">
            <span class="w-name">${escapeHtml(w.name)}</span>
            <button class="btn-admit" onclick="admitPeer('${w.id}')">Admit</button>
            <button class="btn-deny" onclick="denyPeer('${w.id}')">Deny</button>
        </div>
    `).join("");
}

function admitPeer(targetId) {
    if (ws) ws.send(JSON.stringify({ action: "admit-peer", target: targetId }));
}

function denyPeer(targetId) {
    if (ws) ws.send(JSON.stringify({ action: "deny-peer", target: targetId }));
}

// ── Participant List ────────────────────────────────────────────────────
function updateParticipantList() {
    const list = document.getElementById("participantList");
    if (!list) return;

    // Count only real peers (exclude _screen tiles)
    let realPeerCount = 0;
    for (const pid in peerConnections) {
        if (!pid.endsWith("_screen")) realPeerCount++;
    }
    const count = realPeerCount + 1;
    document.getElementById("participantCountTitle").textContent = `In Meeting (${count})`;

    const myMicIcon = micEnabled ? "mic" : "mic_off";
    const myMicClass = micEnabled ? "" : " muted";
    let html = `
        <div class="participant-item">
            <span class="p-mic${myMicClass}"><span class="material-icons-round" style="font-size:16px">${myMicIcon}</span></span>
            <span class="p-name">${escapeHtml(myName)} (You)</span>
            ${myRole === "host" ? '<span class="p-role">Host</span>' : ""}
            ${handRaised ? '<span class="p-hand">\u270B</span>' : ""}
        </div>
    `;

    for (const pid in peerConnections) {
        if (pid.endsWith("_screen")) continue;
        const c = peerConnections[pid];
        const isMuted = c.muted === true;
        const micIcon = isMuted ? "mic_off" : "mic";
        const micClass = isMuted ? " muted" : "";
        html += `
            <div class="participant-item">
                <span class="p-mic${micClass}"><span class="material-icons-round" style="font-size:16px">${micIcon}</span></span>
                <span class="p-name">${escapeHtml(c.name || "Peer")}</span>
                ${c.hand ? '<span class="p-hand">\u270B</span>' : ""}
                ${myRole === "host" ? `
                    <span class="p-actions">
                        <button onclick="kickPeer('${pid}')" title="Remove"><span class="material-icons-round" style="font-size:16px">person_remove</span></button>
                    </span>
                ` : ""}
            </div>
        `;
    }
    list.innerHTML = html;
}

function mutePeer(targetId) {
    if (ws) ws.send(JSON.stringify({ action: "mute-peer", target: targetId }));
}

function kickPeer(targetId) {
    if (ws) ws.send(JSON.stringify({ action: "kick-peer", target: targetId }));
}

// ── Polls ───────────────────────────────────────────────────────────────
const activePolls = {};

function renderPoll(poll) {
    activePolls[poll.id] = poll;
    const container = document.getElementById("activePollsList");
    let card = document.getElementById(`poll-${poll.id}`);
    if (!card) {
        card = document.createElement("div");
        card.id = `poll-${poll.id}`;
        card.className = "poll-card";
        container.prepend(card);
    }

    const total = poll.total_votes || 0;
    const results = poll.results || poll.options.map(() => 0);

    card.innerHTML = `
        <h4>${escapeHtml(poll.question)}</h4>
        ${poll.options.map((opt, i) => {
            const count = results[i] || 0;
            const pct = total > 0 ? Math.round(count / total * 100) : 0;
            const voted = poll.my_vote === i;
            return `
                <div class="poll-option-row ${voted ? 'voted' : ''}" onclick="votePoll('${poll.id}', ${i})">
                    <span class="poll-option-text">${escapeHtml(opt)}</span>
                    <div class="poll-bar"><div class="poll-bar-fill" style="width:${pct}%"></div></div>
                    <span class="poll-option-pct">${pct}%</span>
                </div>
            `;
        }).join("")}
        <div class="poll-total">${total} vote${total !== 1 ? 's' : ''}</div>
        ${myRole === "host" && poll.active ? `<button class="btn btn-small btn-outline" style="margin-top:8px;width:100%" onclick="endPoll('${poll.id}')">End Poll</button>` : ""}
        ${!poll.active ? '<div style="color:var(--text-hint);font-size:12px;margin-top:4px">Poll ended</div>' : ""}
    `;
}

function votePoll(pollId, choice) {
    if (ws) ws.send(JSON.stringify({ action: "vote-poll", poll_id: pollId, choice }));
    if (activePolls[pollId]) activePolls[pollId].my_vote = choice;
}

function endPoll(pollId) {
    if (ws) ws.send(JSON.stringify({ action: "end-poll", poll_id: pollId }));
}

function updatePollResults(pollId, results, totalVotes) {
    if (activePolls[pollId]) {
        activePolls[pollId].results = results;
        activePolls[pollId].total_votes = totalVotes;
        renderPoll(activePolls[pollId]);
    }
}

function endPollDisplay(pollId, results, totalVotes) {
    if (activePolls[pollId]) {
        activePolls[pollId].active = false;
        activePolls[pollId].results = results;
        activePolls[pollId].total_votes = totalVotes;
        renderPoll(activePolls[pollId]);
    }
}

// ── Whiteboard ──────────────────────────────────────────────────────────
let wbDrawing = false;
let wbCurrentStroke = null;
let wbEraser = false;

function initWhiteboard() {
    const canvas = document.getElementById("whiteboardCanvas");
    if (canvas._initialized) return;
    canvas._initialized = true;

    const ctx = canvas.getContext("2d");
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    canvas.addEventListener("pointerdown", (e) => {
        wbDrawing = true;
        const rect = canvas.getBoundingClientRect();
        const x = (e.clientX - rect.left) / rect.width * canvas.width;
        const y = (e.clientY - rect.top) / rect.height * canvas.height;
        const color = wbEraser ? "#ffffff" : document.getElementById("wbColor").value;
        const width = wbEraser ? 20 : parseInt(document.getElementById("wbSize").value);
        wbCurrentStroke = { points: [[x, y]], color, width };
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.moveTo(x, y);
    });

    canvas.addEventListener("pointermove", (e) => {
        if (!wbDrawing || !wbCurrentStroke) return;
        const rect = canvas.getBoundingClientRect();
        const x = (e.clientX - rect.left) / rect.width * canvas.width;
        const y = (e.clientY - rect.top) / rect.height * canvas.height;
        wbCurrentStroke.points.push([x, y]);
        const ctx2 = canvas.getContext("2d");
        ctx2.strokeStyle = wbCurrentStroke.color;
        ctx2.lineWidth = wbCurrentStroke.width;
        ctx2.lineTo(x, y);
        ctx2.stroke();
    });

    const endDraw = () => {
        if (wbDrawing && wbCurrentStroke && wbCurrentStroke.points.length > 1) {
            if (ws) ws.send(JSON.stringify({ action: "whiteboard-stroke", stroke: wbCurrentStroke }));
        }
        wbDrawing = false;
        wbCurrentStroke = null;
    };
    canvas.addEventListener("pointerup", endDraw);
    canvas.addEventListener("pointerleave", endDraw);

    document.getElementById("wbEraser").addEventListener("click", () => {
        wbEraser = !wbEraser;
        document.getElementById("wbEraser").classList.toggle("active", wbEraser);
        canvas.style.cursor = wbEraser ? "cell" : "crosshair";
    });

    document.getElementById("wbClear").addEventListener("click", () => {
        if (ws) ws.send(JSON.stringify({ action: "whiteboard-clear" }));
        clearWhiteboardLocal();
    });
}

function drawRemoteStroke(stroke) {
    const canvas = document.getElementById("whiteboardCanvas");
    const ctx = canvas.getContext("2d");
    if (!stroke.points || stroke.points.length < 2) return;
    ctx.strokeStyle = stroke.color || "#000";
    ctx.lineWidth = stroke.width || 3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(stroke.points[0][0], stroke.points[0][1]);
    for (let i = 1; i < stroke.points.length; i++) {
        ctx.lineTo(stroke.points[i][0], stroke.points[i][1]);
    }
    ctx.stroke();
}

function replayWhiteboardStrokes(strokes) {
    const canvas = document.getElementById("whiteboardCanvas");
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const stroke of strokes) drawRemoteStroke(stroke);
}

function clearWhiteboardLocal() {
    const canvas = document.getElementById("whiteboardCanvas");
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
}

// ── Breakout Rooms ──────────────────────────────────────────────────────
function initBreakoutSetup() {
    const container = document.getElementById("breakoutRoomsList");
    if (container.children.length === 0) {
        addBreakoutRoomRow();
        addBreakoutRoomRow();
    }
}

function addBreakoutRoomRow() {
    const container = document.getElementById("breakoutRoomsList");
    const idx = container.children.length + 1;
    const row = document.createElement("div");
    row.className = "breakout-room-row";
    row.innerHTML = `
        <input type="text" value="Room ${idx}" placeholder="Room name" maxlength="30">
        <div class="br-peers"></div>
    `;
    container.appendChild(row);
    updateBreakoutAssignments();
}

function updateBreakoutAssignments() {
    const peersInCall = Object.entries(peerConnections).map(([id, c]) => ({ id, name: c.name || "Peer" }));
    const rows = document.querySelectorAll("#breakoutRoomsList .breakout-room-row");
    rows.forEach(row => {
        const peersDiv = row.querySelector(".br-peers");
        peersDiv.innerHTML = peersInCall.map(p =>
            `<span class="br-peer-chip" data-pid="${p.id}" onclick="this.classList.toggle('assigned')">${escapeHtml(p.name)}</span>`
        ).join("");
    });
}

function startBreakout() {
    const rows = document.querySelectorAll("#breakoutRoomsList .breakout-room-row");
    const breakoutRooms = [];
    rows.forEach(row => {
        const name = row.querySelector("input").value.trim() || "Room";
        const assignedPeers = [...row.querySelectorAll(".br-peer-chip.assigned")].map(el => el.dataset.pid);
        breakoutRooms.push({ name, peers: assignedPeers });
    });
    if (ws) ws.send(JSON.stringify({ action: "create-breakout", rooms: breakoutRooms }));
}

function renderBreakoutActive(rooms) {
    const setup = document.getElementById("breakoutSetup");
    const active = document.getElementById("breakoutActive");
    const list = document.getElementById("breakoutActiveList");
    setup.style.display = "none";
    active.style.display = "block";

    list.innerHTML = Object.entries(rooms).map(([rid, r]) => `
        <div class="breakout-room-row">
            <strong>${escapeHtml(r.name)}</strong>
            <div class="br-peers">${r.peers.map(pid => {
                const name = peerConnections[pid]?.name || (pid === myPeerId ? myName : "Peer");
                return `<span class="br-peer-chip assigned">${escapeHtml(name)}</span>`;
            }).join("")}</div>
        </div>
    `).join("");
}

function hideBreakoutActive() {
    document.getElementById("breakoutSetup").style.display = myRole === "host" ? "block" : "none";
    document.getElementById("breakoutActive").style.display = "none";
}

// ── Background Blur ─────────────────────────────────────────────────────
async function toggleBgBlur() {
    if (bgBlurEnabled && vbgMode === 'blur') {
        // Turn off blur
        applyVirtualBg('none');
    } else {
        // Turn on blur
        await applyVirtualBg('blur');
    }
}

// ── Meeting Notes ───────────────────────────────────────────────────────
function refreshNotesSummaries() {
    // Polls summary
    const pollsContent = document.getElementById("notesPollsContent");
    const pollKeys = Object.keys(activePolls);
    if (pollKeys.length) {
        pollsContent.innerHTML = pollKeys.map(pid => {
            const p = activePolls[pid];
            const total = p.total_votes || 0;
            const results = p.results || p.options.map(() => 0);
            let html = `<div class="notes-poll"><strong>${escapeHtml(p.question)}</strong>${p.active ? '' : ' <em>(ended)</em>'}`;
            html += '<ul>' + p.options.map((opt, i) => {
                const count = results[i] || 0;
                const pct = total > 0 ? Math.round(count / total * 100) : 0;
                return `<li>${escapeHtml(opt)}: ${count} vote${count !== 1 ? 's' : ''} (${pct}%)</li>`;
            }).join('') + '</ul></div>';
            return html;
        }).join('');
    } else {
        pollsContent.textContent = 'No polls yet.';
    }

    // Whiteboard snapshot
    const wbContent = document.getElementById("notesWhiteboardContent");
    const canvas = document.getElementById("whiteboardCanvas");
    if (canvas && canvas._initialized) {
        const ctx = canvas.getContext("2d");
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const hasContent = imageData.data.some((v, i) => i % 4 !== 3 && v !== 0);
        if (hasContent) {
            const dataUrl = canvas.toDataURL("image/png");
            wbContent.innerHTML = `<img src="${dataUrl}" class="notes-wb-img" alt="Whiteboard snapshot">`;
        } else {
            wbContent.innerHTML = '<em>Whiteboard is empty.</em>';
        }
    } else {
        wbContent.innerHTML = '<em>Open whiteboard to capture.</em>';
    }

    // Breakout rooms summary
    const brContent = document.getElementById("notesBreakoutContent");
    const brList = document.getElementById("breakoutActiveList");
    if (brList && brList.children.length > 0) {
        brContent.innerHTML = brList.innerHTML;
    } else {
        brContent.textContent = 'No breakout rooms yet.';
    }

    // Transcript summary
    const txContent = document.getElementById("notesTranscriptContent");
    if (txContent) {
        if (meetingTranscript.length > 0) {
            txContent.innerHTML = formatTranscriptSummary();
        } else {
            txContent.innerHTML = '<em>Enable captions (CC) to auto-capture discussion.</em>';
        }
    }
}

function formatTranscriptSummary() {
    const speechEntries = meetingTranscript.filter(e => e.type === 'speech');
    const chatEntries = meetingTranscript.filter(e => e.type === 'chat');
    let html = '';

    // Key discussion points grouped by speaker
    if (speechEntries.length > 0) {
        html += '<div class="transcript-section"><strong>Discussion Transcript</strong>';
        // Group consecutive entries by same speaker
        const grouped = [];
        let current = null;
        for (const entry of speechEntries) {
            if (current && current.name === entry.name) {
                current.texts.push(entry.text);
                current.endTime = entry.time;
            } else {
                current = { name: entry.name, texts: [entry.text], startTime: entry.time, endTime: entry.time };
                grouped.push(current);
            }
        }
        for (const g of grouped) {
            html += `<div class="transcript-entry">`;
            html += `<span class="transcript-speaker">${escapeHtml(g.name)}</span>`;
            html += `<span class="transcript-time">${g.startTime}</span>`;
            html += `<p>${escapeHtml(g.texts.join(' '))}</p></div>`;
        }
        html += '</div>';

        // Speaker summary
        const speakers = {};
        for (const e of speechEntries) {
            if (!speakers[e.name]) speakers[e.name] = { count: 0, words: 0 };
            speakers[e.name].count++;
            speakers[e.name].words += e.text.split(/\s+/).length;
        }
        html += '<div class="transcript-section"><strong>Speaker Summary</strong><ul>';
        for (const [name, stats] of Object.entries(speakers)) {
            html += `<li>${escapeHtml(name)}: ${stats.count} contribution${stats.count !== 1 ? 's' : ''}, ~${stats.words} words</li>`;
        }
        html += '</ul></div>';
    }

    // Chat messages
    if (chatEntries.length > 0) {
        html += '<div class="transcript-section"><strong>Chat Messages</strong>';
        for (const e of chatEntries) {
            html += `<div class="transcript-entry"><span class="transcript-speaker">${escapeHtml(e.name)}</span>`;
            html += `<span class="transcript-time">${e.time}</span>`;
            html += `<p>${escapeHtml(e.text)}</p></div>`;
        }
        html += '</div>';
    }

    if (!html) html = '<em>No discussion captured yet.</em>';
    return html;
}

function generateAndInsertSummary() {
    const textarea = document.getElementById('notesTextarea');
    const speechEntries = meetingTranscript.filter(e => e.type === 'speech');
    const chatEntries = meetingTranscript.filter(e => e.type === 'chat');
    let summary = '';

    if (speechEntries.length === 0 && chatEntries.length === 0) {
        showToast('No discussion to summarize. Enable captions first.');
        return;
    }

    summary += '=== MEETING SUMMARY ===\n';
    summary += `Generated: ${new Date().toLocaleString()}\n`;
    summary += `Total contributions: ${meetingTranscript.length}\n\n`;

    if (speechEntries.length > 0) {
        summary += '--- Discussion ---\n';
        const grouped = [];
        let current = null;
        for (const entry of speechEntries) {
            if (current && current.name === entry.name) {
                current.texts.push(entry.text);
            } else {
                current = { name: entry.name, texts: [entry.text], time: entry.time };
                grouped.push(current);
            }
        }
        for (const g of grouped) {
            summary += `[${g.time}] ${g.name}: ${g.texts.join(' ')}\n`;
        }
        summary += '\n';

        // Speaker stats
        const speakers = {};
        for (const e of speechEntries) {
            if (!speakers[e.name]) speakers[e.name] = { count: 0, words: 0 };
            speakers[e.name].count++;
            speakers[e.name].words += e.text.split(/\s+/).length;
        }
        summary += '--- Speakers ---\n';
        for (const [name, stats] of Object.entries(speakers)) {
            summary += `${name}: ${stats.count} contributions, ~${stats.words} words\n`;
        }
        summary += '\n';
    }

    if (chatEntries.length > 0) {
        summary += '--- Chat ---\n';
        for (const e of chatEntries) {
            summary += `[${e.time}] ${e.name}: ${e.text}\n`;
        }
    }

    // Append to existing notes
    if (textarea.value.trim()) {
        textarea.value += '\n\n' + summary;
    } else {
        textarea.value = summary;
    }
    showToast('Summary added to notes');
}

function saveNotes() {
    refreshNotesSummaries();

    const userNotes = document.getElementById("notesTextarea").value;
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const meetingDuration = document.getElementById("meetingTimer").textContent;
    const participantCount = Object.keys(peerConnections).length + 1;

    // Build participants list
    const participants = [myName + " (You)"];
    for (const pid in peerConnections) {
        participants.push(peerConnections[pid].name || "Peer");
    }

    // Build polls text
    let pollsText = "";
    const pollKeys = Object.keys(activePolls);
    if (pollKeys.length) {
        pollsText = pollKeys.map(pid => {
            const p = activePolls[pid];
            const total = p.total_votes || 0;
            const results = p.results || p.options.map(() => 0);
            let t = `  Q: ${p.question}${p.active ? '' : ' (ended)'}`;
            p.options.forEach((opt, i) => {
                const count = results[i] || 0;
                const pct = total > 0 ? Math.round(count / total * 100) : 0;
                t += `\n    - ${opt}: ${count} vote${count !== 1 ? 's' : ''} (${pct}%)`;
            });
            t += `\n    Total votes: ${total}`;
            return t;
        }).join("\n\n");
    }

    // Build text content
    let content = `Huddle - Meeting Notes\n`;
    content += `========================\n\n`;
    content += `Room: ${roomId}\n`;
    content += `Date: ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()}\n`;
    content += `Duration: ${meetingDuration}\n`;
    content += `Participants (${participantCount}): ${participants.join(", ")}\n\n`;

    if (userNotes.trim()) {
        content += `--- Notes ---\n${userNotes}\n\n`;
    }

    if (pollsText) {
        content += `--- Polls ---\n${pollsText}\n\n`;
    }

    // Breakout rooms text
    const brList = document.getElementById("breakoutActiveList");
    if (brList && brList.children.length > 0) {
        content += `--- Breakout Rooms ---\n`;
        brList.querySelectorAll(".breakout-room-row").forEach(row => {
            const name = row.querySelector("strong")?.textContent || "Room";
            const peers = [...row.querySelectorAll(".br-peer-chip")].map(el => el.textContent).join(", ");
            content += `  ${name}: ${peers || "empty"}\n`;
        });
        content += "\n";
    }

    // Chat log
    const chatMsgs = document.querySelectorAll("#chatMessages .chat-msg");
    if (chatMsgs.length) {
        content += `--- Chat Log ---\n`;
        chatMsgs.forEach(msg => {
            const nameEl = msg.querySelector(".chat-name");
            const timeEl = msg.querySelector(".chat-time");
            const textEl = msg.querySelector(".chat-text");
            content += `  [${timeEl?.textContent || ''}] ${nameEl?.textContent || ''}: ${textEl?.textContent || ''}\n`;
        });
        content += "\n";
    }

    // Save as text file
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `Huddle-Notes-${roomId}-${timestamp}.txt`;
    a.click();
    URL.revokeObjectURL(url);

    // Also save whiteboard image separately if it has content
    const canvas = document.getElementById("whiteboardCanvas");
    if (canvas && canvas._initialized) {
        const ctx = canvas.getContext("2d");
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const hasContent = imageData.data.some((v, i) => i % 4 !== 3 && v !== 0);
        if (hasContent) {
            canvas.toBlob(function(imgBlob) {
                const imgUrl = URL.createObjectURL(imgBlob);
                const imgA = document.createElement("a");
                imgA.href = imgUrl;
                imgA.download = `Huddle-Whiteboard-${roomId}-${timestamp}.png`;
                imgA.click();
                URL.revokeObjectURL(imgUrl);
            }, "image/png");
        }
    }

    showToast("Meeting notes saved!");
}

// ── View Toggle (Gallery / Speaker) ─────────────────────────────────────
function toggleViewMode() {
    viewMode = viewMode === "gallery" ? "speaker" : "gallery";
    const label = document.getElementById("viewToggleLabel");
    const icon = document.getElementById("viewToggleBtn").querySelector(".material-icons-round");
    if (viewMode === "speaker") {
        label.textContent = "Speaker";
        icon.textContent = "view_sidebar";
    } else {
        label.textContent = "Gallery";
        icon.textContent = "grid_view";
    }
    applyViewMode();
}

function applyViewMode() {
    const grid = document.getElementById("videoGrid");
    grid.classList.remove("view-gallery", "view-speaker");
    grid.classList.add(viewMode === "speaker" ? "view-speaker" : "view-gallery");

    // In speaker mode, spotlight the pinned peer or the active speaker
    if (viewMode === "speaker") {
        const spotlightId = pinnedPeerId || findActiveSpeaker() || "local";
        grid.querySelectorAll(".video-tile").forEach(tile => {
            tile.classList.toggle("spotlight", tile.dataset.peer === spotlightId);
        });
    } else {
        grid.querySelectorAll(".video-tile").forEach(tile => {
            tile.classList.remove("spotlight");
        });
    }
}

function findActiveSpeaker() {
    let loudest = null;
    let loudestLevel = 0;
    for (const pid in audioAnalysers) {
        const { analyser, dataArray } = audioAnalysers[pid];
        analyser.getByteFrequencyData(dataArray);
        const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
        if (avg > loudestLevel && avg > 15) {
            loudestLevel = avg;
            loudest = pid;
        }
    }
    return loudest;
}

// ── Pin / Spotlight Video ───────────────────────────────────────────────
function togglePin(peerId) {
    if (pinnedPeerId === peerId) {
        pinnedPeerId = null;
        showToast("Unpinned video");
    } else {
        pinnedPeerId = peerId;
        const name = peerConnections[peerId]?.name || "Peer";
        showToast(`Pinned ${name}`);
    }
    // Update pin button styling
    videoGrid.querySelectorAll(".pin-btn").forEach(btn => {
        const tile = btn.closest(".video-tile");
        btn.classList.toggle("active", tile.dataset.peer === pinnedPeerId);
    });
    applyViewMode();
}

// ── Speaker Active Indicator ────────────────────────────────────────────
function setupSpeakerDetection(peerId, stream) {
    try {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const source = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.5;
        source.connect(analyser);
        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        audioAnalysers[peerId] = { analyser, dataArray, audioCtx };
    } catch (e) {
        console.warn("[speaker] Failed to setup detection for", peerId, e);
    }
}

function cleanupSpeakerDetection(peerId) {
    if (audioAnalysers[peerId]) {
        audioAnalysers[peerId].audioCtx.close().catch(() => {});
        delete audioAnalysers[peerId];
    }
}

let speakerDetectionInterval = null;
function startSpeakerDetectionLoop() {
    if (speakerDetectionInterval) return;
    speakerDetectionInterval = setInterval(() => {
        for (const pid in audioAnalysers) {
            const { analyser, dataArray } = audioAnalysers[pid];
            analyser.getByteFrequencyData(dataArray);
            const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
            const tile = peerConnections[pid]?.tile;
            if (tile) {
                tile.classList.toggle("speaking", avg > 15);
            }
        }
        // Auto-switch speaker view spotlight
        if (viewMode === "speaker" && !pinnedPeerId) {
            applyViewMode();
        }
    }, 300);
}

function stopSpeakerDetectionLoop() {
    clearInterval(speakerDetectionInterval);
    speakerDetectionInterval = null;
}

// ── Device Selector ─────────────────────────────────────────────────────
async function openDeviceSelector() {
    const modal = document.getElementById("deviceModal");
    modal.style.display = "flex";

    const devices = await navigator.mediaDevices.enumerateDevices();
    const camSelect = document.getElementById("camSelect");
    const micSelect = document.getElementById("micSelect");
    const speakerSelect = document.getElementById("speakerSelect");

    const currentVideoId = localStream?.getVideoTracks()[0]?.getSettings()?.deviceId;
    const currentAudioId = localStream?.getAudioTracks()[0]?.getSettings()?.deviceId;

    camSelect.innerHTML = devices.filter(d => d.kind === "videoinput").map(d =>
        `<option value="${d.deviceId}" ${d.deviceId === currentVideoId ? 'selected' : ''}>${d.label || 'Camera ' + d.deviceId.slice(0,4)}</option>`
    ).join('');

    micSelect.innerHTML = devices.filter(d => d.kind === "audioinput").map(d =>
        `<option value="${d.deviceId}" ${d.deviceId === currentAudioId ? 'selected' : ''}>${d.label || 'Mic ' + d.deviceId.slice(0,4)}</option>`
    ).join('');

    speakerSelect.innerHTML = devices.filter(d => d.kind === "audiooutput").map(d =>
        `<option value="${d.deviceId}">${d.label || 'Speaker ' + d.deviceId.slice(0,4)}</option>`
    ).join('');
}

async function switchCamera(deviceId) {
    try {
        const newStream = await navigator.mediaDevices.getUserMedia({
            video: { deviceId: { exact: deviceId } },
            audio: false,
        });
        const newTrack = newStream.getVideoTracks()[0];
        const oldTrack = localStream.getVideoTracks()[0];
        if (oldTrack) {
            localStream.removeTrack(oldTrack);
            oldTrack.stop();
        }
        localStream.addTrack(newTrack);
        if (videoProducer) {
            await videoProducer.replaceTrack({ track: newTrack });
        }
        localVideo.srcObject = localStream;
        showToast("Camera switched");
    } catch (e) {
        showToast("Failed to switch camera");
    }
}

async function switchMicrophone(deviceId) {
    try {
        const newStream = await navigator.mediaDevices.getUserMedia({
            audio: { deviceId: { exact: deviceId }, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            video: false,
        });
        const newTrack = newStream.getAudioTracks()[0];
        const oldTrack = localStream.getAudioTracks()[0];
        if (oldTrack) {
            localStream.removeTrack(oldTrack);
            oldTrack.stop();
        }
        localStream.addTrack(newTrack);
        newTrack.enabled = micEnabled;
        if (audioProducer) {
            await audioProducer.replaceTrack({ track: newTrack });
        }
        showToast("Microphone switched");
    } catch (e) {
        showToast("Failed to switch microphone");
    }
}

async function switchSpeaker(deviceId) {
    try {
        for (const pid in peerConnections) {
            const el = peerConnections[pid].videoEl;
            if (el.setSinkId) await el.setSinkId(deviceId);
        }
        showToast("Speaker switched");
    } catch (e) {
        showToast("Failed to switch speaker");
    }
}

// ── Virtual Background ──────────────────────────────────────────────────
// Helper: soft radial light bloom
function _vbgGlow(ctx, cx, cy, r, color, alpha) {
    ctx.save(); ctx.globalAlpha = alpha;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, color); g.addColorStop(1, 'transparent');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI*2); ctx.fill();
    ctx.restore();
}
// Helper: noise grain overlay for photo-realism
function _vbgGrain(ctx, w, h, intensity) {
    ctx.save(); ctx.globalAlpha = intensity;
    for (let i = 0; i < w * h * 0.012; i++) {
        const x = Math.random() * w, y = Math.random() * h;
        const v = Math.floor(Math.random() * 60 + 100);
        ctx.fillStyle = `rgb(${v},${v},${v})`;
        ctx.fillRect(x, y, 1.5, 1.5);
    }
    ctx.restore();
}
const VBG_SCENES = {
    office: (ctx, w, h) => {
        // Modern office — soft daylight, clean desk, large window
        const wall = ctx.createLinearGradient(0, 0, 0, h);
        wall.addColorStop(0, '#eae4db'); wall.addColorStop(0.6, '#e0d8ce'); wall.addColorStop(1, '#d5cbc0');
        ctx.fillStyle = wall; ctx.fillRect(0, 0, w, h);
        // Warm wood floor with subtle grain
        const floor = ctx.createLinearGradient(0, h*0.62, 0, h);
        floor.addColorStop(0, '#b89878'); floor.addColorStop(0.3, '#a88a6e'); floor.addColorStop(1, '#9a7c60');
        ctx.fillStyle = floor; ctx.fillRect(0, h*0.62, w, h*0.38);
        // Floor line
        ctx.fillStyle = '#c8a882'; ctx.fillRect(0, h*0.62, w, h*0.004);
        // Baseboard
        ctx.fillStyle = '#d8cfc4'; ctx.fillRect(0, h*0.6, w, h*0.025);
        // Large window — frosted daylight
        const winGrad = ctx.createLinearGradient(w*0.5, 0, w*0.5, h*0.58);
        winGrad.addColorStop(0, '#d4e8f4'); winGrad.addColorStop(0.3, '#e0eff8'); winGrad.addColorStop(1, '#edf5fa');
        ctx.fillStyle = '#7a6b58'; ctx.fillRect(w*0.48, h*0.03, w*0.34, h*0.55);
        ctx.fillStyle = winGrad; ctx.fillRect(w*0.495, h*0.045, w*0.31, h*0.52);
        // Window mullions
        ctx.fillStyle = '#7a6b58';
        ctx.fillRect(w*0.645, h*0.03, w*0.012, h*0.55);
        ctx.fillRect(w*0.48, h*0.28, w*0.34, h*0.01);
        // Daylight glow spill
        _vbgGlow(ctx, w*0.65, h*0.25, w*0.35, '#fff8e8', 0.08);
        // Wooden console/shelf on left
        ctx.fillStyle = '#8a7560'; ctx.fillRect(w*0.04, h*0.42, w*0.2, h*0.04);
        ctx.fillStyle = '#7a6550'; ctx.fillRect(w*0.06, h*0.46, w*0.015, h*0.16);
        ctx.fillRect(w*0.215, h*0.46, w*0.015, h*0.16);
        // Books on shelf — muted tones
        const bookColors = ['#8c6e5d','#6b7f8a','#7a8b6a','#9a7e6a','#6d6a80','#8a7a6a','#7a8878'];
        for (let i = 0; i < 7; i++) {
            ctx.fillStyle = bookColors[i];
            ctx.fillRect(w*(0.05+i*0.025), h*0.34, w*0.02, h*0.08);
        }
        // Small plant
        ctx.fillStyle = '#6a5a4a';
        ctx.beginPath(); ctx.roundRect(w*0.87, h*0.48, w*0.05, h*0.06, 4); ctx.fill();
        ctx.fillStyle = '#5a7a52';
        ctx.beginPath(); ctx.arc(w*0.895, h*0.42, w*0.035, 0, Math.PI*2); ctx.fill();
        ctx.fillStyle = '#6a8a5e';
        ctx.beginPath(); ctx.arc(w*0.885, h*0.39, w*0.025, 0, Math.PI*2); ctx.fill();
        _vbgGrain(ctx, w, h, 0.03);
    },
    livingroom: (ctx, w, h) => {
        // Warm living room — soft lamp lighting, mid-century modern
        const wall = ctx.createRadialGradient(w*0.75, h*0.3, 0, w*0.5, h*0.4, w*0.8);
        wall.addColorStop(0, '#efe5d8'); wall.addColorStop(0.5, '#e4d8ca'); wall.addColorStop(1, '#d8ccbc');
        ctx.fillStyle = wall; ctx.fillRect(0, 0, w, h);
        // Floor
        const floor = ctx.createLinearGradient(0, h*0.68, 0, h);
        floor.addColorStop(0, '#b5a08a'); floor.addColorStop(1, '#a08a72');
        ctx.fillStyle = floor; ctx.fillRect(0, h*0.68, w, h*0.32);
        ctx.fillStyle = '#c4ae96'; ctx.fillRect(0, h*0.68, w, h*0.005);
        // Area rug — soft weave texture
        const rug = ctx.createLinearGradient(w*0.15, h*0.74, w*0.85, h*0.94);
        rug.addColorStop(0, '#8c6b4e'); rug.addColorStop(0.5, '#9a7860'); rug.addColorStop(1, '#8c6b4e');
        ctx.fillStyle = rug;
        ctx.beginPath(); ctx.roundRect(w*0.15, h*0.74, w*0.7, h*0.22, 4); ctx.fill();
        // Sofa — warm olive-grey, realistic cushion shape
        const sofaGrad = ctx.createLinearGradient(0, h*0.38, 0, h*0.62);
        sofaGrad.addColorStop(0, '#6a7462'); sofaGrad.addColorStop(1, '#5a6452');
        ctx.fillStyle = sofaGrad;
        ctx.beginPath(); ctx.roundRect(w*0.08, h*0.40, w*0.58, h*0.24, 10); ctx.fill();
        // Armrests
        ctx.fillStyle = '#5e6856';
        ctx.beginPath(); ctx.roundRect(w*0.06, h*0.36, w*0.06, h*0.28, 8); ctx.fill();
        ctx.beginPath(); ctx.roundRect(w*0.62, h*0.36, w*0.06, h*0.28, 8); ctx.fill();
        // Cushions
        ctx.fillStyle = '#747e6c';
        ctx.beginPath(); ctx.roundRect(w*0.12, h*0.42, w*0.22, h*0.14, 6); ctx.fill();
        ctx.beginPath(); ctx.roundRect(w*0.38, h*0.42, w*0.22, h*0.14, 6); ctx.fill();
        // Throw pillow
        ctx.fillStyle = '#b8926a';
        ctx.beginPath(); ctx.roundRect(w*0.14, h*0.38, w*0.08, h*0.10, 6); ctx.fill();
        // Floor lamp — warm glow
        ctx.fillStyle = '#4a4a4a'; ctx.fillRect(w*0.80, h*0.42, w*0.008, h*0.28);
        ctx.fillStyle = '#e8dcc0';
        ctx.beginPath(); ctx.ellipse(w*0.804, h*0.38, w*0.035, h*0.05, 0, 0, Math.PI*2); ctx.fill();
        _vbgGlow(ctx, w*0.804, h*0.38, w*0.15, '#fff5e0', 0.10);
        // Framed art on wall — abstract neutral
        ctx.fillStyle = '#7a6a5a'; ctx.fillRect(w*0.3, h*0.06, w*0.18, h*0.22);
        const artGrad = ctx.createLinearGradient(w*0.32, h*0.08, w*0.46, h*0.26);
        artGrad.addColorStop(0, '#c4b8a8'); artGrad.addColorStop(0.5, '#b0a494'); artGrad.addColorStop(1, '#c8bcac');
        ctx.fillStyle = artGrad; ctx.fillRect(w*0.315, h*0.075, w*0.15, h*0.19);
        // Small side table + vase
        ctx.fillStyle = '#6a5848'; ctx.fillRect(w*0.72, h*0.56, w*0.08, h*0.04);
        ctx.fillRect(w*0.74, h*0.60, w*0.015, h*0.08);
        ctx.fillRect(w*0.775, h*0.60, w*0.015, h*0.08);
        ctx.fillStyle = '#c4a880';
        ctx.beginPath(); ctx.roundRect(w*0.745, h*0.50, w*0.025, h*0.06, 3); ctx.fill();
        _vbgGrain(ctx, w, h, 0.025);
    },
    nature: (ctx, w, h) => {
        // Serene park — golden hour, soft-focus trees, gentle path
        const sky = ctx.createLinearGradient(0, 0, 0, h*0.5);
        sky.addColorStop(0, '#8eb8d4'); sky.addColorStop(0.5, '#b0d0e4'); sky.addColorStop(1, '#d4e4f0');
        ctx.fillStyle = sky; ctx.fillRect(0, 0, w, h*0.52);
        // Distant hills — hazy, atmospheric
        ctx.fillStyle = '#90ae98';
        ctx.beginPath(); ctx.moveTo(0, h*0.48);
        for (let x = 0; x <= w; x += w*0.02) {
            ctx.lineTo(x, h*(0.42 + Math.sin(x/w*4)*0.04 + Math.sin(x/w*7)*0.02));
        }
        ctx.lineTo(w, h*0.52); ctx.lineTo(0, h*0.52); ctx.closePath(); ctx.fill();
        // Meadow — rich gradient
        const grass = ctx.createLinearGradient(0, h*0.48, 0, h);
        grass.addColorStop(0, '#6a9a5e'); grass.addColorStop(0.3, '#5a8a4e'); grass.addColorStop(1, '#4a7a3e');
        ctx.fillStyle = grass; ctx.fillRect(0, h*0.48, w, h*0.52);
        // Winding path
        ctx.fillStyle = '#c4aa7a';
        ctx.beginPath(); ctx.moveTo(w*0.42, h);
        ctx.bezierCurveTo(w*0.44, h*0.8, w*0.48, h*0.65, w*0.50, h*0.52);
        ctx.lineTo(w*0.53, h*0.52);
        ctx.bezierCurveTo(w*0.54, h*0.65, w*0.56, h*0.8, w*0.58, h);
        ctx.closePath(); ctx.fill();
        // Trees — layered, soft canopy shapes
        const treePositions = [[0.08,0.30],[0.22,0.28],[0.78,0.26],[0.92,0.32],[0.52,0.22]];
        treePositions.forEach(([tx, ty]) => {
            // Trunk
            ctx.fillStyle = '#5a4030';
            ctx.fillRect(w*(tx-0.008), h*(ty+0.12), w*0.016, h*0.25);
            // Canopy layers
            ctx.fillStyle = '#3a6e3e';
            ctx.beginPath(); ctx.arc(w*tx, h*ty, w*0.06, 0, Math.PI*2); ctx.fill();
            ctx.fillStyle = '#4a8050';
            ctx.beginPath(); ctx.arc(w*(tx+0.02), h*(ty-0.03), w*0.045, 0, Math.PI*2); ctx.fill();
            ctx.fillStyle = '#5a9060';
            ctx.beginPath(); ctx.arc(w*(tx-0.015), h*(ty-0.02), w*0.04, 0, Math.PI*2); ctx.fill();
        });
        // Sunlight haze
        _vbgGlow(ctx, w*0.7, h*0.15, w*0.35, '#fff8e0', 0.06);
        _vbgGrain(ctx, w, h, 0.02);
    },
    beach: (ctx, w, h) => {
        // Calm tropical beach — warm light, soft surf
        const sky = ctx.createLinearGradient(0, 0, 0, h*0.42);
        sky.addColorStop(0, '#65b8d8'); sky.addColorStop(0.6, '#8ecce4'); sky.addColorStop(1, '#b0ddf0');
        ctx.fillStyle = sky; ctx.fillRect(0, 0, w, h*0.44);
        // Wispy clouds
        ctx.save(); ctx.globalAlpha = 0.4;
        [[0.15,0.08,0.08],[0.4,0.12,0.06],[0.7,0.06,0.07],[0.85,0.14,0.05]].forEach(([cx,cy,r]) => {
            ctx.fillStyle = '#fff';
            ctx.beginPath(); ctx.ellipse(w*cx, h*cy, w*r, h*0.018, 0, 0, Math.PI*2); ctx.fill();
            ctx.beginPath(); ctx.ellipse(w*(cx+0.04), h*(cy-0.01), w*(r*0.7), h*0.014, 0, 0, Math.PI*2); ctx.fill();
        });
        ctx.restore();
        // Ocean — layered depth
        const ocean = ctx.createLinearGradient(0, h*0.38, 0, h*0.56);
        ocean.addColorStop(0, '#2a8aa8'); ocean.addColorStop(0.4, '#3a9ab8'); ocean.addColorStop(1, '#5ab4cc');
        ctx.fillStyle = ocean; ctx.fillRect(0, h*0.38, w, h*0.2);
        // Horizon glow
        _vbgGlow(ctx, w*0.5, h*0.40, w*0.5, '#e0f0f8', 0.08);
        // Surf line
        ctx.fillStyle = 'rgba(255,255,255,0.25)';
        ctx.beginPath();
        for (let x = 0; x <= w; x += w*0.01) ctx.lineTo(x, h*(0.555 + Math.sin(x/w*12)*0.004));
        ctx.lineTo(w, h*0.565); ctx.lineTo(0, h*0.565); ctx.closePath(); ctx.fill();
        // Sand — warm gradient
        const sand = ctx.createLinearGradient(0, h*0.55, 0, h);
        sand.addColorStop(0, '#e8cc8a'); sand.addColorStop(0.3, '#dfc078'); sand.addColorStop(1, '#d4b468');
        ctx.fillStyle = sand; ctx.fillRect(0, h*0.555, w, h*0.445);
        // Wet sand reflection
        ctx.fillStyle = 'rgba(180,160,120,0.3)'; ctx.fillRect(0, h*0.555, w, h*0.04);
        // Palm tree — organic curved trunk
        ctx.save();
        ctx.strokeStyle = '#6a4828'; ctx.lineWidth = w*0.02; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(w*0.10, h*0.65);
        ctx.bezierCurveTo(w*0.11, h*0.45, w*0.12, h*0.30, w*0.14, h*0.18);
        ctx.stroke();
        // Palm fronds
        ctx.strokeStyle = '#3a7a3a'; ctx.lineWidth = w*0.005;
        [[-0.6,0.12],[-0.3,0.10],[0.2,0.11],[0.5,0.10],[0.8,0.12],[1.2,0.11]].forEach(([angle, len]) => {
            ctx.beginPath(); ctx.moveTo(w*0.14, h*0.18);
            const ex = w*0.14 + Math.cos(angle)*w*len, ey = h*0.18 + Math.sin(angle)*h*0.08 - h*0.04;
            ctx.quadraticCurveTo(w*0.14 + Math.cos(angle)*w*len*0.6, h*0.14, ex, ey + h*0.06);
            ctx.stroke();
            ctx.fillStyle = '#3a7a3a';
            ctx.beginPath(); ctx.ellipse(ex, ey+h*0.04, w*0.02, h*0.015, angle, 0, Math.PI*2); ctx.fill();
        });
        ctx.restore();
        _vbgGrain(ctx, w, h, 0.02);
    },
    mountain: (ctx, w, h) => {
        // Twilight mountains — alpine lake, cool tones
        const sky = ctx.createLinearGradient(0, 0, 0, h*0.5);
        sky.addColorStop(0, '#1e2040'); sky.addColorStop(0.3, '#2e2e5a'); sky.addColorStop(0.7, '#4a3e6e'); sky.addColorStop(1, '#6a5880');
        ctx.fillStyle = sky; ctx.fillRect(0, 0, w, h*0.55);
        // Stars
        ctx.save(); ctx.globalAlpha = 0.6; ctx.fillStyle = '#fff';
        for (let i = 0; i < 60; i++) {
            const r = Math.random() * 1.5 + 0.3;
            ctx.globalAlpha = Math.random() * 0.5 + 0.2;
            ctx.beginPath(); ctx.arc(Math.random()*w, Math.random()*h*0.35, r, 0, Math.PI*2); ctx.fill();
        }
        ctx.restore();
        // Far mountains — misty blue
        ctx.fillStyle = '#3a3860';
        ctx.beginPath(); ctx.moveTo(0, h*0.5);
        ctx.lineTo(w*0.12, h*0.28); ctx.lineTo(w*0.28, h*0.42);
        ctx.lineTo(w*0.45, h*0.18); ctx.lineTo(w*0.62, h*0.38);
        ctx.lineTo(w*0.78, h*0.22); ctx.lineTo(w*0.92, h*0.34); ctx.lineTo(w, h*0.30);
        ctx.lineTo(w, h*0.55); ctx.closePath(); ctx.fill();
        // Snow caps
        ctx.fillStyle = '#d4d0e0';
        [[0.45,0.18,0.04],[0.78,0.22,0.03],[0.12,0.28,0.025]].forEach(([px,py,sz]) => {
            ctx.beginPath();
            ctx.moveTo(w*(px-sz), h*(py+0.04)); ctx.lineTo(w*px, h*py); ctx.lineTo(w*(px+sz), h*(py+0.04));
            ctx.closePath(); ctx.fill();
        });
        // Near mountains — darker
        ctx.fillStyle = '#2a2848';
        ctx.beginPath(); ctx.moveTo(0, h*0.52);
        ctx.lineTo(w*0.18, h*0.38); ctx.lineTo(w*0.35, h*0.5);
        ctx.lineTo(w*0.55, h*0.35); ctx.lineTo(w*0.75, h*0.48);
        ctx.lineTo(w, h*0.42); ctx.lineTo(w, h*0.55); ctx.closePath(); ctx.fill();
        // Forest treeline
        ctx.fillStyle = '#1a2a22';
        for (let x = 0; x < w; x += w*0.015) {
            const th = h*(0.03 + Math.random()*0.04);
            ctx.fillRect(x, h*0.50-th, w*0.012, th + h*0.05);
        }
        // Lake — reflective gradient
        const lake = ctx.createLinearGradient(0, h*0.55, 0, h);
        lake.addColorStop(0, '#2a3050'); lake.addColorStop(0.3, '#222840'); lake.addColorStop(1, '#1a2035');
        ctx.fillStyle = lake; ctx.fillRect(0, h*0.55, w, h*0.45);
        // Water reflection shimmer
        ctx.save(); ctx.globalAlpha = 0.04;
        for (let i = 0; i < 30; i++) {
            ctx.fillStyle = '#8888cc';
            ctx.fillRect(Math.random()*w, h*(0.58+Math.random()*0.35), w*0.05, h*0.002);
        }
        ctx.restore();
        _vbgGrain(ctx, w, h, 0.03);
    },
    city: (ctx, w, h) => {
        // City night — deep blue-purple, warm window glow
        const sky = ctx.createLinearGradient(0, 0, 0, h*0.65);
        sky.addColorStop(0, '#0c0e1a'); sky.addColorStop(0.4, '#141830'); sky.addColorStop(1, '#1e1840');
        ctx.fillStyle = sky; ctx.fillRect(0, 0, w, h);
        // Ambient city glow on horizon
        _vbgGlow(ctx, w*0.5, h*0.65, w*0.6, '#2a1a40', 0.15);
        // Stars
        ctx.save(); ctx.fillStyle = '#fff';
        for (let i = 0; i < 40; i++) {
            ctx.globalAlpha = Math.random()*0.4 + 0.1;
            ctx.beginPath(); ctx.arc(Math.random()*w, Math.random()*h*0.3, Math.random()+0.5, 0, Math.PI*2); ctx.fill();
        }
        ctx.restore();
        // Buildings — varied heights, realistic proportions
        const bData = [
            [0, 0.09, 0.42], [0.09, 0.08, 0.58], [0.17, 0.10, 0.38],
            [0.27, 0.11, 0.68], [0.38, 0.09, 0.52], [0.47, 0.08, 0.72],
            [0.55, 0.12, 0.40], [0.67, 0.10, 0.62], [0.77, 0.09, 0.48],
            [0.86, 0.14, 0.55],
        ];
        bData.forEach(([bx, bw, bh2]) => {
            const baseCol = 15 + Math.floor(Math.random()*12);
            ctx.fillStyle = `rgb(${baseCol},${baseCol+4},${baseCol+10})`;
            const top = h*(1-bh2);
            ctx.fillRect(w*bx, top, w*bw, h*bh2);
            // Windows — warm yellowish
            for (let wy = top + h*0.02; wy < h - h*0.04; wy += h*0.035) {
                for (let wx = w*bx + w*0.012; wx < w*(bx+bw) - w*0.01; wx += w*0.018) {
                    if (Math.random() > 0.35) {
                        const brightness = Math.random() > 0.7 ? '#ffeaa0' : '#ffd870';
                        ctx.fillStyle = brightness;
                        ctx.globalAlpha = Math.random()*0.3 + 0.5;
                        ctx.fillRect(wx, wy, w*0.008, h*0.018);
                    }
                }
            }
            ctx.globalAlpha = 1;
        });
        // Road
        ctx.fillStyle = '#0e0e18'; ctx.fillRect(0, h*0.9, w, h*0.1);
        ctx.fillStyle = '#1a1a28'; ctx.fillRect(0, h*0.9, w, h*0.005);
        // Road lane markings
        ctx.strokeStyle = '#ffd860'; ctx.lineWidth = h*0.003; ctx.setLineDash([w*0.02, w*0.015]);
        ctx.beginPath(); ctx.moveTo(0, h*0.95); ctx.lineTo(w, h*0.95); ctx.stroke();
        ctx.setLineDash([]);
        _vbgGrain(ctx, w, h, 0.04);
    },
    abstract: (ctx, w, h) => {
        // Elegant deep gradient — Teams/Zoom-style, refined
        const bg = ctx.createLinearGradient(0, 0, w, h);
        bg.addColorStop(0, '#4a5a8a'); bg.addColorStop(0.35, '#5a4a7a'); bg.addColorStop(0.7, '#6a4a6a'); bg.addColorStop(1, '#7a5a6a');
        ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
        // Soft overlapping light shapes
        _vbgGlow(ctx, w*0.20, h*0.30, w*0.30, '#7a8ab0', 0.10);
        _vbgGlow(ctx, w*0.75, h*0.65, w*0.35, '#8a6a90', 0.08);
        _vbgGlow(ctx, w*0.50, h*0.15, w*0.25, '#6a7a9a', 0.06);
        _vbgGlow(ctx, w*0.35, h*0.75, w*0.28, '#6a5a7a', 0.07);
        // Subtle mesh/fabric texture
        ctx.save(); ctx.globalAlpha = 0.03;
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 0.5;
        for (let x = 0; x < w; x += w*0.04) {
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
        }
        for (let y = 0; y < h; y += h*0.04) {
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
        }
        ctx.restore();
        _vbgGrain(ctx, w, h, 0.025);
    },
    classroom: (ctx, w, h) => {
        // Modern classroom — clean whiteboard, warm wood
        const wall = ctx.createLinearGradient(0, 0, 0, h);
        wall.addColorStop(0, '#f0ebe2'); wall.addColorStop(1, '#e4ddd2');
        ctx.fillStyle = wall; ctx.fillRect(0, 0, w, h);
        // Floor — warm laminate
        const floor = ctx.createLinearGradient(0, h*0.66, 0, h);
        floor.addColorStop(0, '#b8a080'); floor.addColorStop(1, '#a89070');
        ctx.fillStyle = floor; ctx.fillRect(0, h*0.66, w, h*0.34);
        ctx.fillStyle = '#c8b090'; ctx.fillRect(0, h*0.66, w, h*0.004);
        // Whiteboard — clean
        ctx.fillStyle = '#8a7a68'; ctx.fillRect(w*0.1, h*0.06, w*0.8, h*0.42);
        const wbGrad = ctx.createLinearGradient(w*0.12, h*0.08, w*0.88, h*0.46);
        wbGrad.addColorStop(0, '#f8f8f4'); wbGrad.addColorStop(1, '#f0f0ec');
        ctx.fillStyle = wbGrad; ctx.fillRect(w*0.12, h*0.08, w*0.76, h*0.38);
        // Faint marker traces
        ctx.save(); ctx.globalAlpha = 0.12;
        ctx.strokeStyle = '#2a5a8a'; ctx.lineWidth = w*0.002;
        ctx.beginPath(); ctx.moveTo(w*0.16, h*0.16); ctx.lineTo(w*0.50, h*0.16); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(w*0.16, h*0.22); ctx.lineTo(w*0.42, h*0.22); ctx.stroke();
        ctx.strokeStyle = '#8a2a2a';
        ctx.beginPath(); ctx.moveTo(w*0.55, h*0.16); ctx.lineTo(w*0.75, h*0.16); ctx.stroke();
        ctx.restore();
        // Whiteboard tray
        ctx.fillStyle = '#8a7a68'; ctx.fillRect(w*0.12, h*0.465, w*0.76, h*0.02);
        // Marker on tray
        ctx.fillStyle = '#2a5a8a'; ctx.fillRect(w*0.40, h*0.458, w*0.04, h*0.008);
        ctx.fillStyle = '#c03030'; ctx.fillRect(w*0.46, h*0.458, w*0.04, h*0.008);
        // Desk — modern
        ctx.fillStyle = '#a08a6a'; ctx.fillRect(w*0.15, h*0.58, w*0.7, h*0.04);
        ctx.fillStyle = '#888'; ctx.fillRect(w*0.22, h*0.62, w*0.012, h*0.12);
        ctx.fillRect(w*0.77, h*0.62, w*0.012, h*0.12);
        // Clock
        ctx.fillStyle = '#f0ece4';
        ctx.beginPath(); ctx.arc(w*0.93, h*0.12, w*0.025, 0, Math.PI*2); ctx.fill();
        ctx.strokeStyle = '#555'; ctx.lineWidth = w*0.002;
        ctx.beginPath(); ctx.arc(w*0.93, h*0.12, w*0.025, 0, Math.PI*2); ctx.stroke();
        ctx.strokeStyle = '#333'; ctx.lineWidth = w*0.002;
        ctx.beginPath(); ctx.moveTo(w*0.93, h*0.12); ctx.lineTo(w*0.93, h*0.10); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(w*0.93, h*0.12); ctx.lineTo(w*0.945, h*0.12); ctx.stroke();
        _vbgGrain(ctx, w, h, 0.02);
    },
    // ── Professional backgrounds ────────────────────────────
    bookcase: (ctx, w, h) => {
        // Library bookcase with plants — warm, intellectual
        const wall = ctx.createLinearGradient(0, 0, 0, h);
        wall.addColorStop(0, '#ede5da'); wall.addColorStop(1, '#ddd4c8');
        ctx.fillStyle = wall; ctx.fillRect(0, 0, w, h);
        // Floor
        ctx.fillStyle = '#b0987c'; ctx.fillRect(0, h*0.70, w, h*0.30);
        ctx.fillStyle = '#c0a88a'; ctx.fillRect(0, h*0.70, w, h*0.004);
        // Full-height bookshelf — rich wood
        const shelfGrad = ctx.createLinearGradient(w*0.05, 0, w*0.42, 0);
        shelfGrad.addColorStop(0, '#5a4230'); shelfGrad.addColorStop(0.5, '#6a5240'); shelfGrad.addColorStop(1, '#5a4230');
        ctx.fillStyle = shelfGrad; ctx.fillRect(w*0.05, h*0.02, w*0.38, h*0.66);
        // Shelves + books — muted, natural tones
        const bookTones = ['#7a5e4e','#5a6e7a','#6a7e5a','#8a6e5a','#5a5a6e','#7a7060','#6a7a70','#8a7a60','#5e6e5a'];
        for (let r = 0; r < 5; r++) {
            // Shelf plank
            ctx.fillStyle = '#7a6248'; ctx.fillRect(w*0.05, h*(0.02+r*0.132), w*0.38, h*0.012);
            // Books
            const booksInRow = 7 + Math.floor(Math.random()*3);
            for (let b = 0; b < booksInRow; b++) {
                ctx.fillStyle = bookTones[(r*9+b) % bookTones.length];
                const bw = w*(0.020 + Math.random()*0.015);
                const bh2 = h*(0.08 + Math.random()*0.03);
                ctx.fillRect(w*(0.06+b*0.048), h*(0.032+r*0.132)+(h*0.11-bh2), bw, bh2);
            }
        }
        // Right side — plant on console
        ctx.fillStyle = '#7a6850';
        ctx.beginPath(); ctx.roundRect(w*0.78, h*0.52, w*0.10, h*0.04, 3); ctx.fill();
        // Ceramic pot
        ctx.fillStyle = '#c4a878';
        ctx.beginPath(); ctx.roundRect(w*0.81, h*0.42, w*0.055, h*0.10, 4); ctx.fill();
        // Lush plant
        ctx.fillStyle = '#3a7040';
        ctx.beginPath(); ctx.arc(w*0.838, h*0.34, w*0.050, 0, Math.PI*2); ctx.fill();
        ctx.fillStyle = '#4a8050';
        ctx.beginPath(); ctx.arc(w*0.82, h*0.30, w*0.038, 0, Math.PI*2); ctx.fill();
        ctx.fillStyle = '#5a9060';
        ctx.beginPath(); ctx.arc(w*0.85, h*0.28, w*0.030, 0, Math.PI*2); ctx.fill();
        // Small framed photo on wall
        ctx.fillStyle = '#6a5a48'; ctx.fillRect(w*0.58, h*0.10, w*0.14, h*0.16);
        const photoGrad = ctx.createLinearGradient(w*0.59, h*0.11, w*0.71, h*0.25);
        photoGrad.addColorStop(0, '#b0c4b8'); photoGrad.addColorStop(1, '#a0b4a8');
        ctx.fillStyle = photoGrad; ctx.fillRect(w*0.595, h*0.115, w*0.12, h*0.13);
        // Daylight from right
        _vbgGlow(ctx, w*0.92, h*0.25, w*0.30, '#fff8e4', 0.06);
        _vbgGrain(ctx, w, h, 0.025);
    },
    coworking: (ctx, w, h) => {
        // Bright coworking — floor-to-ceiling windows, clean design
        const wall = ctx.createLinearGradient(0, 0, 0, h);
        wall.addColorStop(0, '#f5f2ee'); wall.addColorStop(1, '#ece8e2');
        ctx.fillStyle = wall; ctx.fillRect(0, 0, w, h);
        // Polished concrete floor
        const floor = ctx.createLinearGradient(0, h*0.66, 0, h);
        floor.addColorStop(0, '#c8c0b8'); floor.addColorStop(1, '#b8b0a8');
        ctx.fillStyle = floor; ctx.fillRect(0, h*0.66, w, h*0.34);
        // Large windows with urban view
        for (let i = 0; i < 3; i++) {
            const wx = w*(0.04+i*0.32);
            ctx.fillStyle = '#48443e'; ctx.fillRect(wx, h*0.02, w*0.27, h*0.60);
            const winGrad = ctx.createLinearGradient(wx, h*0.04, wx+w*0.25, h*0.55);
            winGrad.addColorStop(0, '#c8d8e8'); winGrad.addColorStop(0.5, '#d8e4f0'); winGrad.addColorStop(1, '#e4eff6');
            ctx.fillStyle = winGrad; ctx.fillRect(wx+w*0.01, h*0.04, w*0.25, h*0.56);
            // Window divider
            ctx.fillStyle = '#48443e'; ctx.fillRect(wx+w*0.125, h*0.02, w*0.01, h*0.60);
        }
        // Daylight wash
        _vbgGlow(ctx, w*0.5, h*0.3, w*0.5, '#f0f4f8', 0.08);
        // Clean desk
        ctx.fillStyle = '#f0ece4';
        ctx.beginPath(); ctx.roundRect(w*0.06, h*0.60, w*0.88, h*0.04, 2); ctx.fill();
        ctx.fillStyle = '#888'; ctx.fillRect(w*0.15, h*0.64, w*0.01, h*0.12);
        ctx.fillRect(w*0.85, h*0.64, w*0.01, h*0.12);
        // Modern pendant lights
        ctx.strokeStyle = '#aaa'; ctx.lineWidth = w*0.002;
        for (let i = 0; i < 3; i++) {
            const lx = w*(0.17+i*0.32);
            ctx.beginPath(); ctx.moveTo(lx, 0); ctx.lineTo(lx, h*0.06); ctx.stroke();
            ctx.fillStyle = '#2a2a2a';
            ctx.beginPath(); ctx.roundRect(lx-w*0.02, h*0.06, w*0.04, h*0.025, 3); ctx.fill();
            _vbgGlow(ctx, lx, h*0.09, w*0.06, '#fff8e8', 0.06);
        }
        _vbgGrain(ctx, w, h, 0.02);
    },
    executive: (ctx, w, h) => {
        // Executive suite — dark panelling, brass accents, ambient glow
        const wall = ctx.createLinearGradient(0, 0, 0, h*0.65);
        wall.addColorStop(0, '#2e2418'); wall.addColorStop(1, '#3a2e20');
        ctx.fillStyle = wall; ctx.fillRect(0, 0, w, h);
        // Wall panels with inset detail
        for (let i = 0; i < 5; i++) {
            const px = w*(0.02+i*0.198);
            ctx.fillStyle = '#362a1e';
            ctx.beginPath(); ctx.roundRect(px, h*0.03, w*0.175, h*0.58, 2); ctx.fill();
            ctx.strokeStyle = '#4a3e30'; ctx.lineWidth = w*0.002;
            ctx.strokeRect(px+w*0.015, h*0.06, w*0.145, h*0.24);
            ctx.strokeRect(px+w*0.015, h*0.34, w*0.145, h*0.24);
        }
        // Dark hardwood floor
        const floor = ctx.createLinearGradient(0, h*0.64, 0, h);
        floor.addColorStop(0, '#28200a'); floor.addColorStop(0.1, '#302818'); floor.addColorStop(1, '#251e14');
        ctx.fillStyle = floor; ctx.fillRect(0, h*0.64, w, h*0.36);
        ctx.fillStyle = '#3a3020'; ctx.fillRect(0, h*0.64, w, h*0.005);
        // Window — filtered daylight through blinds
        ctx.fillStyle = '#444038'; ctx.fillRect(w*0.04, h*0.06, w*0.20, h*0.48);
        const dayGrad = ctx.createLinearGradient(w*0.05, h*0.07, w*0.23, h*0.52);
        dayGrad.addColorStop(0, '#8aa4b8'); dayGrad.addColorStop(1, '#a0b8c8');
        ctx.fillStyle = dayGrad; ctx.fillRect(w*0.05, h*0.07, w*0.18, h*0.46);
        // Venetian blinds
        ctx.fillStyle = 'rgba(200,190,170,0.55)';
        for (let i = 0; i < 14; i++) {
            ctx.fillRect(w*0.05, h*(0.07+i*0.033), w*0.18, h*0.014);
        }
        // Warm desk lamp glow
        _vbgGlow(ctx, w*0.82, h*0.48, w*0.18, '#ffeed0', 0.10);
        // Desk lamp
        ctx.fillStyle = '#8a7860';
        ctx.beginPath(); ctx.roundRect(w*0.80, h*0.42, w*0.04, h*0.015, 2); ctx.fill();
        ctx.fillStyle = '#666'; ctx.fillRect(w*0.815, h*0.435, w*0.008, h*0.18);
        // Leather chair top
        ctx.fillStyle = '#32281c';
        ctx.beginPath(); ctx.roundRect(w*0.35, h*0.52, w*0.30, h*0.18, 8); ctx.fill();
        ctx.fillStyle = '#3a3022';
        ctx.beginPath(); ctx.roundRect(w*0.37, h*0.54, w*0.26, h*0.14, 6); ctx.fill();
        _vbgGrain(ctx, w, h, 0.04);
    },
    // ── Casual & Social backgrounds ─────────────────────────
    coffeeshop: (ctx, w, h) => {
        // Cozy café — warm Edison lighting, exposed brick
        const wall = ctx.createRadialGradient(w*0.5, h*0.3, 0, w*0.5, h*0.3, w*0.7);
        wall.addColorStop(0, '#5a4030'); wall.addColorStop(0.5, '#4a3425'); wall.addColorStop(1, '#3a281c');
        ctx.fillStyle = wall; ctx.fillRect(0, 0, w, h);
        // Brick texture — subtle
        ctx.save(); ctx.globalAlpha = 0.15;
        for (let r = 0; r < 10; r++) {
            for (let c = 0; c < 14; c++) {
                const offset = (r % 2) * w*0.04;
                ctx.fillStyle = (r+c)%3 === 0 ? '#6a4a35' : '#5a3e2a';
                ctx.beginPath();
                ctx.roundRect(w*(0.005+c*0.075)+offset, h*(0.005+r*0.065), w*0.068, h*0.055, 1);
                ctx.fill();
            }
        }
        ctx.restore();
        // Wooden counter
        const counter = ctx.createLinearGradient(0, h*0.60, 0, h*0.66);
        counter.addColorStop(0, '#7a5e40'); counter.addColorStop(1, '#6a5038');
        ctx.fillStyle = counter; ctx.fillRect(0, h*0.60, w, h*0.06);
        // Floor
        ctx.fillStyle = '#2e2218'; ctx.fillRect(0, h*0.66, w, h*0.34);
        // Edison pendant lights — warm glows
        for (let i = 0; i < 4; i++) {
            const lx = w*(0.14+i*0.22);
            ctx.strokeStyle = '#4a4030'; ctx.lineWidth = w*0.002;
            ctx.beginPath(); ctx.moveTo(lx, 0); ctx.lineTo(lx, h*0.10); ctx.stroke();
            ctx.fillStyle = '#ffc860';
            ctx.beginPath(); ctx.ellipse(lx, h*0.13, w*0.008, h*0.022, 0, 0, Math.PI*2); ctx.fill();
            _vbgGlow(ctx, lx, h*0.13, w*0.08, '#ffcc70', 0.08);
        }
        // Chalkboard menu
        ctx.fillStyle = '#1e1e1e';
        ctx.beginPath(); ctx.roundRect(w*0.58, h*0.08, w*0.30, h*0.30, 3); ctx.fill();
        ctx.save(); ctx.globalAlpha = 0.35;
        ctx.strokeStyle = '#fff'; ctx.lineWidth = w*0.002;
        for (let i = 0; i < 5; i++) {
            const lw = w*(0.08 + Math.random()*0.12);
            ctx.beginPath(); ctx.moveTo(w*0.62, h*(0.14+i*0.05)); ctx.lineTo(w*0.62+lw, h*(0.14+i*0.05)); ctx.stroke();
        }
        ctx.restore();
        // Coffee cups on counter — tiny details
        ctx.fillStyle = '#f0e8d8';
        ctx.beginPath(); ctx.roundRect(w*0.25, h*0.575, w*0.02, h*0.025, 2); ctx.fill();
        ctx.beginPath(); ctx.roundRect(w*0.42, h*0.575, w*0.02, h*0.025, 2); ctx.fill();
        _vbgGrain(ctx, w, h, 0.04);
    },
    // ── Creative & Gradient backgrounds ─────────────────────
    softgradient: (ctx, w, h) => {
        // Soft neutral gradient — warm, mid-tone, Teams-style
        const bg = ctx.createRadialGradient(w*0.4, h*0.4, 0, w*0.5, h*0.5, w*0.8);
        bg.addColorStop(0, '#ddd2c4'); bg.addColorStop(0.4, '#d0c4b4'); bg.addColorStop(0.8, '#c4b8a4'); bg.addColorStop(1, '#b8aa94');
        ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
        // Soft light layers
        _vbgGlow(ctx, w*0.25, h*0.30, w*0.35, '#e8dcc8', 0.08);
        _vbgGlow(ctx, w*0.70, h*0.60, w*0.40, '#d4c8b4', 0.06);
        _vbgGlow(ctx, w*0.50, h*0.15, w*0.25, '#e0d4c0', 0.05);
        // Subtle linen texture
        ctx.save(); ctx.globalAlpha = 0.02;
        ctx.strokeStyle = '#8a7a6a'; ctx.lineWidth = 0.5;
        for (let x = 0; x < w; x += w*0.008) {
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
        }
        ctx.restore();
        _vbgGrain(ctx, w, h, 0.02);
    },
    skyline: (ctx, w, h) => {
        // Golden hour skyline — warm, photographic feel
        const sky = ctx.createLinearGradient(0, 0, 0, h*0.6);
        sky.addColorStop(0, '#e8946a'); sky.addColorStop(0.3, '#f0aa80'); sky.addColorStop(0.6, '#f4c4a0'); sky.addColorStop(1, '#f8dcc0');
        ctx.fillStyle = sky; ctx.fillRect(0, 0, w, h*0.65);
        // Sun
        _vbgGlow(ctx, w*0.5, h*0.22, w*0.10, '#fff4e0', 0.5);
        _vbgGlow(ctx, w*0.5, h*0.22, w*0.25, '#ffecd0', 0.15);
        // Haze at horizon
        _vbgGlow(ctx, w*0.5, h*0.58, w*0.6, '#f8d8b0', 0.12);
        // Building silhouettes — back layer (hazy)
        ctx.fillStyle = '#8a7060';
        ctx.beginPath(); ctx.moveTo(0, h*0.58);
        const backline = [[0,0.40],[0.06,0.48],[0.12,0.32],[0.20,0.42],[0.28,0.28],[0.36,0.45],[0.44,0.30],[0.52,0.50],[0.60,0.35],[0.68,0.48],[0.76,0.25],[0.84,0.40],[0.92,0.38],[1,0.42]];
        backline.forEach(([x,y]) => ctx.lineTo(w*x, h*(0.58-y*0.25)));
        ctx.lineTo(w, h*0.58); ctx.closePath(); ctx.fill();
        // Front buildings — darker
        ctx.fillStyle = '#5a4434';
        const frontData = [[0,0.10,0.32],[0.10,0.09,0.48],[0.19,0.12,0.30],[0.31,0.11,0.55],[0.42,0.09,0.38],[0.51,0.10,0.60],[0.61,0.12,0.34],[0.73,0.10,0.50],[0.83,0.08,0.42],[0.91,0.09,0.36]];
        frontData.forEach(([x,bw,bh2]) => {
            ctx.fillRect(w*x, h*(0.58-bh2*0.42), w*bw, h*bh2*0.42+h*0.42);
        });
        // Window lights
        ctx.fillStyle = 'rgba(255,230,170,0.35)';
        frontData.forEach(([x,bw,bh2]) => {
            const top = h*(0.58-bh2*0.42);
            for (let wy = top+h*0.02; wy < h*0.58; wy += h*0.028) {
                for (let wx = w*x+w*0.01; wx < w*(x+bw)-w*0.008; wx += w*0.016) {
                    if (Math.random()>0.35) ctx.fillRect(wx, wy, w*0.006, h*0.014);
                }
            }
        });
        _vbgGrain(ctx, w, h, 0.025);
    },
    warmtone: (ctx, w, h) => {
        // Warm terracotta — radial, professional-grade
        const bg = ctx.createRadialGradient(w*0.45, h*0.45, 0, w*0.5, h*0.5, w*0.75);
        bg.addColorStop(0, '#c8a07a'); bg.addColorStop(0.3, '#b8906a'); bg.addColorStop(0.7, '#a87858'); bg.addColorStop(1, '#8a6040');
        ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
        // Soft light blooms
        _vbgGlow(ctx, w*0.30, h*0.35, w*0.30, '#d8b88a', 0.08);
        _vbgGlow(ctx, w*0.70, h*0.55, w*0.25, '#c8a878', 0.06);
        _vbgGlow(ctx, w*0.50, h*0.20, w*0.20, '#d4b890', 0.05);
        // Subtle fabric weave texture
        ctx.save(); ctx.globalAlpha = 0.02;
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 0.5;
        for (let x = 0; x < w; x += w*0.006) {
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
        }
        for (let y = 0; y < h; y += h*0.006) {
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
        }
        ctx.restore();
        _vbgGrain(ctx, w, h, 0.03);
    },
};

async function initSegmenter() {
    if (selfieSegmenter) return true;
    try {
        if (typeof SelfieSegmentation === 'undefined') {
            console.warn('SelfieSegmentation not available, using fallback mask');
            vbgUseFallback = true;
            return false;
        }
        showToast("Loading background model...");
        selfieSegmenter = new SelfieSegmentation({
            locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${file}`
        });
        selfieSegmenter.setOptions({ modelSelection: 1, selfieMode: true });
        selfieSegmenter.onResults((results) => {
            segMask = results.segmentationMask;
        });
        // Warm up with timeout
        const warmup = document.createElement('canvas');
        warmup.width = 4; warmup.height = 4;
        warmup.getContext('2d').fillRect(0, 0, 4, 4);
        const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000));
        await Promise.race([selfieSegmenter.send({ image: warmup }), timeout]);
        showToast("Background model ready");
        return true;
    } catch (e) {
        console.warn('Segmenter init failed, using fallback:', e);
        selfieSegmenter = null;
        vbgUseFallback = true;
        showToast("Using portrait mask (model unavailable)");
        return false;
    }
}

function createFallbackMask(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, w, h);

    // Soft body-shaped silhouette with feathered edges
    ctx.fillStyle = 'white';
    ctx.shadowColor = 'white';
    ctx.shadowBlur = 35;

    // Head
    ctx.beginPath();
    ctx.ellipse(w * 0.5, h * 0.18, w * 0.11, h * 0.13, 0, 0, Math.PI * 2);
    ctx.fill();

    // Neck + shoulders + torso (extends below frame)
    ctx.beginPath();
    ctx.moveTo(w * 0.43, h * 0.31);
    ctx.quadraticCurveTo(w * 0.36, h * 0.36, w * 0.12, h * 0.44);
    ctx.lineTo(w * 0.03, h * 0.56);
    ctx.lineTo(w * 0.03, h * 1.1);
    ctx.lineTo(w * 0.97, h * 1.1);
    ctx.lineTo(w * 0.97, h * 0.56);
    ctx.lineTo(w * 0.88, h * 0.44);
    ctx.quadraticCurveTo(w * 0.64, h * 0.36, w * 0.57, h * 0.31);
    ctx.closePath();
    ctx.fill();

    ctx.shadowBlur = 0;
    return c;
}

// ── Meeting Transcript Log ──────────────────────────────────────────────
const meetingTranscript = [];
function logTranscript(type, name, text) {
    meetingTranscript.push({
        type,
        name,
        text,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    });
}

// ── Speech-to-Text Captions ─────────────────────────────────────────────
let captionsEnabled = false;
let recognition = null;

function toggleCaptions() {
    captionsEnabled = !captionsEnabled;
    const btn = document.getElementById("captionBtn");
    const overlay = document.getElementById("captionsOverlay");
    btn.classList.toggle("active", captionsEnabled);
    btn.querySelector(".material-icons-round").textContent = captionsEnabled ? "closed_caption" : "closed_caption_off";
    overlay.style.display = captionsEnabled ? "" : "none";
    if (captionsEnabled) {
        startSpeechRecognition();
    } else {
        stopSpeechRecognition();
        document.getElementById("captionsContent").innerHTML = "";
    }
}

function startSpeechRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        showToast("Speech recognition not supported in this browser");
        toggleCaptions();
        return;
    }
    recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => {
        let interim = "";
        let final = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
            const transcript = event.results[i][0].transcript;
            if (event.results[i].isFinal) {
                final += transcript;
            } else {
                interim += transcript;
            }
        }
        if (final) {
            showCaption(myName, final);
            logTranscript('speech', myName, final);
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ action: "caption", text: final }));
            }
        }
        if (interim) {
            showCaption(myName, interim, true);
        }
    };

    recognition.onerror = (event) => {
        if (event.error === "not-allowed") {
            showToast("Microphone permission denied for captions");
            toggleCaptions();
        } else if (event.error !== "no-speech" && event.error !== "aborted") {
            console.warn("Speech recognition error:", event.error);
        }
    };

    recognition.onend = () => {
        if (captionsEnabled) {
            try { recognition.start(); } catch (e) { /* already started */ }
        }
    };

    try { recognition.start(); } catch (e) { /* already started */ }
    showToast("Captions enabled");
}

function stopSpeechRecognition() {
    if (recognition) {
        captionsEnabled = false;
        try { recognition.stop(); } catch (e) {}
        recognition = null;
    }
}

// ── Schedule Meeting ─────────────────────────────────────────────────────
(function initSchedule() {
    const scheduleBtn = document.getElementById("scheduleMeetingBtn");
    const scheduleModal = document.getElementById("scheduleModal");
    const closeScheduleModal = document.getElementById("closeScheduleModal");
    const schCancelBtn = document.getElementById("schCancelBtn");
    const schSaveBtn = document.getElementById("schSaveBtn");
    const schRecurring = document.getElementById("schRecurring");
    const schRecurringOptions = document.getElementById("schRecurringOptions");
    const schPasscode = document.getElementById("schPasscode");
    const schPasscodeGroup = document.getElementById("schPasscodeGroup");
    const schTimezone = document.getElementById("schTimezone");
    const scheduledList = document.getElementById("scheduledMeetingsList");
    const scheduledContent = document.getElementById("scheduledMeetingsContent");

    if (!scheduleBtn) return;

    // Populate timezone dropdown with GMT offsets
    const gmtZones = [
        { value: "Etc/GMT+12",  label: "GMT-12:00" },
        { value: "Etc/GMT+11",  label: "GMT-11:00" },
        { value: "Etc/GMT+10",  label: "GMT-10:00 (Hawaii)" },
        { value: "Etc/GMT+9",   label: "GMT-09:00 (Alaska)" },
        { value: "Etc/GMT+8",   label: "GMT-08:00 (Pacific)" },
        { value: "Etc/GMT+7",   label: "GMT-07:00 (Mountain)" },
        { value: "Etc/GMT+6",   label: "GMT-06:00 (Central)" },
        { value: "Etc/GMT+5",   label: "GMT-05:00 (Eastern)" },
        { value: "Etc/GMT+4",   label: "GMT-04:00 (Atlantic)" },
        { value: "Etc/GMT+3",   label: "GMT-03:00 (Buenos Aires)" },
        { value: "Etc/GMT+2",   label: "GMT-02:00" },
        { value: "Etc/GMT+1",   label: "GMT-01:00 (Azores)" },
        { value: "UTC",         label: "GMT+00:00 (UTC/London)" },
        { value: "Etc/GMT-1",   label: "GMT+01:00 (Dublin/Paris)" },
        { value: "Etc/GMT-2",   label: "GMT+02:00 (Cairo/Helsinki)" },
        { value: "Etc/GMT-3",   label: "GMT+03:00 (Moscow/Nairobi)" },
        { value: "Etc/GMT-4",   label: "GMT+04:00 (Dubai)" },
        { value: "Asia/Kolkata", label: "GMT+05:30 (India)" },
        { value: "Etc/GMT-6",   label: "GMT+06:00 (Dhaka)" },
        { value: "Etc/GMT-7",   label: "GMT+07:00 (Bangkok)" },
        { value: "Etc/GMT-8",   label: "GMT+08:00 (Singapore/Beijing)" },
        { value: "Etc/GMT-9",   label: "GMT+09:00 (Tokyo/Seoul)" },
        { value: "Etc/GMT-10",  label: "GMT+10:00 (Sydney)" },
        { value: "Etc/GMT-11",  label: "GMT+11:00" },
        { value: "Etc/GMT-12",  label: "GMT+12:00 (Auckland)" },
    ];
    const userOffset = -(new Date().getTimezoneOffset());
    const userOffsetHrs = Math.round(userOffset / 60);
    gmtZones.forEach(tz => {
        const opt = document.createElement("option");
        opt.value = tz.value;
        opt.textContent = tz.label;
        schTimezone.appendChild(opt);
    });
    // Select closest GMT offset to user's local timezone
    const bestMatch = gmtZones.reduce((best, tz) => {
        const tzDate = new Date().toLocaleString("en-US", { timeZone: tz.value });
        const tzOffset = -(new Date(tzDate).getTimezoneOffset ? 0 : 0);
        return tz.label.includes(`GMT+${String(userOffsetHrs).padStart(2, "0")}`) ||
               tz.label.includes(`GMT-${String(-userOffsetHrs).padStart(2, "0")}`) ? tz : best;
    }, gmtZones[12]);
    schTimezone.value = bestMatch.value;

    // Populate time dropdown with 15-minute slots
    const schTimeSelect = document.getElementById("schTime");
    for (let h = 0; h < 24; h++) {
        for (let m = 0; m < 60; m += 15) {
            const hh = String(h).padStart(2, "0");
            const mm = String(m).padStart(2, "0");
            const opt = document.createElement("option");
            opt.value = `${hh}:${mm}`;
            const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
            const ampm = h < 12 ? "AM" : "PM";
            opt.textContent = `${h12}:${mm} ${ampm}`;
            schTimeSelect.appendChild(opt);
        }
    }

    // Set default date/time to next 15-min slot
    const now = new Date();
    now.setMinutes(Math.ceil(now.getMinutes() / 15) * 15 + 15, 0, 0);
    if (now.getMinutes() === 0 && Math.ceil(new Date().getMinutes() / 15) * 15 >= 60) {
        now.setHours(now.getHours());
    }
    document.getElementById("schDate").value = now.toISOString().split("T")[0];
    document.getElementById("schDate").min = new Date().toISOString().split("T")[0];
    const defaultTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    schTimeSelect.value = defaultTime;

    // Random passcode
    function generatePasscode() {
        return Math.random().toString(36).substring(2, 8);
    }
    document.getElementById("schPasscodeInput").value = generatePasscode();

    // Toggle recurring options
    schRecurring.addEventListener("change", () => {
        schRecurringOptions.style.display = schRecurring.checked ? "" : "none";
        if (schRecurring.checked && !document.getElementById("schEndDate").value) {
            const end = new Date(now);
            end.setMonth(end.getMonth() + 3);
            document.getElementById("schEndDate").value = end.toISOString().split("T")[0];
        }
    });

    // Toggle passcode input
    schPasscode.addEventListener("change", () => {
        schPasscodeGroup.style.display = schPasscode.checked ? "" : "none";
        if (schPasscode.checked && !document.getElementById("schPasscodeInput").value) {
            document.getElementById("schPasscodeInput").value = generatePasscode();
        }
    });

    // Open modal
    scheduleBtn.addEventListener("click", () => {
        if (!isAuthenticated) {
            showToast("Please sign in with Google to schedule a meeting");
            return;
        }
        scheduleModal.style.display = "flex";
        document.getElementById("schTopic").focus();
    });

    // Close modal
    function closeModal() {
        scheduleModal.style.display = "none";
    }
    closeScheduleModal.addEventListener("click", closeModal);
    schCancelBtn.addEventListener("click", closeModal);
    scheduleModal.addEventListener("click", (e) => {
        if (e.target === scheduleModal) closeModal();
    });

    // Save meeting
    schSaveBtn.addEventListener("click", async () => {
        const topic = document.getElementById("schTopic").value.trim() || "Untitled Meeting";
        const date = document.getElementById("schDate").value;
        const time = document.getElementById("schTime").value;
        const duration = document.getElementById("schDuration").value;
        const timezone = schTimezone.value;
        const recurring = schRecurring.checked;
        const recurrence = document.getElementById("schRecurrence").value;
        const endDate = document.getElementById("schEndDate").value;
        const passcodeEnabled = schPasscode.checked;
        const passcode = document.getElementById("schPasscodeInput").value.trim();
        const waitingRoom = document.getElementById("schWaitingRoom").checked;
        const hostVideo = document.querySelector('input[name="schHostVideo"]:checked').value;
        const participantVideo = document.querySelector('input[name="schParticipantVideo"]:checked').value;
        const muteOnEntry = document.getElementById("schMuteOnEntry").checked;
        const autoRecord = document.getElementById("schAutoRecord").checked;
        const description = document.getElementById("schDescription").value.trim();

        if (!date || !time) {
            showToast("Please select date and time");
            return;
        }

        const selectedDateTime = new Date(`${date}T${time}`);
        const meetingEndTime = new Date(selectedDateTime.getTime() + parseInt(duration) * 60000);
        if (meetingEndTime <= new Date()) {
            showToast("Cannot schedule a meeting that has already ended");
            return;
        }

        schSaveBtn.disabled = true;
        schSaveBtn.textContent = "Scheduling...";

        try {
            const resp = await fetch("/api/schedule", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    topic, date, time, duration, timezone, recurring, recurrence,
                    endDate, passcodeEnabled, passcode, waitingRoom, hostVideo,
                    participantVideo, muteOnEntry, autoRecord, description,
                    createdBy: authenticatedUserName || nameInput.value.trim() || "Host",
                }),
            });
            const meeting = await resp.json();
            showToast("Meeting scheduled!");
            closeModal();
            loadScheduledMeetings();

            // Show copy-invite dialog
            showScheduleConfirmation(meeting);
        } catch (e) {
            showToast("Failed to schedule meeting");
        } finally {
            schSaveBtn.disabled = false;
            schSaveBtn.innerHTML = '<span class="material-icons-round">event_available</span> Schedule';
        }
    });

    // Show confirmation with invite link
    function showScheduleConfirmation(meeting) {
        const shareOrigin = (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") ? "https://huddle-meet.onrender.com" : window.location.origin;
        const inviteLink = `${shareOrigin}/room/${meeting.room_id}`;
        const dateStr = new Date(`${meeting.date}T${meeting.time}`).toLocaleString(undefined, {
            weekday: "long", year: "numeric", month: "long", day: "numeric",
            hour: "2-digit", minute: "2-digit"
        });
        const passcodeInfo = meeting.passcodeEnabled && meeting.passcode
            ? `\nPasscode: ${meeting.passcode}` : "";

        const organiserInfo = meeting.createdBy ? `\nOrganised by: ${meeting.createdBy}` : '';
        const agendaInfo = meeting.description ? `\n\nAgenda:\n${meeting.description}` : '';
        const inviteText = `Huddle Meeting\n\nTopic: ${meeting.topic}\nTime: ${dateStr}\nDuration: ${meeting.duration} min${organiserInfo}${agendaInfo}\n\nJoin: ${inviteLink}${passcodeInfo}`;

        if (navigator.clipboard) {
            navigator.clipboard.writeText(inviteText).then(() => {
                showToast("Invite copied to clipboard!");
            });
        }
    }

    function _calendarDates(meeting) {
        const start = new Date(`${meeting.date}T${meeting.time}`);
        const end = new Date(start.getTime() + (meeting.duration || 30) * 60000);
        const fmt = d => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
        return { start, end, startStr: fmt(start), endStr: fmt(end) };
    }

    function openGoogleCalendar(meeting) {
        const shareOrigin = (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") ? "https://huddle-meet.onrender.com" : window.location.origin;
        const inviteLink = `${shareOrigin}/room/${meeting.room_id}`;
        const { startStr, endStr } = _calendarDates(meeting);
        const passcodeInfo = meeting.passcodeEnabled && meeting.passcode ? `\nPasscode: ${meeting.passcode}` : "";
        const agendaInfo = meeting.description ? `\n\nAgenda:\n${meeting.description}` : '';
        const details = `Join: ${inviteLink}${passcodeInfo}${agendaInfo}`;
        const url = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(meeting.topic)}&dates=${startStr}/${endStr}&details=${encodeURIComponent(details)}`;
        window.open(url, "_blank");
    }

    function downloadICS(meeting) {
        const shareOrigin = (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") ? "https://huddle-meet.onrender.com" : window.location.origin;
        const inviteLink = `${shareOrigin}/room/${meeting.room_id}`;
        const { startStr, endStr } = _calendarDates(meeting);
        const passcodeInfo = meeting.passcodeEnabled && meeting.passcode ? `\\nPasscode: ${meeting.passcode}` : "";
        const agendaInfo = meeting.description ? `\\n\\nAgenda:\\n${meeting.description.replace(/\n/g, '\\n')}` : '';
        const uid = `${meeting.id}@huddle-meet`;
        const ics = [
            "BEGIN:VCALENDAR",
            "VERSION:2.0",
            "PRODID:-//Huddle//Meet//EN",
            "BEGIN:VEVENT",
            `UID:${uid}`,
            `DTSTART:${startStr}`,
            `DTEND:${endStr}`,
            `SUMMARY:${meeting.topic}`,
            `DESCRIPTION:Join: ${inviteLink}${passcodeInfo}${agendaInfo}`,
            `URL:${inviteLink}`,
            "END:VEVENT",
            "END:VCALENDAR"
        ].join("\r\n");
        const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `${meeting.topic.replace(/[^a-zA-Z0-9 ]/g, "").trim() || "meeting"}.ics`;
        a.click();
        URL.revokeObjectURL(a.href);
    }

    // ── Calendar helpers ──────────────────────────────────────────────────
    function _meetingDateTime(m) {
        const [y, mo, d] = m.date.split("-").map(Number);
        const [h, mi] = m.time.split(":").map(Number);
        const start = new Date(y, mo - 1, d, h, mi);
        const end = new Date(start.getTime() + (m.duration || 30) * 60000);
        return { start, end };
    }
    function _pad(n) { return String(n).padStart(2, "0"); }
    function _gcalFmt(d) {
        return `${d.getFullYear()}${_pad(d.getMonth()+1)}${_pad(d.getDate())}T${_pad(d.getHours())}${_pad(d.getMinutes())}00`;
    }

    function openGoogleCalendar(m) {
        const { start, end } = _meetingDateTime(m);
        const shareOrigin = (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")
            ? "https://huddle-meet.onrender.com" : window.location.origin;
        const link = `${shareOrigin}/room/${m.room_id}`;
        const params = new URLSearchParams({
            action: "TEMPLATE",
            text: m.topic || "Huddle Meeting",
            dates: `${_gcalFmt(start)}/${_gcalFmt(end)}`,
            details: `Join: ${link}${m.passcode ? "\nPasscode: " + m.passcode : ""}`,
            location: link,
        });
        window.open(`https://calendar.google.com/calendar/render?${params}`, "_blank");
    }

    function downloadICS(m) {
        const { start, end } = _meetingDateTime(m);
        const shareOrigin = (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")
            ? "https://huddle-meet.onrender.com" : window.location.origin;
        const link = `${shareOrigin}/room/${m.room_id}`;
        const fmt = d => `${d.getFullYear()}${_pad(d.getMonth()+1)}${_pad(d.getDate())}T${_pad(d.getHours())}${_pad(d.getMinutes())}00`;
        const ics = [
            "BEGIN:VCALENDAR",
            "VERSION:2.0",
            "PRODID:-//Huddle//Meeting//EN",
            "BEGIN:VEVENT",
            `DTSTART:${fmt(start)}`,
            `DTEND:${fmt(end)}`,
            `SUMMARY:${(m.topic || "Huddle Meeting").replace(/[,;\\]/g, " ")}`,
            `DESCRIPTION:Join: ${link}${m.passcode ? "\\nPasscode: " + m.passcode : ""}`,
            `URL:${link}`,
            `UID:${m.id}@huddle-meet`,
            "END:VEVENT",
            "END:VCALENDAR"
        ].join("\r\n");
        const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `${(m.topic || "meeting").replace(/[^a-zA-Z0-9]/g, "_")}.ics`;
        a.click();
        URL.revokeObjectURL(a.href);
    }

    // Load and display scheduled meetings
    async function loadScheduledMeetings() {
        try {
            const resp = await fetch("/api/schedule");
            const meetings = await resp.json();
            if (meetings.length === 0) {
                scheduledContent.innerHTML = `
                    <div class="meetings-empty">
                        <span class="material-icons-round">event_available</span>
                        <p>No upcoming meetings</p>
                        <span>Schedule one to get started</span>
                    </div>`;
                return;
            }
            scheduledContent.innerHTML = meetings.map(m => {
                const dt = new Date(`${m.date}T${m.time}`);
                const endDt = new Date(dt.getTime() + (m.duration || 30) * 60000);
                const now = new Date();
                const isLive = dt <= now && endDt > now;
                const isPast = endDt <= now;
                const dateStr = dt.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
                const timeStr = dt.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
                const statusClass = isPast ? "meeting-past" : isLive ? "meeting-live" : "meeting-upcoming";
                const nowBadge = isLive ? '<span class="smc-badge smc-badge-live">Now</span>' : '';
                return `
                    <div class="scheduled-meeting-card ${statusClass}">
                        <div class="smc-info">
                            <div class="smc-topic">${escapeHtml(m.topic)} ${nowBadge}</div>
                            <div class="smc-datetime">${dateStr} at ${timeStr}</div>
                            <div class="smc-duration">${m.duration} min ${m.recurring ? '<span class="smc-badge">Recurring</span>' : ''}</div>
                            ${m.createdBy ? `<div class="smc-host">Organised by ${escapeHtml(m.createdBy)}</div>` : ''}
                        </div>
                        <div class="smc-actions">
                            <button class="btn-small smc-join" data-room="${m.room_id}" ${isPast ? 'disabled' : ''}>
                                ${isLive ? 'Join Now' : 'Join'}
                            </button>
                            <button class="icon-btn smc-gcal" data-meeting='${JSON.stringify(m).replace(/'/g, "&#39;")}' title="Add to Google Calendar">
                                <span class="material-icons-round">event</span>
                            </button>
                            <button class="icon-btn smc-ics" data-meeting='${JSON.stringify(m).replace(/'/g, "&#39;")}' title="Download .ics (Outlook)">
                                <span class="material-icons-round">download</span>
                            </button>
                            <button class="icon-btn smc-copy" data-meeting='${JSON.stringify(m).replace(/'/g, "&#39;")}' title="Copy invite">
                                <span class="material-icons-round">content_copy</span>
                            </button>
                            <button class="icon-btn smc-edit" data-meeting='${JSON.stringify(m).replace(/'/g, "&#39;")}' title="Edit">
                                <span class="material-icons-round">edit</span>
                            </button>
                            <button class="icon-btn smc-delete" data-id="${m.id}" title="Delete">
                                <span class="material-icons-round">delete_outline</span>
                            </button>
                        </div>
                    </div>`;
            }).join("");

            // Attach event listeners
            scheduledContent.querySelectorAll(".smc-join").forEach(btn => {
                btn.addEventListener("click", () => joinRoom(btn.dataset.room));
            });
            scheduledContent.querySelectorAll(".smc-copy").forEach(btn => {
                btn.addEventListener("click", () => {
                    const m = JSON.parse(btn.dataset.meeting);
                    showScheduleConfirmation(m);
                });
            });
            scheduledContent.querySelectorAll(".smc-gcal").forEach(btn => {
                btn.addEventListener("click", () => {
                    openGoogleCalendar(JSON.parse(btn.dataset.meeting));
                });
            });
            scheduledContent.querySelectorAll(".smc-ics").forEach(btn => {
                btn.addEventListener("click", () => {
                    downloadICS(JSON.parse(btn.dataset.meeting));
                });
            });
            scheduledContent.querySelectorAll(".smc-edit").forEach(btn => {
                btn.addEventListener("click", () => {
                    const m = JSON.parse(btn.dataset.meeting);
                    openEditScheduleModal(m);
                });
            });
            scheduledContent.querySelectorAll(".smc-delete").forEach(btn => {
                btn.addEventListener("click", async () => {
                    await fetch(`/api/schedule/${btn.dataset.id}`, { method: "DELETE" });
                    showToast("Meeting deleted");
                    loadScheduledMeetings();
                });
            });
        } catch (e) {
            console.error("Failed to load scheduled meetings:", e);
        }
    }

    // ── Edit scheduled meeting ──────────────────────────────────────────
    let editingMeetingId = null;

    function openEditScheduleModal(m) {
        editingMeetingId = m.id;
        document.getElementById("schTopic").value = m.topic || "";
        document.getElementById("schDate").value = m.date || "";
        document.getElementById("schTime").value = m.time || "";
        document.getElementById("schDuration").value = m.duration || 30;
        if (m.timezone) schTimezone.value = m.timezone;
        schRecurring.checked = !!m.recurring;
        schRecurringOptions.style.display = m.recurring ? "" : "none";
        if (m.recurrence) document.getElementById("schRecurrence").value = m.recurrence;
        if (m.endDate) document.getElementById("schEndDate").value = m.endDate;
        schPasscode.checked = m.passcodeEnabled !== false;
        schPasscodeGroup.style.display = schPasscode.checked ? "" : "none";
        document.getElementById("schPasscodeInput").value = m.passcode || "";
        document.getElementById("schWaitingRoom").checked = !!m.waitingRoom;
        const hostVideoOn = document.querySelector('input[name="schHostVideo"][value="on"]');
        const hostVideoOff = document.querySelector('input[name="schHostVideo"][value="off"]');
        if (m.hostVideo === "off" && hostVideoOff) hostVideoOff.checked = true;
        else if (hostVideoOn) hostVideoOn.checked = true;
        const partVideoOn = document.querySelector('input[name="schParticipantVideo"][value="on"]');
        const partVideoOff = document.querySelector('input[name="schParticipantVideo"][value="off"]');
        if (m.participantVideo === "off" && partVideoOff) partVideoOff.checked = true;
        else if (partVideoOn) partVideoOn.checked = true;
        document.getElementById("schMuteOnEntry").checked = m.muteOnEntry !== false;
        document.getElementById("schAutoRecord").checked = !!m.autoRecord;
        document.getElementById("schDescription").value = m.description || "";

        schSaveBtn.innerHTML = '<span class="material-icons-round">save</span> Update';
        scheduleModal.style.display = "flex";
        document.getElementById("schTopic").focus();
    }

    // Patch Save button to handle both create and update
    const origSaveHandler = schSaveBtn.onclick;
    schSaveBtn.addEventListener("click", async (e) => {
        if (!editingMeetingId) return; // let the existing handler run for new meetings
        e.stopImmediatePropagation();

        const topic = document.getElementById("schTopic").value.trim() || "Untitled Meeting";
        const date = document.getElementById("schDate").value;
        const time = document.getElementById("schTime").value;
        const duration = document.getElementById("schDuration").value;
        const timezone = schTimezone.value;
        const recurring = schRecurring.checked;
        const recurrence = document.getElementById("schRecurrence").value;
        const endDate = document.getElementById("schEndDate").value;
        const passcodeEnabled = schPasscode.checked;
        const passcode = document.getElementById("schPasscodeInput").value.trim();
        const waitingRoom = document.getElementById("schWaitingRoom").checked;
        const hostVideo = document.querySelector('input[name="schHostVideo"]:checked').value;
        const participantVideo = document.querySelector('input[name="schParticipantVideo"]:checked').value;
        const muteOnEntry = document.getElementById("schMuteOnEntry").checked;
        const autoRecord = document.getElementById("schAutoRecord").checked;
        const description = document.getElementById("schDescription").value.trim();

        if (!date || !time) { showToast("Please select date and time"); return; }

        schSaveBtn.disabled = true;
        schSaveBtn.textContent = "Updating...";

        try {
            const resp = await fetch(`/api/schedule/${editingMeetingId}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    topic, date, time, duration, timezone, recurring, recurrence,
                    endDate, passcodeEnabled, passcode, waitingRoom, hostVideo,
                    participantVideo, muteOnEntry, autoRecord, description,
                }),
            });
            if (resp.ok) {
                showToast("Meeting updated!");
                scheduleModal.style.display = "none";
                loadScheduledMeetings();
            } else {
                showToast("Failed to update meeting");
            }
        } catch (err) {
            showToast("Failed to update meeting");
        } finally {
            editingMeetingId = null;
            schSaveBtn.disabled = false;
            schSaveBtn.innerHTML = '<span class="material-icons-round">event_available</span> Schedule';
        }
    }, true); // useCapture=true to run before the create handler

    // Reset editingMeetingId when opening for a new meeting
    scheduleBtn.addEventListener("click", () => {
        editingMeetingId = null;
        schSaveBtn.innerHTML = '<span class="material-icons-round">event_available</span> Schedule';
    });

    // Reset on modal close
    function resetEditState() {
        editingMeetingId = null;
        schSaveBtn.innerHTML = '<span class="material-icons-round">event_available</span> Schedule';
    }
    closeScheduleModal.addEventListener("click", resetEditState);
    schCancelBtn.addEventListener("click", resetEditState);

    // Load on startup
    loadScheduledMeetings();
})();

function showCaption(name, text, isInterim) {
    if (!captionsEnabled) return;
    const container = document.getElementById("captionsContent");
    const existingInterim = container.querySelector(".caption-interim");
    if (isInterim) {
        if (existingInterim) {
            existingInterim.innerHTML = `<span class="caption-name">${escapeHtml(name)}:</span> ${escapeHtml(text)}`;
        } else {
            const el = document.createElement("div");
            el.className = "caption-line caption-interim";
            el.style.opacity = "0.7";
            el.innerHTML = `<span class="caption-name">${escapeHtml(name)}:</span> ${escapeHtml(text)}`;
            container.appendChild(el);
        }
    } else {
        if (existingInterim) existingInterim.remove();
        const el = document.createElement("div");
        el.className = "caption-line";
        el.innerHTML = `<span class="caption-name">${escapeHtml(name)}:</span> ${escapeHtml(text)}`;
        container.appendChild(el);
        // Keep only last 3 final captions
        const finals = container.querySelectorAll(".caption-line:not(.caption-interim)");
        while (finals.length > 3) finals[0].remove();
        // Auto-remove after 8 seconds
        setTimeout(() => { if (el.parentNode) el.remove(); }, 8000);
    }
}



function vbgRenderLoop() {
    if (!bgBlurEnabled || !vbgTempVideo) return;
    const w = bgBlurCanvas.width, h = bgBlurCanvas.height;

    const processFrame = () => {
        if (!bgBlurEnabled) return;

        // Step 1: Draw video on person canvas
        vbgPersonCtx.clearRect(0, 0, w, h);
        vbgPersonCtx.drawImage(vbgTempVideo, 0, 0, w, h);

        // Step 2: Apply mask to cut out person with transparent background
        if (segMask && !vbgUseFallback) {
            // MediaPipe mask: R channel = person confidence (white=person, black=bg)
            vbgMaskCtx.clearRect(0, 0, w, h);
            vbgMaskCtx.drawImage(segMask, 0, 0, w, h);
            const maskData = vbgMaskCtx.getImageData(0, 0, w, h);
            const md = maskData.data;
            const len = w * h;

            // === A. Foreground-biased threshold + smoothstep ===
            // Shift uncertain pixels toward foreground so head/face aren't cut out
            const curMask = new Uint8Array(len);
            for (let p = 0; p < len; p++) {
                let v = md[p * 4] / 255;
                // Bias: boost values above 0.2 toward foreground
                v = Math.min(1, v * 1.6 + 0.12);
                // Smoothstep contrast curve
                v = v * v * (3 - 2 * v);
                // Lower threshold: keep more uncertain edge pixels as person
                curMask[p] = v > 0.22 ? ((v * 255 + 0.5) | 0) : 0;
            }

            // === B. Morphological dilation (5x5) to fill gaps in head/shoulders/hair ===
            const dilated = new Uint8Array(len);
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    let maxVal = 0;
                    for (let dy = -2; dy <= 2; dy++) {
                        for (let dx = -2; dx <= 2; dx++) {
                            const ny = y + dy, nx = x + dx;
                            if (ny >= 0 && ny < h && nx >= 0 && nx < w) {
                                const nv = curMask[ny * w + nx];
                                if (nv > maxVal) maxVal = nv;
                            }
                        }
                    }
                    dilated[y * w + x] = maxVal;
                }
            }

            // === C. Temporal smoothing (EMA) to prevent frame flicker ===
            if (!vbgPrevMask || vbgPrevMask.length !== len) {
                vbgPrevMask = dilated;
            } else {
                for (let p = 0; p < len; p++) {
                    // Asymmetric blending: appearing is fast, disappearing is very slow
                    // This prevents face/head from vanishing on brief low-confidence frames
                    const cur = dilated[p], prev = vbgPrevMask[p];
                    const a = cur >= prev ? 0.8 : 0.3; // appear fast, disappear very slow
                    vbgPrevMask[p] = (a * cur + (1 - a) * prev + 0.5) | 0;
                }
            }

            // === D. Write smoothed mask back as alpha ===
            for (let p = 0; p < len; p++) {
                const i4 = p * 4;
                md[i4] = md[i4 + 1] = md[i4 + 2] = 255;
                md[i4 + 3] = vbgPrevMask[p];
            }

            // === E. Blur pass for soft feathered edges ===
            vbgTempMaskCtx.putImageData(maskData, 0, 0);
            vbgMaskCtx.clearRect(0, 0, w, h);
            vbgMaskCtx.filter = 'blur(8px)';
            vbgMaskCtx.drawImage(vbgTempMaskCanvas, 0, 0);
            vbgMaskCtx.filter = 'none';

            // Cut person from video using soft alpha mask
            vbgPersonCtx.globalCompositeOperation = 'destination-in';
            vbgPersonCtx.drawImage(vbgMaskCanvas, 0, 0);
            vbgPersonCtx.globalCompositeOperation = 'source-over';
        } else if (vbgFallbackMask) {
            // Fallback: pre-rendered body silhouette already has correct alpha
            vbgPersonCtx.globalCompositeOperation = 'destination-in';
            vbgPersonCtx.drawImage(vbgFallbackMask, 0, 0);
            vbgPersonCtx.globalCompositeOperation = 'source-over';
        }

        // Step 3: Compose → background first, then person on top
        bgBlurCtx.clearRect(0, 0, w, h);
        if (vbgMode === 'blur') {
            bgBlurCtx.filter = 'blur(12px)';
            bgBlurCtx.drawImage(vbgTempVideo, 0, 0, w, h);
            bgBlurCtx.filter = 'none';
        } else if (vbgSceneBg) {
            bgBlurCtx.drawImage(vbgSceneBg, 0, 0, w, h);
        }
        bgBlurCtx.drawImage(vbgPersonCanvas, 0, 0);

        requestAnimationFrame(vbgRenderLoop);
    };

    // Send frame to segmenter if available, otherwise use fallback directly
    if (selfieSegmenter && !vbgUseFallback) {
        selfieSegmenter.send({ image: vbgTempVideo }).then(processFrame).catch(() => {
            processFrame(); // Use last known mask or fallback
        });
    } else {
        processFrame();
    }
}

function startVbgPipeline(mode, sceneBgCanvas) {
    if (!localStream) return;
    const videoTrack = localStream.getVideoTracks()[0];
    if (!videoTrack) return;
    const w = 640, h = 480;

    bgBlurCanvas = document.createElement('canvas');
    bgBlurCanvas.width = w; bgBlurCanvas.height = h;
    bgBlurCtx = bgBlurCanvas.getContext('2d');

    vbgPersonCanvas = document.createElement('canvas');
    vbgPersonCanvas.width = w; vbgPersonCanvas.height = h;
    vbgPersonCtx = vbgPersonCanvas.getContext('2d');

    vbgMaskCanvas = document.createElement('canvas');
    vbgMaskCanvas.width = w; vbgMaskCanvas.height = h;
    vbgMaskCtx = vbgMaskCanvas.getContext('2d');

    vbgTempMaskCanvas = document.createElement('canvas');
    vbgTempMaskCanvas.width = w; vbgTempMaskCanvas.height = h;
    vbgTempMaskCtx = vbgTempMaskCanvas.getContext('2d');

    if (vbgUseFallback && !vbgFallbackMask) {
        vbgFallbackMask = createFallbackMask(w, h);
    }

    bgBlurEnabled = true;
    vbgMode = mode;
    vbgSceneBg = sceneBgCanvas || null;

    vbgTempVideo = document.createElement('video');
    vbgTempVideo.srcObject = new MediaStream([videoTrack]);
    vbgTempVideo.muted = true;
    vbgTempVideo.addEventListener('loadeddata', () => {
        vbgRenderLoop();
    });
    vbgTempVideo.play();

    bgBlurStream = bgBlurCanvas.captureStream(30);
    const bgTrack = bgBlurStream.getVideoTracks()[0];
    if (videoProducer) {
        videoProducer.replaceTrack({ track: bgTrack });
    }
    localVideo.srcObject = bgBlurStream;
}

function generateVbgThumbnails() {
    for (const [scene, drawFn] of Object.entries(VBG_SCENES)) {
        const el = document.getElementById('vbgPreview' + scene.charAt(0).toUpperCase() + scene.slice(1));
        if (!el) continue;
        const c = document.createElement('canvas');
        c.width = 80; c.height = 50;
        const ctx = c.getContext('2d');
        drawFn(ctx, 80, 50);
        el.appendChild(c);
    }
}

function openVirtualBgModal() {
    const modal = document.getElementById("vbgModal");
    modal.style.display = "flex";
    // Generate thumbnails on first open
    if (!modal._thumbsGenerated) {
        generateVbgThumbnails();
        modal._thumbsGenerated = true;
    }
    modal.querySelectorAll(".vbg-option").forEach(opt => {
        opt.classList.toggle("active", opt.dataset.bg === currentVbg);
    });
}

async function applyVirtualBg(bgValue) {
    currentVbg = bgValue;
    // Clean up existing
    if (bgBlurStream) {
        bgBlurStream.getTracks().forEach(t => t.stop());
        bgBlurStream = null;
    }
    bgBlurEnabled = false;
    vbgTempVideo = null;
    vbgSceneBg = null;
    vbgMode = null;
    vbgPrevMask = null; // Reset temporal buffer

    if (bgValue === "none") {
        const camTrack = localStream ? localStream.getVideoTracks()[0] : null;
        if (videoProducer && camTrack) {
            videoProducer.replaceTrack({ track: camTrack });
        }
        localVideo.srcObject = localStream;
        showToast("Background removed");
        return;
    }

    // Init segmentation model on first use
    await initSegmenter();

    if (bgValue === "blur") {
        startVbgPipeline('blur');
        showToast("Background blur on");
        return;
    }

    // Scene background
    if (bgValue.startsWith("scene:")) {
        const sceneKey = bgValue.split(":")[1];
        const drawFn = VBG_SCENES[sceneKey];
        if (!drawFn || !localStream) return;

        const sceneBg = document.createElement('canvas');
        sceneBg.width = 1920; sceneBg.height = 1080;
        drawFn(sceneBg.getContext('2d'), 1920, 1080);

        startVbgPipeline('scene', sceneBg);
        showToast("Virtual background applied");
        return;
    }
}

// ── File Sharing ────────────────────────────────────────────────────────

async function uploadFile(file) {
    if (!roomId) return;
    if (file.size > 50 * 1024 * 1024) {
        showToast("File too large (max 50 MB)");
        return;
    }
    const formData = new FormData();
    formData.append("room_id", roomId);
    formData.append("uploader", myName);
    formData.append("file", file);

    showToast(`Uploading ${file.name}...`);

    try {
        const resp = await fetch("/api/files/upload", { method: "POST", body: formData });
        const data = await resp.json();
        if (data.error) {
            showToast(data.error);
        } else {
            showToast(`"${data.name}" shared`);
        }
    } catch (e) {
        showToast("Upload failed");
    }
}

async function loadRoomFiles() {
    if (!roomId) return;
    try {
        const resp = await fetch(`/api/files/${roomId}`);
        const files = await resp.json();
        renderFilesList(files);
    } catch (e) {
        console.warn("Failed to load files:", e);
    }
}

function renderFilesList(files) {
    const list = document.getElementById("filesList");
    if (!files.length) {
        list.innerHTML = '<p class="files-empty">No files shared yet</p>';
        return;
    }
    list.innerHTML = files.map(f => `
        <div class="file-item" data-id="${f.id}">
            <div class="file-icon"><span class="material-icons-round">${getFileIcon(f.type)}</span></div>
            <div class="file-info">
                <div class="file-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>
                <div class="file-meta">${formatFileSize(f.size)} · ${escapeHtml(f.uploader)}</div>
            </div>
            <div class="file-actions">
                <a href="/api/files/${roomId}/${f.id}" download="${escapeHtml(f.name)}" class="file-action-btn" title="Download">
                    <span class="material-icons-round">download</span>
                </a>
                <button class="file-action-btn file-delete-btn" data-id="${f.id}" title="Delete">
                    <span class="material-icons-round">delete</span>
                </button>
            </div>
        </div>
    `).join("");

    list.querySelectorAll(".file-delete-btn").forEach(btn => {
        btn.addEventListener("click", async () => {
            const fid = btn.dataset.id;
            try {
                await fetch(`/api/files/${roomId}/${fid}`, { method: "DELETE" });
            } catch (e) {
                showToast("Delete failed");
            }
        });
    });
}

function onFileShared(file) {
    showToast(`${file.uploader} shared "${file.name}"`);
    // If files panel is open, refresh it
    if (document.getElementById("filesPanel").classList.contains("open")) {
        loadRoomFiles();
    }
}

function onFileDeleted(fileId) {
    const item = document.querySelector(`.file-item[data-id="${fileId}"]`);
    if (item) item.remove();
    // Check if list is empty
    const list = document.getElementById("filesList");
    if (!list.querySelector(".file-item")) {
        list.innerHTML = '<p class="files-empty">No files shared yet</p>';
    }
}

function getFileIcon(mimeType) {
    if (!mimeType) return "insert_drive_file";
    if (mimeType.startsWith("image/")) return "image";
    if (mimeType.startsWith("video/")) return "movie";
    if (mimeType.startsWith("audio/")) return "audio_file";
    if (mimeType.includes("pdf")) return "picture_as_pdf";
    if (mimeType.includes("spreadsheet") || mimeType.includes("excel") || mimeType.includes("csv")) return "table_chart";
    if (mimeType.includes("presentation") || mimeType.includes("powerpoint")) return "slideshow";
    if (mimeType.includes("document") || mimeType.includes("word") || mimeType.includes("text")) return "article";
    if (mimeType.includes("zip") || mimeType.includes("compressed") || mimeType.includes("archive")) return "folder_zip";
    return "insert_drive_file";
}

function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

// ── Keyboard Shortcuts ──────────────────────────────────────────────────
function setupKeyboardShortcuts() {
    document.addEventListener("keydown", (e) => {
        // Don't trigger if typing in input/textarea
        if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT") return;
        if (!callScreen.classList.contains("active")) return;

        switch (e.key.toLowerCase()) {
            case "m": toggleMic(); break;
            case "v": toggleCam(); break;
            case "s": toggleScreenShare(); break;
            case "h": toggleHandRaise(); break;
            case "c":
                chatOpen = !chatOpen;
                chatPanel.classList.toggle("open", chatOpen);
                chatBtn.classList.toggle("active", chatOpen);
                if (chatOpen) { closeSidePanels("chatPanel"); chatInput.focus(); }
                break;
            case "r": toggleRecording(); break;
            case "g": toggleViewMode(); break;
            case "f":
                if (!document.fullscreenElement) {
                    document.documentElement.requestFullscreen().catch(() => {});
                } else {
                    document.exitFullscreen().catch(() => {});
                }
                break;
            case "?": document.getElementById("shortcutsModal").style.display = "flex"; break;
            case "escape":
                // Close any open modal
                document.querySelectorAll(".modal-overlay").forEach(m => m.style.display = "none");
                break;
        }
    });
}
