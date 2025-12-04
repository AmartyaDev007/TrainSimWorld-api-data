const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const WebSocket = require("ws");

const app = express();
app.use(cors());
app.use(express.static("public"));

// ============================================================================
// 1. Load newest CommAPIKey
// ============================================================================
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

    for (const folder of folders) {
        const keyFile = path.join(base, folder, "Saved", "Config", "CommAPIKey.txt");
        if (fs.existsSync(keyFile)) {
            COMM_KEY = fs.readFileSync(keyFile, "utf8").trim();
            console.log("CommAPIKey loaded from:", folder, "->", COMM_KEY);
            break;
        }
    }
} catch (err) {
    console.error("Failed to load CommAPIKey:", err);
    process.exit(1);
}

// ============================================================================
// 2. Axios wrapper
// ============================================================================
async function tsw(path, method = "GET") {
    const url = `http://127.0.0.1:31270${path}`;
    const res = await axios({
        url,
        method,
        timeout: 1200,
        headers: { DTGCommKey: COMM_KEY },
        validateStatus: () => true
    });

    if (res.status !== 200) throw new Error(`TSW ${res.status}: ${path}`);

    return res.data?.Values ?? res.data ?? {};
}

// ============================================================================
// 3. SUBSCRIPTIONS (FAST DATA) — WITH RETRIES
// ============================================================================
// ============================================================================
// SUBSCRIPTIONS — CORRECTED + RETRYING + PROPER PATH FORMAT
// ============================================================================
const SUB_ID = 1;

const subscriptionPaths = [
    "CurrentDrivableActor.Function.HUD_GetSpeed",
    "CurrentDrivableActor.Function.HUD_GetAcceleration",
    "CurrentDrivableActor.Function.HUD_GetPowerHandle",
    "CurrentDrivableActor.Function.HUD_GetElectricBrakeHandle",
    "CurrentDrivableActor.Function.HUD_GetTrainBrakeHandle",
    "CurrentDrivableActor.Function.HUD_GetLocomotiveBrakeHandle"
];

async function subscribeWithRetry(endpoint) {
    const subPath = `/subscription/${endpoint}?Subscription=${SUB_ID}`;

    while (true) {
        try {
            await tsw(subPath, "POST");

            const check = await tsw(`/subscription/?Subscription=${SUB_ID}`, "GET");
            const entries = check.Entries || [];

            let ok = entries.some(e =>
                e.Path?.toLowerCase() === endpoint.toLowerCase()
            );

            if (ok) {
                console.log("✔ SUBSCRIBED:", endpoint);
                return;
            }

        } catch (err) {
            console.log("❌ failed:", endpoint, err.toString());
        }

        await new Promise(r => setTimeout(r, 300));
    }
}

async function setupSubscription() {
    console.log("Setting up TSW subscription…");

    for (const ep of subscriptionPaths) {
        subscribeWithRetry(ep); // parallel retry loops
    }
}

async function readSubscription() {
    const data = await tsw(`/subscription/?Subscription=${SUB_ID}`, "GET");
    return data.Entries || [];
}

// ============================================================================
// 4. POLLING (HEAVY DATA)
// ============================================================================
let driverAidCache = null;
let trackDataCache = null;

async function pollDriverAid() {
    try {
        driverAidCache = await tsw("/get/DriverAid.Data");
    } catch {}
}

async function pollTrackData() {
    try {
        trackDataCache = await tsw("/get/DriverAid.TrackData");
    } catch {}
}

setInterval(pollDriverAid, 250);
setInterval(pollTrackData, 500);

// ============================================================================
// 5. Acceleration compute
// ============================================================================
let lastSpeed = null;
let lastTime = null;

function computeAccel(speed) {
    const now = Date.now();
    if (lastSpeed !== null && lastTime !== null) {
        let dt = (now - lastTime) / 1000;
        let a = dt > 0 ? (speed - lastSpeed) / dt : 0;
        lastSpeed = speed;
        lastTime = now;
        return a;
    }
    lastSpeed = speed;
    lastTime = now;
    return 0;
}

// ============================================================================
// 6. Merge snapshot for HUD
// ============================================================================
async function buildStatus() {
    const subEntries = await readSubscription();

    let speedMps = 0,
        power = 0,
        eBrake = 0,
        tBrake = 0,
        lBrake = 0;

    for (const e of subEntries) {
        const path = e.Path?.toLowerCase();
        const v = e.Values;

        if (!path || !v) continue;

        if (path.includes("speed")) {
            speedMps = v["Speed (ms)"] ?? v.value ?? 0;
        }
        if (path.includes("powerhandle")) {
            power = v.Power ?? v.value ?? 0;
        }
        if (path.includes("electricbrakehandle")) {
            eBrake = v.HandlePosition ?? 0;
        }
        if (path.includes("trainbrakehandle")) {
            tBrake = v.HandlePosition ?? 0;
        }
        if (path.includes("locomotivebrakehandle")) {
            lBrake = v.HandlePosition ?? 0;
        }
    }

    const accel = computeAccel(speedMps);

    // next station from TrackData
    let nextStationName = null;
    let nextStationDistance = null;
    let secondNextStationName = null;
    let secondNextStationDistance = null; 
    let thirdNextStationName = null; 
    let thirdNextStationDistance = null; 

    if (trackDataCache?.markers?.length > 0) {
        const st = trackDataCache.markers[0];
        nextStationName = st.stationName ?? null;
        nextStationDistance = Math.round(st.distanceToStationCM / 100);

        if (trackDataCache?.markers?.length > 1) { 
            const st2 = trackDataCache.markers[1];
            secondNextStationName = st2.stationName ?? null; 
            secondNextStationDistance = Math.round(st2.distanceToStationCM / 100);
        }

        if (trackDataCache?.markers?.length > 2) { 
            const st3 = trackDataCache.markers[2];
            thirdNextStationName = st3.stationName ?? null; 
            thirdNextStationDistance = Math.round(st3.distanceToStationCM / 100);
        }
    }

    return {
        speed_mps: speedMps,
        speed_kph: speedMps * 3.6,
        accel_mps2: accel,

        distance_to_signal: driverAidCache?.distanceToSignal ?? null,
        gradient_raw: driverAidCache?.gradient ?? null,
        next_signal_aspect: driverAidCache?.signalAspectClass ?? null,

        speed_limit: driverAidCache?.speedLimit ?? null,
        next_speed_limit: driverAidCache?.nextSpeedLimit ?? null,
        next_speed_limits: driverAidCache?.nextSpeedLimits ?? [],

        next_signals: driverAidCache?.nextSignals ?? [],     //  ← ADD THIS BACK

        next_station_name: nextStationName,
        next_station_distance: nextStationDistance,

        second_Next_Station_Name: secondNextStationName,
        second_Next_Station_Distance: secondNextStationDistance,

        third_Next_Station_Name: thirdNextStationName,
        third_Next_Station_Distance: thirdNextStationDistance,


        power_pct: Math.round(power * 10),
        electric_brake_pct: Math.round(eBrake * 100),
        train_brake_pct: Math.round(tBrake * 100),
        loco_brake_pct: Math.round(lBrake * 100)
    };
}

// ============================================================================
// 7. HTTP: /status
// ============================================================================
app.get("/status", async (req, res) => {
    try {
        res.json(await buildStatus());
    } catch (err) {
        res.status(500).json({ error: err.toString() });
    }
});

// ============================================================================
// 8. Serve HUD
// ============================================================================
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "hud.html"));
});

// ============================================================================
// 9. WebSocket push
// ============================================================================
const PORT = 8080;
const server = app.listen(PORT, () => {
    console.log("Bridge running at http://localhost:" + PORT);
    setupSubscription();
});

const wss = new WebSocket.Server({ server });

setInterval(async () => {
    if (wss.clients.size === 0) return;

    try {
        const snap = await buildStatus();
        const msg = JSON.stringify({ type: "status", data: snap });

        wss.clients.forEach(c => {
            if (c.readyState === WebSocket.OPEN) c.send(msg);
        });
    } catch {}
}, 150);   // SUPER smooth updates (~7 FPS)
