#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

// Replace with your network credentials
const char* ssid = "YOUR_WIFI";
const char* wifiPassword = "YOUR_WIFI_PASSWORD";

// Backend endpoint
const char* serverUrl = "http://192.168.1.245:3000/data";
const char* deviceId = "esp32-01";
const char* lineId = "line1";
const char* deviceToken = "abc123"; // X-Device-Key header

volatile uint32_t pulseCount = 0;     // counts pulses from sensor
unsigned long lastSend = 0;           // last send timestamp (ms)
uint32_t packetId = 0;                // monotonically increasing packet identifier

void IRAM_ATTR onPulse() {
  pulseCount++;
}

void setup() {
  Serial.begin(115200);
  pinMode(34, INPUT_PULLUP);            // pulse input pin
  attachInterrupt(digitalPinToInterrupt(34), onPulse, RISING);

  WiFi.begin(ssid, wifiPassword);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print('.');
  }
  Serial.println("\nWiFi connected");
  lastSend = millis();
}

void loop() {
  unsigned long now = millis();
  if (now - lastSend >= 10000) {               // send every 10 seconds
    uint32_t pulses = pulseCount;
    pulseCount = 0;
    unsigned long duration = now - lastSend;   // measurement window in ms
    lastSend = now;
    packetId++;

    StaticJsonDocument<256> doc;
    doc["deviceId"] = deviceId;
    doc["lineId"] = lineId;
    doc["packetId"] = packetId;
    doc["pulses"] = pulses;
    doc["duration"] = duration;
    doc["ts"] = millis(); // device timestamp

    String payload;
    serializeJson(doc, payload);

    if (WiFi.status() == WL_CONNECTED) {
      HTTPClient http;
      http.begin(serverUrl);
      http.addHeader("Content-Type", "application/json");
      http.addHeader("X-Device-Key", deviceToken);
      int httpCode = http.POST(payload);
      http.end();
      Serial.printf("POST %d pulses=%u\n", httpCode, pulses);
    }
  }
}
