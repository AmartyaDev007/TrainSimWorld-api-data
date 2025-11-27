const speedValueEl = document.getElementById("speedValue");
const accelValueEl = document.getElementById("accelValue");
const accelBadgeEl = document.getElementById("accelBadge");
const signalDotEl = document.getElementById("signalDot");
const signalTextEl = document.getElementById("signalText");
const speedLimitChipsEl = document.getElementById("speedLimitChips");
const stationNameEl = document.getElementById("stationName");
const stationDistanceEl = document.getElementById("stationDistance");
const gradientValueEl = document.getElementById("gradientValue");
const gradientTagEl = document.getElementById("gradientTag");
const rawGradientChipEl = document.getElementById("rawGradientChip");
const connectionStatusEl = document.getElementById("connectionStatus");
const statusTextEl = document.getElementById("statusText");
const lastUpdateEl = document.getElementById("lastUpdate");

function formatKm(distanceMeters) {
  if (distanceMeters == null) return "—";
  if (distanceMeters >= 1000) {
    return (distanceMeters / 1000).toFixed(2) + " km";
  }
  return Math.round(distanceMeters) + " m";
}

function updateConnectionStatus(connected) {
  const dot = connectionStatusEl.querySelector(".dot");
  if (connected) {
    dot.classList.add("ok");
    statusTextEl.textContent = "Live";
  } else {
    dot.classList.remove("ok");
    statusTextEl.textContent = "Connecting…";
  }
}

function updateAccel(accel) {
  const rounded = accel.toFixed(2);
  accelValueEl.textContent = `${rounded} m/s²`;

  accelBadgeEl.classList.remove("accel", "decel", "idle");

  if (accel > 0.05) {
    accelBadgeEl.textContent = "Accelerating";
    accelBadgeEl.classList.add("accel");
  } else if (accel < -0.05) {
    accelBadgeEl.textContent = "Braking";
    accelBadgeEl.classList.add("decel");
  } else {
    accelBadgeEl.textContent = "Idle";
    accelBadgeEl.classList.add("idle");
  }
}

function updateSignal(aspect, nextSignals) {
  let cls = "";
  let short = "?";
  let text = aspect || "Unknown";

  if (!aspect) {
    cls = "";
    short = "?";
  } else {
    const lower = aspect.toLowerCase();
    if (lower.includes("clear") || lower.includes("proceed")) {
      cls = "green";
      short = "G";
    } else if (lower.includes("approach") || lower.includes("caution") || lower.includes("yellow")) {
      cls = "yellow";
      short = "Y";
    } else if (lower.includes("stop") || lower.includes("danger") || lower.includes("red")) {
      cls = "red";
      short = "R";
    }
  }

  signalDotEl.className = "signal-circle " + cls;
  signalDotEl.textContent = short;
  signalTextEl.textContent = text;

  speedLimitChipsEl.innerHTML = "";

  if (Array.isArray(nextSignals) && nextSignals.length > 0) {
    nextSignals.slice(0, 3).forEach((s, idx) => {
      const chip = document.createElement("div");
      chip.className = "chip";
      chip.textContent = `S${idx + 1}: ${s.value || "?"} (${Math.round(s.distanceToNextSignal || 0)} m)`;
      speedLimitChipsEl.appendChild(chip);
    });
  }
}

function updateSpeedLimits(current, next, subsequent) {
  const base = speedLimitChipsEl;

  const makeChip = (label, value, cls) => {
    if (!value || value.value == null) return;
    const kmh = (value.value * 3.6).toFixed(0);
    const el = document.createElement("div");
    el.className = "chip " + (cls || "");
    el.textContent = `${label}: ${kmh} km/h`;
    base.appendChild(el);
  };

  makeChip("Now", current, "highlight");
  makeChip("Next", next, "warn");

  if (Array.isArray(subsequent) && subsequent.length > 0) {
    subsequent.slice(0, 2).forEach((lim, idx) => {
      if (!lim.value || lim.value.value == null) return;
      const kmh = (lim.value.value * 3.6).toFixed(0);
      const el = document.createElement("div");
      el.className = "chip";
      el.textContent = `+${idx + 2}: ${kmh} km/h`;
      base.appendChild(el);
    });
  }
}

function handleStatus(data) {
  const speed = data.speed_kph || 0;
  speedValueEl.textContent = speed.toFixed(0);

  updateAccel(data.accel_mps2 || 0);

  speedLimitChipsEl.innerHTML = "";
  updateSignal(data.next_signal_aspect, data.next_signals);
  updateSpeedLimits(data.speed_limit, data.next_speed_limit, data.next_speed_limits);

  stationNameEl.textContent = data.next_station_name || "—";
  stationDistanceEl.textContent = "Distance: " + formatKm(data.next_station_distance);

  const g = data.gradient_percent;
  if (g == null || isNaN(g)) {
    gradientValueEl.textContent = "—";
    gradientTagEl.textContent = "Unknown";
  } else {
    gradientValueEl.textContent = g.toFixed(1) + "%";
    gradientTagEl.textContent =
      g > 0.1 ? "Uphill" : g < -0.1 ? "Downhill" : "Level";
  }

  const rawG = data.gradient_raw;
  rawGradientChipEl.textContent = "HUD: " + (rawG == null ? "—" : rawG.toFixed(1) + "%");

  lastUpdateEl.textContent = "Last update: " + new Date().toLocaleTimeString();
}

function createSocket() {
  const wsUrl = `ws://${location.hostname}:8080`;
  const ws = new WebSocket(wsUrl);

  ws.onopen = () => updateConnectionStatus(true);
  ws.onclose = () => {
    updateConnectionStatus(false);
    setTimeout(createSocket, 1000);
  };
  ws.onerror = () => updateConnectionStatus(false);

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === "status") {
        handleStatus(msg.data);
      }
    } catch (e) {
      console.error("WS parse error", e);
    }
  };
}

createSocket();
