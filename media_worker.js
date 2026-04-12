/**
 * Huddle Media Worker — mediasoup SFU
 * Runs as a Node.js subprocess, communicates with the Python signaling server
 * via an internal HTTP API on port 3000.
 */

const mediasoup = require("mediasoup");
const express = require("express");

const app = express();
app.use(express.json());

// ── Config ───────────────────────────────────────────────────────────────
const MEDIA_PORT = parseInt(process.env.MEDIA_WORKER_PORT || "3000");
const RTC_MIN_PORT = parseInt(process.env.RTC_MIN_PORT || "10000");
const RTC_MAX_PORT = parseInt(process.env.RTC_MAX_PORT || "10100");

// Auto-detect public IP for Render / cloud deployments
async function getAnnouncedIp() {
  const envIp = process.env.ANNOUNCED_IP;
  if (envIp && envIp !== "0.0.0.0") return envIp;
  try {
    const res = await fetch("https://api.ipify.org?format=json");
    const data = await res.json();
    console.log(`[ms] Auto-detected public IP: ${data.ip}`);
    return data.ip;
  } catch (e) {
    console.warn("[ms] Could not detect public IP, using 0.0.0.0");
    return "0.0.0.0";
  }
}

let ANNOUNCED_IP = process.env.ANNOUNCED_IP || "0.0.0.0";

const mediaCodecs = [
  {
    kind: "audio",
    mimeType: "audio/opus",
    clockRate: 48000,
    channels: 2,
  },
  {
    kind: "video",
    mimeType: "video/VP8",
    clockRate: 90000,
    parameters: { "x-google-start-bitrate": 1000 },
  },
  {
    kind: "video",
    mimeType: "video/VP9",
    clockRate: 90000,
    parameters: {
      "profile-id": 2,
      "x-google-start-bitrate": 1000,
    },
  },
  {
    kind: "video",
    mimeType: "video/H264",
    clockRate: 90000,
    parameters: {
      "packetization-mode": 1,
      "profile-level-id": "42e01f",
      "level-asymmetry-allowed": 1,
      "x-google-start-bitrate": 1000,
    },
  },
];

const webRtcTransportOptions = {
  listenIps: [{ ip: "0.0.0.0", announcedIp: ANNOUNCED_IP }],
  enableUdp: true,
  enableTcp: true,
  preferUdp: true,
  initialAvailableOutgoingBitrate: 1000000,
};

// ── State ────────────────────────────────────────────────────────────────
let worker = null;
// rooms: { roomId: { router, peers: { peerId: { transports: {}, producers: {}, consumers: {} } } } }
const rooms = {};

// ── Worker Setup ─────────────────────────────────────────────────────────
async function createWorker() {
  // Resolve public IP before creating transports
  ANNOUNCED_IP = await getAnnouncedIp();
  webRtcTransportOptions.listenIps = [{ ip: "0.0.0.0", announcedIp: ANNOUNCED_IP }];

  worker = await mediasoup.createWorker({
    rtcMinPort: RTC_MIN_PORT,
    rtcMaxPort: RTC_MAX_PORT,
    logLevel: "warn",
  });
  worker.on("died", () => {
    console.error("mediasoup worker died, exiting...");
    process.exit(1);
  });
  console.log(`mediasoup worker created (pid: ${worker.pid})`);
  return worker;
}

async function getOrCreateRoom(roomId) {
  if (rooms[roomId]) return rooms[roomId];
  const router = await worker.createRouter({ mediaCodecs });
  rooms[roomId] = { router, peers: {} };
  console.log(`Room ${roomId} created`);
  return rooms[roomId];
}

function getOrCreatePeer(room, peerId) {
  if (!room.peers[peerId]) {
    room.peers[peerId] = { transports: {}, producers: {}, consumers: {} };
  }
  return room.peers[peerId];
}

// ── API Routes ───────────────────────────────────────────────────────────

// Health check
app.get("/health", (req, res) => {
  res.json({ ok: true, rooms: Object.keys(rooms).length });
});

// Get router RTP capabilities for a room
app.post("/api/router-rtp-capabilities", async (req, res) => {
  try {
    const { roomId } = req.body;
    const room = await getOrCreateRoom(roomId);
    res.json({ rtpCapabilities: room.router.rtpCapabilities });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create a WebRTC transport (send or receive)
app.post("/api/create-transport", async (req, res) => {
  try {
    const { roomId, peerId, direction } = req.body; // direction: "send" or "recv"
    const room = await getOrCreateRoom(roomId);
    const peer = getOrCreatePeer(room, peerId);

    const transport = await room.router.createWebRtcTransport(webRtcTransportOptions);

    transport.on("dtlsstatechange", (state) => {
      if (state === "closed") {
        transport.close();
      }
    });

    peer.transports[transport.id] = transport;

    res.json({
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Connect a transport
app.post("/api/connect-transport", async (req, res) => {
  try {
    const { roomId, peerId, transportId, dtlsParameters } = req.body;
    const room = rooms[roomId];
    if (!room) return res.status(404).json({ error: "Room not found" });
    const peer = room.peers[peerId];
    if (!peer) return res.status(404).json({ error: "Peer not found" });
    const transport = peer.transports[transportId];
    if (!transport) return res.status(404).json({ error: "Transport not found" });

    await transport.connect({ dtlsParameters });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Produce (send media to SFU)
app.post("/api/produce", async (req, res) => {
  try {
    const { roomId, peerId, transportId, kind, rtpParameters, appData } = req.body;
    const room = rooms[roomId];
    if (!room) return res.status(404).json({ error: "Room not found" });
    const peer = room.peers[peerId];
    if (!peer) return res.status(404).json({ error: "Peer not found" });
    const transport = peer.transports[transportId];
    if (!transport) return res.status(404).json({ error: "Transport not found" });

    const producer = await transport.produce({ kind, rtpParameters, appData });
    peer.producers[producer.id] = producer;

    producer.on("transportclose", () => {
      producer.close();
      delete peer.producers[producer.id];
    });

    res.json({ producerId: producer.id, appData: producer.appData || {} });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Consume (receive media from SFU)
app.post("/api/consume", async (req, res) => {
  try {
    const { roomId, peerId, producerId, rtpCapabilities } = req.body;
    const room = rooms[roomId];
    if (!room) return res.status(404).json({ error: "Room not found" });
    const peer = room.peers[peerId];
    if (!peer) return res.status(404).json({ error: "Peer not found" });

    if (!room.router.canConsume({ producerId, rtpCapabilities })) {
      return res.status(400).json({ error: "Cannot consume" });
    }

    // Find the recv transport
    const transport = Object.values(peer.transports).find(
      (t) => t.appData && t.appData.direction === "recv"
    ) || Object.values(peer.transports)[1] || Object.values(peer.transports)[0];

    if (!transport) return res.status(404).json({ error: "No recv transport" });

    const consumer = await transport.consume({
      producerId,
      rtpCapabilities,
      paused: false,
    });

    peer.consumers[consumer.id] = consumer;

    consumer.on("transportclose", () => {
      consumer.close();
      delete peer.consumers[consumer.id];
    });

    consumer.on("producerclose", () => {
      consumer.close();
      delete peer.consumers[consumer.id];
    });

    // Look up the producer's appData to pass back to consumer
    let producerAppData = {};
    for (const [pid, p] of Object.entries(room.peers)) {
      if (p.producers[producerId]) {
        producerAppData = p.producers[producerId].appData || {};
        break;
      }
    }

    res.json({
      consumerId: consumer.id,
      producerId,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
      appData: producerAppData,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Resume a consumer
app.post("/api/resume-consumer", async (req, res) => {
  try {
    const { roomId, peerId, consumerId } = req.body;
    const room = rooms[roomId];
    if (!room) return res.status(404).json({ error: "Room not found" });
    const peer = room.peers[peerId];
    if (!peer) return res.status(404).json({ error: "Peer not found" });
    const consumer = peer.consumers[consumerId];
    if (!consumer) return res.status(404).json({ error: "Consumer not found" });

    await consumer.resume();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get all producers in a room (for new peer to consume)
app.post("/api/room-producers", async (req, res) => {
  try {
    const { roomId, excludePeerId } = req.body;
    const room = rooms[roomId];
    if (!room) return res.json({ producers: [] });

    const producers = [];
    for (const [pid, peer] of Object.entries(room.peers)) {
      if (pid === excludePeerId) continue;
      for (const [prodId, producer] of Object.entries(peer.producers)) {
        producers.push({
          producerId: prodId,
          peerId: pid,
          kind: producer.kind,
          appData: producer.appData || {},
        });
      }
    }
    res.json({ producers });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Close a producer (stop sending a track)
app.post("/api/close-producer", async (req, res) => {
  try {
    const { roomId, peerId, producerId } = req.body;
    const room = rooms[roomId];
    if (!room) return res.json({ ok: true });
    const peer = room.peers[peerId];
    if (!peer) return res.json({ ok: true });
    const producer = peer.producers[producerId];
    if (producer) {
      producer.close();
      delete peer.producers[producerId];
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Pause/resume a producer
app.post("/api/pause-producer", async (req, res) => {
  try {
    const { roomId, peerId, producerId, paused } = req.body;
    const room = rooms[roomId];
    if (!room) return res.json({ ok: true });
    const peer = room.peers[peerId];
    if (!peer) return res.json({ ok: true });
    const producer = peer.producers[producerId];
    if (producer) {
      if (paused) await producer.pause();
      else await producer.resume();
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Remove peer from room
app.post("/api/remove-peer", async (req, res) => {
  try {
    const { roomId, peerId } = req.body;
    const room = rooms[roomId];
    if (!room || !room.peers[peerId]) return res.json({ ok: true });

    const peer = room.peers[peerId];
    // Close all transports (which closes producers/consumers)
    for (const transport of Object.values(peer.transports)) {
      transport.close();
    }
    delete room.peers[peerId];

    // Clean up empty rooms
    if (Object.keys(room.peers).length === 0) {
      room.router.close();
      delete rooms[roomId];
      console.log(`Room ${roomId} closed (empty)`);
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Start ────────────────────────────────────────────────────────────────
(async () => {
  await createWorker();
  app.listen(MEDIA_PORT, () => {
    console.log(`mediasoup media worker API listening on port ${MEDIA_PORT}`);
  });
})();
