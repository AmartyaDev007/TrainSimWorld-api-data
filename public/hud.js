const speedValueEl = document.getElementById("speedValue");
const accelValueEl = document.getElementById("accelValue");
const accelBadgeEl = document.getElementById("accelBadge");
const signalDotEl = document.getElementById("signalDot");
const signalTextEl = document.getElementById("signalText");
const speedLimitChipsEl = document.getElementById("speedLimitChips");
const stationNameEl = document.getElementById("stationName");
const stationDistanceEl = document.getElementById("stationDistance");
const gradientValueEl = document.getElementById("gradientValue");
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
      chip.textContent = `S${idx + 1}: ${s.value || "?"} (${Math.round((s.distanceToNextSignal || 0) / 100)} m)`;
      speedLimitChipsEl.appendChild(chip);
    });
  }
}

function updateSpeedLimits(current, next, nextSpeedLimits) {
  const base = speedLimitChipsEl;

  const makeChip = (label, speedValue, distance, cls) => {
    if (speedValue == null) return;
    const kmh = (speedValue * 3.6).toFixed(0);
    const el = document.createElement("div");
    el.className = "chip " + (cls || "");

    if (distance != null) {
      const meters = Math.round(distance / 100);
      el.textContent = `${label}: ${kmh} km/h (${meters} m)`;
    } else {
      el.textContent = `${label}: ${kmh} km/h`;
    }

    base.appendChild(el);
  };

  // Now - current speed limit (no distance)
  makeChip("Now", current?.value, null, "highlight");

  // Use first 3 elements from nextSpeedLimits array
  if (Array.isArray(nextSpeedLimits) && nextSpeedLimits.length > 0) {
    // Next - from nextSpeedLimits[0]
    makeChip("Next", nextSpeedLimits[0]?.value?.value, nextSpeedLimits[0]?.distanceToNextSpeedLimit, "warn");

    // +2 - from nextSpeedLimits[1]
    if (nextSpeedLimits.length > 1) {
      makeChip("+2", nextSpeedLimits[1]?.value?.value, nextSpeedLimits[1]?.distanceToNextSpeedLimit, "");
    }

    // +3 - from nextSpeedLimits[2]
    if (nextSpeedLimits.length > 2) {
      makeChip("+3", nextSpeedLimits[2]?.value?.value, nextSpeedLimits[2]?.distanceToNextSpeedLimit, "");
    }
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

  const rawG = data.gradient_raw;
  if (rawG == null) {
    gradientValueEl.textContent = "—";
  } else {
    gradientValueEl.textContent = rawG.toFixed(1) + "%";
  }

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
