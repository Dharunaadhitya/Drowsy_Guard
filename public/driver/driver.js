/**
 * DrowsyGuard Fleet — Driver Station In-Cab Client Controller
 * Wires untouched edge detection engines, in-cab kiosk UI, trip telemetry batching, and WebSockets.
 */

'use strict';

import { VideoSource } from '/js/videoSource.js';
import { FaceDetector } from '/js/faceDetector.js';
import { FatigueEngine } from '/js/fatigueEngine.js';
import { AlertEngine } from '/js/alertEngine.js';
import { loadAppConfig } from '/js/config.js';

// ── State ──────────────────────────────────────────────────────────────────
let currentDriver = null;
let driverToken = localStorage.getItem('drowsyguard_driver_token');
let currentTrip = null;
let isTripRunning = false;
let animFrameId = null;
let tripTimerInterval = null;
let tripStartTime = null;
let heartbeatInterval = null;
let ws = null;

// Telemetry batch queue
let eventQueue = [];
let batchFlushInterval = null;

// Instances
const videoSource = new VideoSource();
const faceDetector = new FaceDetector();
const fatigueEngine = new FatigueEngine();
const alertEngine = new AlertEngine();

// DOM References
const screenLogin = document.getElementById('screenLogin');
const screenPreTrip = document.getElementById('screenPreTrip');
const screenActiveTrip = document.getElementById('screenActiveTrip');

// Login Elements
const loginEmpId = document.getElementById('loginEmpId');
const pinDisplay = document.getElementById('pinDisplay');
let currentPin = '';

// Pre-Trip Elements
const preTripName = document.getElementById('preTripName');
const preTripDetails = document.getElementById('preTripDetails');
const preTripAvatar = document.getElementById('preTripAvatar');
const preTripCalibInfo = document.getElementById('preTripCalibInfo');
const preTripCameraSelect = document.getElementById('preTripCameraSelect');
const preTripStreamUrl = document.getElementById('preTripStreamUrl');
const esp32UrlGroup = document.getElementById('esp32UrlGroup');
const connectStreamBtn = document.getElementById('connectStreamBtn');
const hudStreamUrlInput = document.getElementById('hudStreamUrlInput');
const hudConnectBtn = document.getElementById('hudConnectBtn');

// Active Trip Elements
const kioskVideo = document.getElementById('kioskVideo');
const kioskEsp32 = document.getElementById('kioskEsp32');
const kioskCanvas = document.getElementById('kioskCanvas');
const ctx = kioskCanvas.getContext('2d');
const kioskVideoWrapper = document.getElementById('kioskVideoWrapper');
const kioskFaceBadge = document.getElementById('kioskFaceBadge');
const kioskSourceLabel = document.getElementById('kioskSourceLabel');
const hudStatusChip = document.getElementById('hudStatusChip');
const hudTripTimer = document.getElementById('hudTripTimer');
const hudSwitchCameraBtn = document.getElementById('hudSwitchCameraBtn');
const hudSnapshotBtn = document.getElementById('hudSnapshotBtn');
const kioskAlertBanner = document.getElementById('kioskAlertBanner');
const kioskAlertMessage = document.getElementById('kioskAlertMessage');
const microsleepOverlay = document.getElementById('microsleepOverlay');
const tripSummaryModal = document.getElementById('tripSummaryModal');

// Metric Value Elements
const kioskPerclosVal = document.getElementById('kioskPerclosVal');
const kioskPerclosArc = document.getElementById('kioskPerclosArc');
const kioskEarVal = document.getElementById('kioskEarVal');
const kioskEarState = document.getElementById('kioskEarState');
const kioskMarVal = document.getElementById('kioskMarVal');
const kioskYawnCount = document.getElementById('kioskYawnCount');
const kioskBlinkVal = document.getElementById('kioskBlinkVal');
const kioskTiltVal = document.getElementById('kioskTiltVal');

const tripWarningCount = document.getElementById('tripWarningCount');
const tripDangerCount = document.getElementById('tripDangerCount');
const tripMicrosleepCount = document.getElementById('tripMicrosleepCount');

let counts = { warnings: 0, dangers: 0, microsleeps: 0 };

// Arc Gauge Constants
const PERCLOS_R = 54;
const PERCLOS_CIRCUMFERENCE = 2 * Math.PI * PERCLOS_R;
if (kioskPerclosArc) {
  kioskPerclosArc.style.strokeDasharray = PERCLOS_CIRCUMFERENCE;
  kioskPerclosArc.style.strokeDashoffset = PERCLOS_CIRCUMFERENCE;
}

// ── Screen Navigation ──────────────────────────────────────────────────────
function showScreen(screen) {
  screenLogin.classList.remove('active');
  screenPreTrip.classList.remove('active');
  screenActiveTrip.classList.remove('active');
  screen.classList.add('active');
}

// ── Toast Notification ─────────────────────────────────────────────────────
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

// ── Keypad Input ───────────────────────────────────────────────────────────
document.querySelectorAll('.keypad-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const key = btn.getAttribute('data-key');
    if (key === 'clear') {
      currentPin = '';
    } else if (key === 'backspace') {
      currentPin = currentPin.slice(0, -1);
    } else if (currentPin.length < 6) {
      currentPin += key;
    }
    pinDisplay.textContent = currentPin ? '•'.repeat(currentPin.length) : '····';
  });
});

document.querySelectorAll('.recent-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    loginEmpId.value = chip.getAttribute('data-id');
    currentPin = chip.getAttribute('data-pin');
    pinDisplay.textContent = '•'.repeat(currentPin.length);
  });
});

// ── Driver Login Action ───────────────────────────────────────────────────
document.getElementById('startShiftBtn').addEventListener('click', async () => {
  const employee_id = loginEmpId.value.trim().toUpperCase();
  const pin = currentPin;

  if (!employee_id || !pin) {
    showToast('Enter Employee ID and 4-digit PIN', 'error');
    return;
  }

  try {
    const res = await fetch('/api/auth/driver-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employee_id, pin })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Authentication failed');

    driverToken = data.token;
    currentDriver = data.driver;
    localStorage.setItem('drowsyguard_driver_token', driverToken);
    localStorage.setItem('drowsyguard_driver_profile', JSON.stringify(currentDriver));

    setupPreTripScreen();
  } catch (err) {
    showToast(err.message, 'error');
    currentPin = '';
    pinDisplay.textContent = '····';
  }
});

function setupPreTripScreen() {
  preTripName.textContent = currentDriver.name;
  preTripDetails.textContent = `${currentDriver.employeeId} · ${currentDriver.vehicle}`;
  preTripAvatar.textContent = currentDriver.name.split(' ').map(n=>n[0]).join('');

  if (currentDriver.baselineEar) {
    preTripCalibInfo.textContent = `Saved Calibration Active (Baseline EAR: ${currentDriver.baselineEar.toFixed(3)})`;
    fatigueEngine.calibrationEAR = currentDriver.baselineEar;
    fatigueEngine.calibrated = true;
  } else {
    preTripCalibInfo.textContent = 'Standard Calibration Active (Baseline EAR: 0.310)';
    fatigueEngine.calibrationEAR = 0.31;
    fatigueEngine.calibrated = true;
  }

  showScreen(screenPreTrip);
}

document.getElementById('preTripLogoutBtn').addEventListener('click', () => {
  driverToken = null;
  currentDriver = null;
  localStorage.removeItem('drowsyguard_driver_token');
  currentPin = '';
  pinDisplay.textContent = '····';
  showScreen(screenLogin);
});

// Pre-load centralized or dynamically stored configuration
const savedStreamUrl = localStorage.getItem('drowsyguard_stream_url');
if (savedStreamUrl) {
  if (preTripStreamUrl) preTripStreamUrl.value = savedStreamUrl;
  if (hudStreamUrlInput) hudStreamUrlInput.value = savedStreamUrl;
  videoSource.setEsp32Url(savedStreamUrl);
} else {
  loadAppConfig().then(cfg => {
    if (preTripStreamUrl && cfg && (cfg.proxyStreamUrl || cfg.esp32StreamUrl)) {
      const defaultUrl = cfg.proxyStreamUrl || cfg.esp32StreamUrl;
      preTripStreamUrl.value = defaultUrl;
      if (hudStreamUrlInput) hudStreamUrlInput.value = defaultUrl;
    }
  }).catch(() => {});
}

// ── Dynamic Stream URL Connection Handler ──────────────────────────────────
async function handleConnectStream(url) {
  if (!url || !url.trim()) {
    showToast('Please enter an ESP32 stream link', 'warning');
    return;
  }
  url = url.trim();

  // Mixed-content security warning (Render HTTPS app requesting HTTP stream)
  if (window.location.protocol === 'https:' && url.startsWith('http://')) {
    showToast('⚠️ Mixed-content warning: HTTPS pages block plain HTTP streams. Please use an HTTPS Ngrok tunnel link.', 'warning');
  }

  // Persist URL so driver stations remember the link
  localStorage.setItem('drowsyguard_stream_url', url);

  // Synchronize inputs across both Pre-Trip and Active HUD
  if (preTripStreamUrl) preTripStreamUrl.value = url;
  if (hudStreamUrlInput) hudStreamUrlInput.value = url;

  if (preTripCameraStatus) {
    preTripCameraStatus.textContent = 'Connecting…';
    preTripCameraStatus.className = 'status-chip warning';
  }

  try {
    await videoSource.connectDynamicStream(url);
    applyCanvasMirror('esp32');
    if (kioskSourceLabel) kioskSourceLabel.textContent = 'ESP32-CAM';
    showToast(`Connected to stream: ${url.slice(0, 35)}…`, 'info');
  } catch (err) {
    showToast('Failed to connect to stream: ' + err.message, 'error');
  }
}

if (connectStreamBtn) {
  connectStreamBtn.addEventListener('click', () => {
    const url = preTripStreamUrl ? preTripStreamUrl.value : '';
    handleConnectStream(url);
  });
}
if (preTripStreamUrl) {
  preTripStreamUrl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleConnectStream(preTripStreamUrl.value);
    }
  });
}

if (hudConnectBtn) {
  hudConnectBtn.addEventListener('click', () => {
    const url = hudStreamUrlInput ? hudStreamUrlInput.value : '';
    handleConnectStream(url);
  });
}
if (hudStreamUrlInput) {
  hudStreamUrlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleConnectStream(hudStreamUrlInput.value);
    }
  });
}

// Update UI chips when VideoSource connection status changes
videoSource.onStatusChange = (status) => {
  console.log('[VideoSource Status]:', status);
  if (preTripCameraStatus) {
    if (status.includes('Connected ✓')) {
      preTripCameraStatus.textContent = 'ESP32 Linked ✓';
      preTripCameraStatus.className = 'status-chip safe';
    } else if (status.includes('Connecting')) {
      preTripCameraStatus.textContent = 'Connecting…';
      preTripCameraStatus.className = 'status-chip warning';
    } else if (status.includes('failed') || status.includes('error')) {
      preTripCameraStatus.textContent = 'Stream Offline ✗';
      preTripCameraStatus.className = 'status-chip offline';
    }
  }
};

// ── Camera Selection & Mirror Helper ──────────────────────────────────────
function applyCanvasMirror(mode = (preTripCameraSelect ? preTripCameraSelect.value : videoSource.mode)) {
  if (mode === 'esp32') {
    kioskCanvas.style.transform = 'none';
  } else {
    kioskCanvas.style.transform = 'scaleX(-1)';
  }
}

if (preTripCameraSelect) {
  preTripCameraSelect.addEventListener('change', () => {
    const isEsp = preTripCameraSelect.value === 'esp32';
    if (esp32UrlGroup) esp32UrlGroup.style.display = isEsp ? 'block' : 'none';
    if (kioskSourceLabel) kioskSourceLabel.textContent = isEsp ? 'ESP32-CAM' : 'WEBCAM';
  });
}

if (hudSwitchCameraBtn) {
  hudSwitchCameraBtn.addEventListener('click', async () => {
    const newMode = videoSource.mode === 'webcam' ? 'esp32' : 'webcam';
    try {
      await videoSource.switchMode(newMode);
      applyCanvasMirror(newMode);
      if (kioskSourceLabel) kioskSourceLabel.textContent = newMode === 'webcam' ? 'WEBCAM' : 'ESP32-CAM';
      showToast(`Switched camera to ${newMode === 'webcam' ? 'Webcam' : 'ESP32-CAM'}`, 'info');
    } catch (err) {
      showToast('Camera switch failed: ' + err.message, 'error');
    }
  });
}

// Global Snapshot Capture
async function captureIncidentSnapshot(triggerType = 'manual') {
  const empId = (currentDriver && (currentDriver.empId || currentDriver.employee_id)) || 'DRV-101';
  const isEsp32 = videoSource.mode === 'esp32';
  const activeEl = videoSource.getActiveElement();
  const hasVideo = !isEsp32 && kioskVideo && kioskVideo.videoWidth > 0;
  const hasImg = isEsp32 && kioskEsp32 && (kioskEsp32.naturalWidth > 0 || videoSource.isReady());

  if (hasVideo || hasImg) {
    try {
      const snapCanvas = document.createElement('canvas');
      const dims = videoSource.getSourceDimensions();
      snapCanvas.width = dims.width || 640;
      snapCanvas.height = dims.height || 480;
      const sCtx = snapCanvas.getContext('2d');

      if (!isEsp32) {
        sCtx.save();
        sCtx.scale(-1, 1);
        sCtx.drawImage(activeEl, -snapCanvas.width, 0, snapCanvas.width, snapCanvas.height);
        sCtx.restore();
      } else {
        sCtx.drawImage(activeEl, 0, 0, snapCanvas.width, snapCanvas.height);
      }

      sCtx.fillStyle = 'rgba(0, 0, 0, 0.65)';
      sCtx.fillRect(0, snapCanvas.height - 34, snapCanvas.width, 34);
      sCtx.fillStyle = '#FFFFFF';
      sCtx.font = 'bold 13px monospace';
      const nowStr = new Date().toISOString().replace('T', ' ').substring(0, 19);
      const srcName = isEsp32 ? 'ESP32' : 'WEBCAM';
      sCtx.fillText(`[${empId}|${srcName}] ${nowStr}  INCIDENT: ${triggerType.toUpperCase()}`, 12, snapCanvas.height - 12);

      snapCanvas.toBlob(async (blob) => {
        if (!blob) return;
        const formData = new FormData();
        formData.append('driver_id', empId);
        formData.append('trigger', triggerType);
        formData.append('snapshot', blob, `snap_${Date.now()}.jpg`);

        try {
          const res = await fetch('/api/snapshots/upload', {
            method: 'POST',
            headers: driverToken ? { 'Authorization': `Bearer ${driverToken}` } : {},
            body: formData
          });
          if (res.ok) {
            showToast(`📸 Incident snapshot saved (${triggerType})`, 'info');
          }
        } catch (err) {
          console.warn('[Snapshot] Upload fetch error:', err);
        }
      }, 'image/jpeg', 0.88);
      return;
    } catch (err) {
      console.warn('[Snapshot] Canvas capture error, trying server fallback:', err);
    }
  }

  // Fallback: Trigger server ESP32 snapshot
  try {
    const res = await fetch('/api/snapshots/trigger', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(driverToken ? { 'Authorization': `Bearer ${driverToken}` } : {})
      },
      body: JSON.stringify({ driver_id: empId, trigger: triggerType })
    });
    if (res.ok) {
      showToast(`📸 Hardware snapshot captured (${triggerType})`, 'info');
      return;
    }
  } catch (err) {
    console.warn('[Snapshot] Server trigger error:', err);
  }

  showToast('Camera feed not ready for snapshot', 'warning');
}

if (hudSnapshotBtn) {
  hudSnapshotBtn.onclick = () => captureIncidentSnapshot('manual');
}
window.captureIncidentSnapshot = captureIncidentSnapshot;
window.captureWebcamSnapshot = captureIncidentSnapshot;

// Test Stream Button
const testStreamBtn = document.getElementById('testStreamBtn');
const preTripCameraStatus = document.getElementById('preTripCameraStatus');
if (testStreamBtn) {
  testStreamBtn.addEventListener('click', async () => {
    preTripCameraStatus.textContent = 'Testing…';
    preTripCameraStatus.className = 'status-chip warning';
    const mode = preTripCameraSelect ? preTripCameraSelect.value : 'esp32';
    if (mode === 'webcam') {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        stream.getTracks().forEach(t => t.stop());
        preTripCameraStatus.textContent = 'Webcam Ready ✓';
        preTripCameraStatus.className = 'status-chip safe';
        showToast('Webcam connection confirmed', 'success');
      } catch (err) {
        preTripCameraStatus.textContent = 'Webcam Denied ✗';
        preTripCameraStatus.className = 'status-chip offline';
        showToast('Webcam access error: ' + err.message, 'error');
      }
    } else {
      let url = (preTripStreamUrl ? preTripStreamUrl.value.trim() : '') || localStorage.getItem('drowsyguard_stream_url') || '/esp32/stream';
      if (url.includes('ngrok') && !url.includes('ngrok-skip-browser-warning')) {
        const sep = url.includes('?') ? '&' : '?';
        url = `${url}${sep}ngrok-skip-browser-warning=true`;
      }
      const testImg = new Image();
      testImg.onload = () => {
        preTripCameraStatus.textContent = 'ESP32 Linked ✓';
        preTripCameraStatus.className = 'status-chip safe';
        showToast('ESP32 stream reachable', 'success');
      };
      testImg.onerror = () => {
        preTripCameraStatus.textContent = 'ESP32 Offline ✗';
        preTripCameraStatus.className = 'status-chip offline';
        showToast('ESP32 stream unreachable. Please check WiFi or use Webcam.', 'error');
      };
      testImg.crossOrigin = 'anonymous';
      testImg.src = url + (url.includes('?') ? '&' : '?') + 't=' + Date.now();
    }
  });
}

// ── Shift Break / Pause Controls ──────────────────────────────────────────
const hudBreakBtn = document.getElementById('hudBreakBtn');
const kioskBreakOverlay = document.getElementById('kioskBreakOverlay');
const breakDurationTimer = document.getElementById('breakDurationTimer');
const btnResumeBreak = document.getElementById('btnResumeBreak');

let isTripPaused = false;
let breakStartTime = null;
let breakTimerInterval = null;

function updateBreakTimer() {
  if (!breakStartTime || !breakDurationTimer) return;
  const elapsed = Math.floor((Date.now() - breakStartTime) / 1000);
  const m = Math.floor(elapsed / 60).toString().padStart(2, '0');
  const s = (elapsed % 60).toString().padStart(2, '0');
  breakDurationTimer.textContent = `${m}:${s}`;
}

function toggleBreak() {
  if (!isTripRunning) {
    showToast('Shift has not started yet', 'info');
    return;
  }

  isTripPaused = !isTripPaused;

  if (isTripPaused) {
    // Entering rest break
    breakStartTime = Date.now();
    if (breakTimerInterval) clearInterval(breakTimerInterval);
    breakTimerInterval = setInterval(updateBreakTimer, 1000);
    if (breakDurationTimer) breakDurationTimer.textContent = '00:00';

    if (hudBreakBtn) {
      hudBreakBtn.innerHTML = '▶ Resume Shift';
      hudBreakBtn.className = 'btn btn-primary btn-sm';
    }

    hudStatusChip.textContent = 'On Break';
    hudStatusChip.className = 'status-chip offline';
    kioskFaceBadge.textContent = '☕ Rest Break';
    kioskFaceBadge.className = 'status-chip offline';

    if (kioskBreakOverlay) kioskBreakOverlay.style.display = 'flex';

    // Cancel alarms & alert visuals
    alertEngine._stopContinuousAlarm();
    microsleepOverlay.classList.remove('active');
    kioskAlertBanner.classList.add('hidden');
    kioskVideoWrapper.className = 'kiosk-video-wrapper level-normal';
    ctx.clearRect(0, 0, kioskCanvas.width, kioskCanvas.height);

    showToast('Driving shift paused. Rest break in progress.', 'info');
  } else {
    // Resuming shift
    if (breakTimerInterval) clearInterval(breakTimerInterval);
    breakStartTime = null;

    if (hudBreakBtn) {
      hudBreakBtn.innerHTML = '⏸ Take Break';
      hudBreakBtn.className = 'btn btn-secondary btn-sm';
    }

    hudStatusChip.textContent = 'Safe';
    hudStatusChip.className = 'status-chip safe';
    kioskFaceBadge.textContent = '✓ Active';
    kioskFaceBadge.className = 'status-chip safe';

    if (kioskBreakOverlay) kioskBreakOverlay.style.display = 'none';

    // Flush rolling buffers so pre-break frames do not trigger instant alert
    fatigueEngine.earHistory = [];
    fatigueEngine.earBuffer = [];
    fatigueEngine.marBuffer = [];
    fatigueEngine.eyesClosedFrames = 0;
    fatigueEngine.yawnFrames = 0;

    showToast('Driving shift resumed. Real-time fatigue monitoring active ✓', 'success');
  }
}

if (hudBreakBtn) {
  hudBreakBtn.addEventListener('click', toggleBreak);
}
if (btnResumeBreak) {
  btnResumeBreak.addEventListener('click', toggleBreak);
}

// ── Begin Trip Shift Action ───────────────────────────────────────────────
document.getElementById('beginTripBtn').addEventListener('click', async () => {
  const mode = preTripCameraSelect ? preTripCameraSelect.value : 'esp32';
  const streamUrl = (preTripStreamUrl ? preTripStreamUrl.value.trim() : '') || localStorage.getItem('drowsyguard_stream_url') || '/esp32/stream';

  videoSource.mode = mode;
  if (mode === 'esp32') {
    videoSource.setEsp32Url(streamUrl);
    localStorage.setItem('drowsyguard_stream_url', streamUrl);
    if (hudStreamUrlInput) hudStreamUrlInput.value = streamUrl;
  }
  applyCanvasMirror(mode);
  kioskSourceLabel.textContent = mode === 'webcam' ? 'WEBCAM' : 'ESP32-CAM';

  try {
    // 1. Initialize face detection engine if not already loaded
    if (!faceDetector.faceMesh) {
      await faceDetector.init();
      faceDetector.onResults = handleFaceResults;
    }

    // 2. Start Video Source (kioskVideo for webcam, kioskEsp32 for ESP32)
    await videoSource.start(kioskVideo, kioskEsp32);

    // 3. Register trip with backend
    const res = await fetch('/api/trips', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${driverToken}`
      },
      body: JSON.stringify({ driver_id: currentDriver.id })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to start trip');

    // Ensure calibrated baseline EAR is active
    const baseline = (currentDriver && currentDriver.baselineEar) ? currentDriver.baselineEar : 0.31;
    fatigueEngine.calibrationEAR = baseline;
    fatigueEngine.calibrated = true;

    // Wire alert engine incident transitions with 8-second snapshot cooldown
    let lastSnapshotTriggerTime = 0;
    const SNAPSHOT_COOLDOWN_MS = 8000; // 8-second incident snapshot cooldown

    alertEngine.onLevelChange = (level, message) => {
      if (level === 'warning') {
        counts.warnings++;
        tripWarningCount.textContent = counts.warnings;
      } else if (level === 'danger') {
        counts.dangers++;
        tripDangerCount.textContent = counts.dangers;
      } else if (level === 'microsleep') {
        counts.microsleeps++;
        tripMicrosleepCount.textContent = counts.microsleeps;
      }

      // Automatically capture snapshot on severe fatigue with 8-second cooldown
      if (level === 'microsleep' || level === 'danger') {
        const now = Date.now();
        if (now - lastSnapshotTriggerTime >= SNAPSHOT_COOLDOWN_MS) {
          lastSnapshotTriggerTime = now;
          captureIncidentSnapshot(level);
        }
      }
    };

    currentTrip = data;
    isTripRunning = true;
    tripStartTime = Date.now();
    counts = { warnings: 0, dangers: 0, microsleeps: 0 };
    tripWarningCount.textContent = '0';
    tripDangerCount.textContent = '0';
    tripMicrosleepCount.textContent = '0';

    document.getElementById('hudDriverName').textContent = currentDriver.name;
    document.getElementById('hudVehicleName').textContent = currentDriver.vehicle;

    showScreen(screenActiveTrip);

    // Start Telemetry and Loop
    if (tripTimerInterval) clearInterval(tripTimerInterval);
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    if (batchFlushInterval) clearInterval(batchFlushInterval);

    tripTimerInterval = setInterval(updateTripTimer, 1000);
    heartbeatInterval = setInterval(sendHeartbeat, 5000);
    batchFlushInterval = setInterval(flushEventQueue, 3000);

    setupWebSocket();
    loop();
  } catch (err) {
    showToast('Failed to start in-cab camera: ' + err.message, 'error');
  }
});

// ── In-Cab Detection Loop ─────────────────────────────────────────────────
let lastDetectionTime = 0;
const DETECTION_INTERVAL_MS = 45; // ~22 FPS inference cap prevents browser GPU/CPU starvation

function loop(timestamp = performance.now()) {
  if (!isTripRunning) return;
  animFrameId = requestAnimationFrame(loop);

  if (isTripPaused) return;

  if (!videoSource.isReady()) return;
  const el = videoSource.getActiveElement();

  const { width: w, height: h } = videoSource.getSourceDimensions();
  if (kioskCanvas.width !== w || kioskCanvas.height !== h) {
    kioskCanvas.width = w;
    kioskCanvas.height = h;
  }

  // Throttle FaceMesh processing to keep stream display and UI thread fluid
  if (timestamp - lastDetectionTime >= DETECTION_INTERVAL_MS) {
    lastDetectionTime = timestamp;
    faceDetector.send(el);
  }
}

function handleFaceResults(faceData) {
  const state = fatigueEngine.update(faceData);
  const level = alertEngine.evaluate(state);

  // Update Face Badge
  if (faceData.detected) {
    kioskFaceBadge.textContent = '✓ Face Detected';
    kioskFaceBadge.className = 'status-chip safe';
  } else {
    kioskFaceBadge.textContent = '✗ No Face';
    kioskFaceBadge.className = 'status-chip offline';
  }

  // Update HUD Gauges
  updateKioskGauges(state, level);

  // Queue incidents for server telemetry
  if (level !== 'normal') {
    eventQueue.push({
      timestamp: new Date().toISOString(),
      type: state.microsleep ? 'microsleep' : state.yawning ? 'yawn' : level,
      severity: level === 'microsleep' ? 'critical' : level,
      duration_ms: 1000,
      ear: state.ear,
      mar: state.mar,
      perclos: state.perclos,
    });
  }

  // Draw landmarks
  ctx.clearRect(0, 0, kioskCanvas.width, kioskCanvas.height);
  if (faceData.detected) {
    drawLandmarks(faceData, level);
  }
}

function updateKioskGauges(state, level) {
  kioskEarVal.textContent = state.ear.toFixed(3);
  kioskEarState.textContent = state.eyesClosed ? 'Closed' : 'Open';
  kioskEarVal.style.color = state.eyesClosed ? 'var(--critical)' : 'var(--text)';

  kioskMarVal.textContent = state.mar.toFixed(3);
  kioskYawnCount.textContent = `Yawns: ${state.yawnCount}`;

  kioskBlinkVal.textContent = state.blinkRatePerMin;
  kioskTiltVal.textContent = `${state.headTilt.toFixed(0)}° / ${state.headNod.toFixed(0)}°`;

  // PERCLOS Arc
  const pct = Math.min(1, state.perclos);
  kioskPerclosVal.textContent = (pct * 100).toFixed(1) + '%';
  const offset = PERCLOS_CIRCUMFERENCE * (1 - pct);
  kioskPerclosArc.style.strokeDashoffset = offset;

  const color = state.microsleep ? 'var(--critical)' : pct > 0.7 ? 'var(--danger)' : pct > 0.4 ? 'var(--warning)' : 'var(--safe)';
  kioskPerclosArc.style.stroke = color;
  kioskPerclosVal.style.color = color;

  // Status chip and wrapper glow
  hudStatusChip.textContent = level;
  hudStatusChip.className = `status-chip ${level === 'microsleep' ? 'critical' : level}`;
  kioskVideoWrapper.className = `kiosk-video-wrapper level-${level}`;

  // Alert Banner
  if (level !== 'normal') {
    kioskAlertBanner.classList.remove('hidden');
    kioskAlertBanner.className = `alert-banner ${level === 'microsleep' ? 'microsleep' : level}`;
    kioskAlertMessage.textContent = state.microsleep ? 'CRITICAL: MICROSLEEP DETECTED' : level.toUpperCase() + ' FATIGUE';
  } else {
    kioskAlertBanner.classList.add('hidden');
  }

  // Microsleep Full-Screen In-Cab Overlay
  if (state.microsleep) {
    microsleepOverlay.classList.add('active');
  } else {
    microsleepOverlay.classList.remove('active');
  }
}

function drawLandmarks(faceData, level) {
  const W = kioskCanvas.width;
  const H = kioskCanvas.height;

  const eyeColor = level === 'normal' ? '#22C55E' : level === 'warning' ? '#F59E0B' : '#EF4444';

  for (const eye of [faceData.leftEye, faceData.rightEye]) {
    ctx.beginPath();
    eye.forEach((p, i) => {
      const x = p.x * W;
      const y = p.y * H;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.strokeStyle = eyeColor;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

function updateTripTimer() {
  if (!tripStartTime) return;
  const elapsed = Math.floor((Date.now() - tripStartTime) / 1000);
  const h = Math.floor(elapsed / 3600).toString().padStart(2, '0');
  const m = Math.floor((elapsed % 3600) / 60).toString().padStart(2, '0');
  const s = (elapsed % 60).toString().padStart(2, '0');
  hudTripTimer.textContent = `${h}:${m}:${s}`;
}

// ── Batch Event Ingestion ─────────────────────────────────────────────────
async function flushEventQueue() {
  if (eventQueue.length === 0 || !currentTrip) return;
  const eventsToSend = [...eventQueue];
  eventQueue = [];

  try {
    await fetch('/api/events/batch', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${driverToken}`
      },
      body: JSON.stringify({ trip_id: currentTrip.tripId, events: eventsToSend })
    });
  } catch (_) {
    // Re-queue on failure
    eventQueue = [...eventsToSend, ...eventQueue];
  }
}

// ── WebSocket Heartbeat ───────────────────────────────────────────────────
function setupWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'subscribe', role: 'driver', driverId: currentDriver.id }));
  };
}

function sendHeartbeat() {
  if (ws && ws.readyState === 1 && currentTrip) {
    ws.send(JSON.stringify({
      type: 'heartbeat',
      driverId: currentDriver.id,
      tripId: currentTrip.tripId,
      status: hudStatusChip.textContent,
      perclos: parseFloat(kioskPerclosVal.textContent) / 100,
      ear: parseFloat(kioskEarVal.textContent) || 0,
      blinkRate: parseInt(kioskBlinkVal.textContent, 10) || 0,
    }));
  }
}

// ── End Trip Shift Action ─────────────────────────────────────────────────
document.getElementById('hudEndTripBtn').addEventListener('click', async () => {
  if (!confirm('Conclude active driving trip?')) return;

  isTripRunning = false;
  if (animFrameId) cancelAnimationFrame(animFrameId);
  if (tripTimerInterval) clearInterval(tripTimerInterval);
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  if (batchFlushInterval) clearInterval(batchFlushInterval);
  if (breakTimerInterval) clearInterval(breakTimerInterval);
  isTripPaused = false;
  if (kioskBreakOverlay) kioskBreakOverlay.style.display = 'none';
  if (hudBreakBtn) {
    hudBreakBtn.innerHTML = '⏸ Take Break';
    hudBreakBtn.className = 'btn btn-secondary btn-sm';
  }

  await flushEventQueue();
  videoSource.destroy();
  ctx.clearRect(0, 0, kioskCanvas.width, kioskCanvas.height);

  try {
    const res = await fetch(`/api/trips/${currentTrip.tripId}/end`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${driverToken}` }
    });

    const summary = await res.json();
    document.getElementById('summaryDuration').textContent = `${Math.round(summary.durationSeconds / 60)} minutes`;
    const riskBadge = document.getElementById('summaryRiskBadge');
    riskBadge.textContent = `${summary.riskLevel} (${summary.riskScore})`;
    riskBadge.className = `risk-badge ${summary.riskLevel.toLowerCase()}`;

    document.getElementById('summaryWarnings').textContent = summary.warnings;
    document.getElementById('summaryDangers').textContent = summary.dangers;
    document.getElementById('summaryMicrosleeps').textContent = summary.microsleeps;

    tripSummaryModal.classList.add('active');
  } catch (err) {
    showToast('Error ending trip: ' + err.message, 'error');
  }
});

document.getElementById('finishShiftBtn').addEventListener('click', () => {
  tripSummaryModal.classList.remove('active');
  currentPin = '';
  pinDisplay.textContent = '····';
  showScreen(screenLogin);
});

// Check if already authenticated on load
if (driverToken) {
  const profile = localStorage.getItem('drowsyguard_driver_profile');
  if (profile) {
    currentDriver = JSON.parse(profile);
    setupPreTripScreen();
  }
}
