#include <Arduino.h>
#include "esp_camera.h"
#include <WiFi.h>
#include "board_config.h"
#include "FS.h"
#include "SD_MMC.h"
#include <time.h>
#include <WiFiClient.h>
#include "esp_http_server.h"

// ==========================================
// Hardcoded WiFi & Server Fallback Settings
// (Used if SD card or config.txt is missing)
// ==========================================
const char *fallback_ssid     = "Dharun";
const char *fallback_password = "19022007";
const char *fallback_server   = "10.230.138.94";
const int   fallback_port     = 8080;
const char *fallback_driver   = "EMP001";

// Active runtime configuration (loaded from SD or fallback)
String wifiSsid   = fallback_ssid;
String wifiPass   = fallback_password;
String serverIp   = fallback_server;
int    serverPort = fallback_port;
String driverId   = fallback_driver;

bool sdCardMounted = false;

// Forward declarations & external server handle
void startCameraServer();
void setupLedFlash();
extern httpd_handle_t camera_httpd;

// ── SD Card Config Reader ──────────────────────────────────────────────────
void loadSdConfiguration() {
  File configFile = SD_MMC.open("/config.txt");
  if (!configFile) {
    configFile = SD_MMC.open("/sdcard/config.txt");
  }

  if (!configFile) {
    Serial.println("[SD] config.txt not found. Using fallback credentials.");
    return;
  }

  Serial.println("[SD] Reading /config.txt...");
  while (configFile.available()) {
    String line = configFile.readStringUntil('\n');
    line.trim();
    if (line.length() == 0 || line.startsWith("#")) continue;

    int eqIndex = line.indexOf('=');
    if (eqIndex > 0) {
      String key = line.substring(0, eqIndex);
      String val = line.substring(eqIndex + 1);
      key.trim();
      val.trim();

      if (key == "WIFI_SSID" && val.length() > 0) {
        wifiSsid = val;
      } else if (key == "WIFI_PASS") {
        wifiPass = val;
      } else if (key == "SERVER_IP" && val.length() > 0) {
        serverIp = val;
      } else if (key == "SERVER_PORT" && val.length() > 0) {
        serverPort = val.toInt();
      } else if (key == "DRIVER_ID" && val.length() > 0) {
        driverId = val;
      }
    }
  }
  configFile.close();

  Serial.printf("[SD] Config loaded: SSID=%s, Server=%s:%d, DriverID=%s\n",
                wifiSsid.c_str(), serverIp.c_str(), serverPort, driverId.c_str());
}

// ── SD Boot Logger ─────────────────────────────────────────────────────────
void logBootEvent(bool sdOk) {
  if (!sdOk) return;

  File logFile = SD_MMC.open("/boot_log.txt", FILE_APPEND);
  if (!logFile) {
    logFile = SD_MMC.open("/sdcard/boot_log.txt", FILE_APPEND);
  }

  if (logFile) {
    time_t now = time(nullptr);
    struct tm timeinfo;
    char timeBuffer[32];
    if (localtime_r(&now, &timeinfo) && timeinfo.tm_year > 100) {
      strftime(timeBuffer, sizeof(timeBuffer), "%Y-%m-%d %H:%M:%S", &timeinfo);
    } else {
      snprintf(timeBuffer, sizeof(timeBuffer), "millis:%lu", (unsigned long)millis());
    }

    logFile.printf("[%s] Boot OK | WiFi: %s | IP: %s | SD: %s\n",
                   timeBuffer,
                   wifiSsid.c_str(),
                   WiFi.localIP().toString().c_str(),
                   sdOk ? "OK" : "FAIL");
    logFile.close();
    Serial.println("[SD] Boot event appended to /boot_log.txt");
  } else {
    Serial.println("[SD] Warning: Failed to open /boot_log.txt for writing");
  }
}

// ── HTTP Multipart Snapshot Upload Helper ─────────────────────────────────
bool uploadSnapshotToServer(uint8_t *jpegBuf, size_t jpegLen, const char *fileName, const char *triggerType) {
  if (serverIp.length() == 0 || serverPort == 0) {
    Serial.println("[Upload] Server IP/Port not configured, skipping HTTP upload");
    return false;
  }

  WiFiClient client;
  client.setTimeout(3500); // 3.5s timeout prevents blocking stream loop

  Serial.printf("[Upload] Connecting to http://%s:%d/api/snapshots/upload...\n", serverIp.c_str(), serverPort);
  if (!client.connect(serverIp.c_str(), serverPort)) {
    Serial.println("[Upload] Server unreachable. Image preserved on SD card.");
    return false;
  }

  String boundary = "----ESP32IncidentBoundary" + String(millis());

  // Form body sections
  String bodyHead = "";
  bodyHead += "--" + boundary + "\r\n";
  bodyHead += "Content-Disposition: form-data; name=\"driver_id\"\r\n\r\n";
  bodyHead += driverId + "\r\n";

  bodyHead += "--" + boundary + "\r\n";
  bodyHead += "Content-Disposition: form-data; name=\"timestamp\"\r\n\r\n";
  bodyHead += String(millis()) + "\r\n";

  bodyHead += "--" + boundary + "\r\n";
  bodyHead += "Content-Disposition: form-data; name=\"trigger\"\r\n\r\n";
  bodyHead += String(triggerType) + "\r\n";

  bodyHead += "--" + boundary + "\r\n";
  bodyHead += "Content-Disposition: form-data; name=\"snapshot\"; filename=\"" + String(fileName) + "\"\r\n";
  bodyHead += "Content-Type: image/jpeg\r\n\r\n";

  String bodyTail = "\r\n--" + boundary + "--\r\n";

  size_t totalPayloadLen = bodyHead.length() + jpegLen + bodyTail.length();

  // Send HTTP Header
  client.printf("POST /api/snapshots/upload HTTP/1.1\r\n");
  client.printf("Host: %s:%d\r\n", serverIp.c_str(), serverPort);
  client.printf("User-Agent: ESP32-CAM-DrowsyGuard\r\n");
  client.printf("Content-Type: multipart/form-data; boundary=%s\r\n", boundary.c_str());
  client.printf("Content-Length: %u\r\n", totalPayloadLen);
  client.printf("Connection: close\r\n\r\n");

  // Send body head
  client.print(bodyHead);

  // Stream JPEG bytes in 1KB segments
  size_t remaining = jpegLen;
  uint8_t *curr = jpegBuf;
  while (remaining > 0 && client.connected()) {
    size_t chunk = (remaining > 1024) ? 1024 : remaining;
    size_t written = client.write(curr, chunk);
    if (written == 0) break;
    curr += written;
    remaining -= written;
  }

  // Send closing boundary
  client.print(bodyTail);

  // Quick non-blocking response verification
  unsigned long startWait = millis();
  bool success = false;
  while (client.connected() && (millis() - startWait < 3000)) {
    if (client.available()) {
      String statusLine = client.readStringUntil('\r');
      if (statusLine.indexOf("200") >= 0 || statusLine.indexOf("201") >= 0) {
        success = true;
      }
      break;
    }
    delay(10);
  }
  client.stop();

  Serial.printf("[Upload] Server response status: %s\n", success ? "SUCCESS (200 OK)" : "FAILED");
  return success;
}

// ── HTTP Endpoint: GET /trigger-snapshot ──────────────────────────────────
static esp_err_t trigger_snapshot_handler(httpd_req_t *req) {
  // Extract query trigger type if passed (?trigger=danger or ?trigger=microsleep)
  char queryBuffer[64];
  char triggerVal[32] = "microsleep";
  if (httpd_req_get_url_query_str(req, queryBuffer, sizeof(queryBuffer)) == ESP_OK) {
    if (httpd_query_key_value(queryBuffer, "trigger", triggerVal, sizeof(triggerVal)) != ESP_OK) {
      strlcpy(triggerVal, "microsleep", sizeof(triggerVal));
    }
  }

  sensor_t *s = esp_camera_sensor_get();
  if (!s) {
    httpd_resp_send_500(req);
    return ESP_FAIL;
  }

  // 1. Temporarily switch sensor to SVGA for high-resolution incident snapshot
  framesize_t streamFramesize = s->status.framesize;
  s->set_framesize(s, FRAMESIZE_SVGA);
  delay(80); // Settle sensor frame register

  // 2. Capture high-resolution JPEG frame
  camera_fb_t *fb = esp_camera_fb_get();

  // 3. IMMEDIATELY switch back to original stream resolution before doing I/O or returning
  s->set_framesize(s, streamFramesize);

  if (!fb) {
    Serial.println("[Snapshot] Camera frame capture failed");
    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    return httpd_resp_send(req, "{\"saved\":false,\"error\":\"capture_failed\"}", HTTPD_RESP_USE_STRLEN);
  }

  // 4. Save to SD card if available
  char fileName[48];
  snprintf(fileName, sizeof(fileName), "snap_%lu.jpg", (unsigned long)millis());
  char filePath[64];
  snprintf(filePath, sizeof(filePath), "/incidents/%s", fileName);

  bool fileSaved = false;
  if (sdCardMounted) {
    if (!SD_MMC.exists("/incidents")) {
      SD_MMC.mkdir("/incidents");
    }
    File snapFile = SD_MMC.open(filePath, FILE_WRITE);
    if (snapFile) {
      snapFile.write(fb->buf, fb->len);
      snapFile.close();
      fileSaved = true;
      Serial.printf("[SD] Snapshot written: %s (%u bytes)\n", filePath, fb->len);
    } else {
      Serial.printf("[SD] Failed to open %s for write\n", filePath);
    }
  } else {
    Serial.println("[SD] SD card not mounted. Skipping local file write.");
  }

  // 5. POST snapshot to central safety server
  bool uploaded = uploadSnapshotToServer(fb->buf, fb->len, fileName, triggerVal);

  // 6. Return camera frame buffer
  esp_camera_fb_return(fb);

  // 7. Send JSON response
  char responseJson[160];
  snprintf(responseJson, sizeof(responseJson),
           "{\"saved\":%s,\"file\":\"%s\",\"uploaded\":%s}",
           fileSaved ? "true" : "false",
           fileName,
           uploaded ? "true" : "false");

  httpd_resp_set_type(req, "application/json");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  return httpd_resp_send(req, responseJson, HTTPD_RESP_USE_STRLEN);
}

// ── HTTP Endpoint: GET /list-snapshots ────────────────────────────────────
static esp_err_t list_snapshots_handler(httpd_req_t *req) {
  httpd_resp_set_type(req, "application/json");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");

  if (!sdCardMounted) {
    return httpd_resp_send(req, "[]", 2);
  }

  File root = SD_MMC.open("/incidents");
  if (!root || !root.isDirectory()) {
    return httpd_resp_send(req, "[]", 2);
  }

  String jsonList = "[";
  bool isFirst = true;

  File item = root.openNextFile();
  while (item) {
    if (!item.isDirectory()) {
      if (!isFirst) jsonList += ",";
      jsonList += "\"" + String(item.name()) + "\"";
      isFirst = false;
    }
    item = root.openNextFile();
  }
  jsonList += "]";
  root.close();

  return httpd_resp_send(req, jsonList.c_str(), jsonList.length());
}

// ── Register Endpoints onto Camera Server ──────────────────────────────────
void registerSnapshotEndpoints() {
  if (camera_httpd == NULL) {
    Serial.println("[HTTP] camera_httpd is null; cannot attach snapshot endpoints");
    return;
  }

  httpd_uri_t trigger_uri = {
    .uri       = "/trigger-snapshot",
    .method    = HTTP_GET,
    .handler   = trigger_snapshot_handler,
    .user_ctx  = NULL
  };
  httpd_register_uri_handler(camera_httpd, &trigger_uri);

  httpd_uri_t list_uri = {
    .uri       = "/list-snapshots",
    .method    = HTTP_GET,
    .handler   = list_snapshots_handler,
    .user_ctx  = NULL
  };
  httpd_register_uri_handler(camera_httpd, &list_uri);

  Serial.println("[HTTP] Registered endpoints: /trigger-snapshot & /list-snapshots");
}

void setup() {
  Serial.begin(115200);
  Serial.setDebugOutput(true);
  Serial.println();
  Serial.println("==========================================");
  Serial.println("  🛡️  DrowsyGuard ESP32-CAM Starting...   ");
  Serial.println("==========================================");

  // ==========================================
  // SD Card Initialization (1-bit mode)
  // 1-bit avoids GPIO 4 flash LED conflicts
  // ==========================================
  if (SD_MMC.begin("/sdcard", true)) {
    sdCardMounted = true;
    uint8_t cardType = SD_MMC.cardType();
    Serial.printf("[SD] SD_MMC mounted successfully (Type: %d)\n", cardType);
    loadSdConfiguration();
  } else {
    sdCardMounted = false;
    Serial.println("[SD] SD Card Mount Failed. Using fallback WiFi credentials.");
  }

  camera_config_t config;

  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;

  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;

  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;

  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;

  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;

  config.xclk_freq_hz = 20000000;

  config.frame_size = FRAMESIZE_VGA;
  config.pixel_format = PIXFORMAT_JPEG;

  config.fb_location = CAMERA_FB_IN_PSRAM;

  // Target configuration
  config.jpeg_quality = 30;
  config.fb_count = 2;
  config.grab_mode = CAMERA_GRAB_LATEST;

  // ===========================
  // PSRAM & Performance Tuning
  // ===========================
  if (config.pixel_format == PIXFORMAT_JPEG) {
    if (psramFound()) {
      config.frame_size = FRAMESIZE_VGA; // 640x480 for smooth 20+ FPS
      config.jpeg_quality = 16;
      config.fb_count = 2;
      config.grab_mode = CAMERA_GRAB_LATEST;
      config.fb_location = CAMERA_FB_IN_PSRAM;
    } else {
      // If PSRAM is disabled in Arduino IDE, CIF (400x296) avoids 1 FPS lag/freeze
      config.frame_size = FRAMESIZE_CIF;
      config.fb_location = CAMERA_FB_IN_DRAM;
      config.jpeg_quality = 20;
      config.fb_count = 2;
      config.grab_mode = CAMERA_GRAB_LATEST;
    }
  } else {
    config.frame_size = FRAMESIZE_240X240;
#if CONFIG_IDF_TARGET_ESP32S3
    config.fb_count = 2;
#endif
  }

#if defined(CAMERA_MODEL_ESP_EYE)
  pinMode(13, INPUT_PULLUP);
  pinMode(14, INPUT_PULLUP);
#endif

  // ===========================
  // Initialize camera
  // ===========================
  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("Camera init failed with error 0x%x\n", err);
    return;
  }

  sensor_t *s = esp_camera_sensor_get();

  // ===========================
  // OV3660 image tuning
  // ===========================
  if (s->id.PID == OV3660_PID) {
    s->set_vflip(s, 1);
    s->set_brightness(s, 0);
    s->set_saturation(s, 1);
    s->set_contrast(s, 1);
    s->set_sharpness(s, 1);
  }

  // ===========================
  // Sensor tuning (High-FPS real-time streaming for MediaPipe)
  // CIF (400x296) with quality 22 produces lightweight ~10KB frames
  // eliminating Wi-Fi / Ngrok lag and boosting stream to 25+ FPS.
  // ===========================
  s->set_framesize(s, FRAMESIZE_CIF);
  s->set_quality(s, 22);
  s->set_brightness(s, 0);
  s->set_saturation(s, 1);
  s->set_contrast(s, 1);
  s->set_vflip(s, 1);
  s->set_hmirror(s, 0);

#if defined(CAMERA_MODEL_M5STACK_WIDE) || defined(CAMERA_MODEL_M5STACK_ESP32CAM)
  s->set_vflip(s, 1);
  s->set_hmirror(s, 1);
#endif

#if defined(CAMERA_MODEL_ESP32S3_EYE)
  s->set_vflip(s, 1);
#endif

  // ===========================
  // Flash LED
  // ===========================
#if defined(LED_GPIO_NUM)
  setupLedFlash();
#endif

  // ===========================
  // WiFi
  // ===========================
  WiFi.begin(wifiSsid.c_str(), wifiPass.c_str());

  // Disable WiFi power saving
  WiFi.setSleep(false);

  Serial.printf("Connecting to WiFi: %s", wifiSsid.c_str());
  int retryCount = 0;
  while (WiFi.status() != WL_CONNECTED && retryCount < 30) {
    delay(500);
    Serial.print(".");
    retryCount++;
  }

  // Fallback to hardcoded credentials if SD credentials failed to connect
  if (WiFi.status() != WL_CONNECTED && wifiSsid != fallback_ssid) {
    Serial.println("\n[WiFi] SD WiFi failed. Trying fallback WiFi...");
    wifiSsid = fallback_ssid;
    wifiPass = fallback_password;
    WiFi.begin(wifiSsid.c_str(), wifiPass.c_str());
    retryCount = 0;
    while (WiFi.status() != WL_CONNECTED && retryCount < 30) {
      delay(500);
      Serial.print(".");
      retryCount++;
    }
  }

  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("[WiFi] Connected successfully!");
    Serial.printf("[WiFi] IP Address: %s\n", WiFi.localIP().toString().c_str());

    // Sync NTP clock for accurate boot and incident timestamps
    configTime(0, 0, "pool.ntp.org", "time.nist.gov");
    delay(1000);
  } else {
    Serial.println("[WiFi] Connection failed.");
  }

  // Record boot in SD log
  logBootEvent(sdCardMounted);

  // ===========================
  // Start camera servers
  // ===========================
  startCameraServer();

  // Attach our incident snapshot & listing endpoints to port 80 server
  registerSnapshotEndpoints();

  Serial.println("\n------------------------------------------");
  Serial.printf("Camera Ready! Connect to 'http://%s'\n", WiFi.localIP().toString().c_str());
  Serial.printf("Stream URL:   'http://%s:81/stream'\n", WiFi.localIP().toString().c_str());
  Serial.printf("Snapshots:    'http://%s/trigger-snapshot'\n", WiFi.localIP().toString().c_str());
  Serial.println("------------------------------------------");
}

void loop() {
  // FreeRTOS tasks handle all HTTP and streaming requests
  delay(10000);
}