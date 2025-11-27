const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const WebSocket = require("ws");

const app = express();
app.use(cors());
app.use(express.static("public"));
// ---------------------------------------------
// Load CommAPIKey from newest TrainSimWorld folder
// ---------------------------------------------
const base = path.join(process.env.HOME || process.env.USERPROFILE, "Documents", "My Games");
let COMM_KEY = "";

try {
  const folders = fs.readdirSync(base)
    .filter(f => f.startsWith("TrainSimWorld"))
    .sort((a, b) => {
      const numA = parseInt(a.replace(/\D/g, "")) || 0;
      const numB = parseInt(b.replace(/\D/g, "")) || 0;
      return numB - numA;
    });

  let foundKey = false;

  for (const folder of folders) {
    const keyPath = path.join(base, folder, "Saved", "Config", "CommAPIKey.txt");
    if (fs.existsSync(keyPath)) {
      COMM_KEY = fs.readFileSync(keyPath, "utf8").trim();
      console.log("CommAPIKey loaded from:", folder, "->", COMM_KEY);
      foundKey = true;
      break;
    }
  }

  if (!foundKey) {
    throw new Error("No CommAPIKey.txt found in ANY TrainSimWorld folder.");
  }
} catch (err) {
  console.error("CommAPIKey load failed:", err);
  process.exit(1);
}

// ---------------------------------------------
// axios wrapper for TSW API
// ---------------------------------------------
async function tsw(apiPath, method = "GET") {
  const url = `http://127.0.0.1:31270${apiPath}`;

  const res = await axios({
    url,
    method,
    timeout: 1500,
    headers: {
      "DTGCommKey": COMM_KEY
    },
    validateStatus: () => true
  });

  if (res.status !== 200) {
    throw new Error(`TSW returned ${res.status}`);
  }

  // Most endpoints wrap data in .Values, but some might not
  return res.data?.Values ?? res.data ?? {};
}

// ---------------------------------------------
// Acceleration tracking (m/s²)
// ---------------------------------------------
let lastSpeedMps = null;
let lastSampleTimeMs = null;

function computeAcceleration(currentSpeedMps) {
  const now = Date.now();
  let accel = 0;

  if (lastSpeedMps !== null && lastSampleTimeMs !== null) {
    const dt = (now - lastSampleTimeMs) / 1000; // seconds
    if (dt > 0) {
      accel = (currentSpeedMps - lastSpeedMps) / dt;
    }
  }

  lastSpeedMps = currentSpeedMps;
  lastSampleTimeMs = now;

  return accel;
}

// ---------------------------------------------
// Build one status snapshot (used by HTTP + WS)
// ---------------------------------------------
async function buildStatusSnapshot() {
  // 1. Speed
  const speed = await tsw(`/get/CurrentDrivableActor.Function.HUD_GetSpeed`);

  // 2. DriverAid data (signals, limits, gradient, maybe station info)
  const driverAid = await tsw(`/get/DriverAid.Data`);

  // 3. Track data (for gradient calc)
  const track = await tsw(`/get/DriverAid.TrackData`);

  const speedMps = speed["Speed (ms)"] ?? speed.return ?? speed.value ?? 0;
  const speedKph = speedMps * 3.6;
  const accelMps2 = computeAcceleration(speedMps);

  // Gradient from trackHeights
  let gradient = null;
  if (track.trackHeights && track.trackHeights.length >= 2) {
    const h1 = track.trackHeights[0];
    const h2 = track.trackHeights[1];
    const dh = h2.height - h1.height;
    const dx = h2.distanceToHeight - h1.distanceToHeight;
    if (dx !== 0) {
      gradient = (dh / dx) * 100;
    }
  }

  // ---------------------------------------------
  // Station Logic
  // ---------------------------------------------
  let nextStationName = null;
  let nextStationDistance = null;

  // We need player's current distance along the track
  const playerDist = track.lastPlayerPosition?.distanceToHeight ?? 0;

  if (track.stations && Array.isArray(track.stations)) {
    // Filter for stations ahead of the player
    // Assuming distanceToStationCM is the linear distance along track
    // and matches the units of playerDist (or close enough to be comparable)
    const stationsAhead = track.stations
      .filter(st => st.distanceToStationCM > playerDist)
      .sort((a, b) => a.distanceToStationCM - b.distanceToStationCM);

    if (stationsAhead.length > 0) {
      const nextSt = stationsAhead[0];
      nextStationName = nextSt.stationName;
      // Calculate relative distance
      nextStationDistance = nextSt.distanceToStationCM - playerDist;
    }
  }

  // Fallback to DriverAid if track logic failed (though user said it wasn't working there)
  if (!nextStationName) {
    nextStationName =
      driverAid.nextStationName ??
      driverAid.nextStopName ??
      driverAid.nextStation ??
      null;
  }

  if (nextStationDistance === null) {
    nextStationDistance =
      driverAid.distanceToNextStation ??
      driverAid.distanceToNextStop ??
      null;
  }

  // Signals array field name varies: nextSignals / nextsignals etc.
  const nextSignals =
    driverAid.nextSignals ??
    driverAid.NextSignals ??
    null;

  return {
    speed_mps: speedMps,
    speed_kph: speedKph,

    accel_mps2: accelMps2,

    distance_to_signal: driverAid.distanceToSignal ?? null,
    distance_to_next_speedlimit: driverAid.distanceToNextSpeedLimit ?? null,
    gradient_raw: driverAid.gradient ?? null,

    speed_limit: driverAid.speedLimit ?? null,
    next_speed_limit: driverAid.nextSpeedLimit ?? null,
    next_speed_limits: driverAid.nextSpeedLimits ?? null,

    next_signal_aspect: driverAid.signalAspectClass ?? null,
    next_signals: nextSignals,

    next_station_name: nextStationName,
    next_station_distance: nextStationDistance,

    gradient_percent: gradient,
    uphill: gradient > 0,
    downhill: gradient < 0
  };
}

// ---------------------------------------------
// HTTP: /status → JSON snapshot
// ---------------------------------------------
app.get("/status", async (req, res) => {
  try {
    const data = await buildStatusSnapshot();
    res.json(data);
  } catch (err) {
    console.error("STATUS ERROR:", err);
    res.status(500).json({ error: err.toString() });
  }
});

// ---------------------------------------------
// Serve HUD HTML on /
// ---------------------------------------------
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "hud.html"));
});

// ---------------------------------------------
// Start HTTP + WebSocket servers
// ---------------------------------------------
const PORT = 8080;
const server = app.listen(PORT, () => {
  console.log("Bridge server running on http://localhost:" + PORT);
});

const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  console.log("WebSocket client connected");

  ws.on("close", () => {
    console.log("WebSocket client disconnected");
  });
});

// Push updates to all ws clients ~4 times per second
setInterval(async () => {
  if (wss.clients.size === 0) return;

  try {
    const snapshot = await buildStatusSnapshot();
    const message = JSON.stringify({ type: "status", data: snapshot });

    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  } catch (err) {
    console.error("WS broadcast error:", err.toString());
  }
}, 250);
