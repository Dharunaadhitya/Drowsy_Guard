/**
 * VideoSource — abstracts between webcam and ESP32-CAM MJPEG stream.
 * Mode: 'webcam' | 'esp32'
 * Centralized stream link loaded from config.json.
 */

import { loadAppConfig, parseEsp32Config } from './config.js';

export class VideoSource {
  constructor(initialUrl = null) {
    this.mode = 'esp32';
    this.esp32Url = initialUrl || '/esp32/stream';
    this.stream = null;
    this.videoEl = null;
    this.imgEl = null;
    this.onStatusChange = null; // callback(status: string)
    this._esp32Connected = false; // true once first MJPEG frame arrives
    this._customUrlSet = Boolean(initialUrl);

    // Async init from centralized config only if no custom dynamic URL was provided
    loadAppConfig().then(cfg => {
      if (!this._customUrlSet && cfg && (cfg.proxyStreamUrl || cfg.esp32StreamUrl)) {
        this.esp32Url = cfg.proxyStreamUrl || cfg.esp32StreamUrl;
      }
    }).catch(() => {});
  }

  /** Attach to a <video> element (webcam) or <img> element (ESP32) */
  async start(videoEl, imgEl = null, customUrl = null) {
    this.videoEl = videoEl;
    this.imgEl = imgEl;
    if (customUrl) {
      this.setEsp32Url(customUrl);
    }
    await this._applyMode();
  }

  /**
   * Set or update the ESP32 stream URL dynamically.
   * If ESP32 mode is currently active, immediately reloads the <img> source.
   */
  setEsp32Url(url) {
    if (!url) return;
    this.esp32Url = url.trim();
    this._customUrlSet = true;
    if (this.mode === 'esp32' && this.imgEl) {
      this._disconnectEsp32();
      this._startEsp32();
    }
  }

  /**
   * Connect to a dynamic stream URL provided by the frontend.
   */
  async connectDynamicStream(url) {
    if (!url) return;
    this.setEsp32Url(url);
    if (this.mode !== 'esp32') {
      await this.switchMode('esp32');
    }
  }

  async switchMode(mode) {
    this._stopWebcam();
    this._disconnectEsp32();
    this.mode = mode;
    try {
      await this._applyMode();
    } catch (err) {
      this._emit('Source switch failed: ' + err.message);
      throw err;
    }
  }

  /** Returns the active element (video or img) for frame capture */
  getActiveElement() {
    return this.mode === 'webcam' ? this.videoEl : (this.imgEl || this.videoEl);
  }

  /**
   * Returns the actual pixel dimensions of the active source.
   * Works for both HTMLVideoElement and HTMLImageElement.
   */
  getSourceDimensions() {
    if (this.mode === 'webcam') {
      return {
        width: this.videoEl ? (this.videoEl.videoWidth || 640) : 640,
        height: this.videoEl ? (this.videoEl.videoHeight || 480) : 480,
      };
    }
    return {
      width: this.imgEl ? (this.imgEl.naturalWidth || 640) : 640,
      height: this.imgEl ? (this.imgEl.naturalHeight || 480) : 480,
    };
  }

  isReady() {
    if (this.mode === 'webcam') {
      return (
        Boolean(this.videoEl) &&
        this.videoEl.readyState >= 2 &&
        !this.videoEl.paused
      );
    }
    // ESP32: ready once first frame arrives or positive dimensions are set
    return this._esp32Connected || Boolean(this.imgEl && this.imgEl.naturalWidth > 0);
  }

  async _applyMode() {
    if (this.mode === 'webcam') {
      if (this.imgEl) this.imgEl.style.display = 'none';
      if (this.videoEl) this.videoEl.style.display = 'block';
      await new Promise(resolve => setTimeout(resolve, 150));
      await this._startWebcam();
    } else {
      this._stopWebcam();
      this._disconnectEsp32();
      if (this.videoEl) this.videoEl.style.display = 'none';
      if (this.imgEl) this.imgEl.style.display = 'block';
      this._startEsp32();
    }
  }

  async _startWebcam() {
    try {
      this._emit('Requesting webcam access…');
      console.log('[VideoSource] Requesting webcam access…');
      if (this.videoEl) {
        this.videoEl.style.display = 'block';
      }
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: false,
      });
      this.videoEl.srcObject = this.stream;
      await this.videoEl.play();
      console.log('[VideoSource] Webcam active');
      this._emit('Webcam active');
    } catch (err) {
      console.error('[VideoSource] Webcam error:', err.message);
      this._emit('Webcam error: ' + err.message);
      throw err;
    }
  }

  _stopWebcam() {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.videoEl) {
      this.videoEl.srcObject = null;
    }
  }

  _startEsp32() {
    if (!this.imgEl) {
      console.warn('[VideoSource] No <img> element provided for ESP32 stream');
      return;
    }

    let streamUrl = this.esp32Url || '/esp32/stream';

    // If using an Ngrok free-tier tunnel URL, append bypass query param
    // to prevent Ngrok from returning the HTML interstitial warning instead of MJPEG
    if (streamUrl.includes('ngrok') && !streamUrl.includes('ngrok-skip-browser-warning')) {
      const sep = streamUrl.includes('?') ? '&' : '?';
      streamUrl = `${streamUrl}${sep}ngrok-skip-browser-warning=true`;
    }

    console.log('[VideoSource] ESP32 stream connecting:', streamUrl);
    this._emit('ESP32-CAM: Connecting…');
    this._esp32Connected = false;

    this.imgEl.onload = null;
    this.imgEl.onerror = null;

    this.imgEl.onload = () => {
      this._esp32Connected = true;
      console.log(
        `[VideoSource] ESP32 stream connected — dimensions: ${this.imgEl.naturalWidth}x${this.imgEl.naturalHeight}`
      );
      this._emit('ESP32-CAM: Connected ✓');
    };

    this.imgEl.onerror = () => {
      this._esp32Connected = false;
      console.error('[VideoSource] ESP32 stream error — URL:', streamUrl);
      this._emit('ESP32-CAM: Connection failed — check stream link or mixed-content restriction');
    };

    this.imgEl.crossOrigin = 'anonymous';
    this.imgEl.src = '';
    setTimeout(() => {
      this.imgEl.src = streamUrl;
    }, 0);
  }

  _disconnectEsp32() {
    this._esp32Connected = false;
    if (this.imgEl) {
      this.imgEl.onload = null;
      this.imgEl.onerror = null;
      this.imgEl.removeAttribute('crossorigin');
      this.imgEl.src = '';
    }
  }

  destroy() {
    this._stopWebcam();
    this._disconnectEsp32();
    if (this.imgEl) {
      this.imgEl.style.display = 'none';
    }
  }

  _emit(status) {
    if (typeof this.onStatusChange === 'function') {
      this.onStatusChange(status);
    }
  }
}
