// Serwer WWW sterownika (WebServer, port 80). Strona / to statyczny HTML
// (TELEMETRY_PAGE), który w przeglądarce co 5 s pobiera /telemetry.json
// i /pv.json. Strona /install to szablon PAGE_TEMPLATE wypełniany w
// renderPage(); /save zapisuje Wi-Fi w NVS i restartuje sterownik.
#include <config_portal.hpp>

#include <WebServer.h>

#include <device_config.hpp>

namespace {

WebServer server(80);
const Telemetry *telemetrySource = nullptr;
const PvTelemetry *pvTelemetrySource = nullptr;
bool running = false;
bool restartRequested = false;
unsigned long restartRequestedAt = 0;

// Open view on /. The page pulls /telemetry.json and /pv.json so the
// firmware only has to serialise the documents it already keeps.
const char TELEMETRY_PAGE[] PROGMEM = R"VIEW(<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Heat pump controller</title><style>
*{box-sizing:border-box}
body{margin:0;padding:14px 12px 24px;background:#14161a;color:#e8eaed;
font:14px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
-webkit-text-size-adjust:100%}
.w{max-width:820px;margin:0 auto}
h1{font-size:1.02rem;margin:0;display:inline}
#stamp{margin:0 0 2px 8px;color:#9aa0a6;font-size:.76rem;display:inline}
h2{font-size:.68rem;letter-spacing:.08em;text-transform:uppercase;
color:#4db6a0;margin:15px 0 3px}
.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(146px,1fr));
gap:0 18px}
.r{display:flex;justify-content:space-between;align-items:baseline;gap:8px;
padding:2px 0;border-bottom:1px solid #22262b;font-size:.82rem}
.r span{color:#9aa0a6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.r b{font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}
.tw{overflow-x:auto;margin-top:2px}
table{border-collapse:collapse;width:100%;font-size:.78rem}
th,td{padding:3px 6px;text-align:right;white-space:nowrap;
font-variant-numeric:tabular-nums}
th{color:#9aa0a6;font-weight:600;font-size:.66rem;letter-spacing:.03em}
th:first-child,td:first-child{text-align:left}
tbody tr:nth-child(odd){background:#1a1d21}
footer{margin-top:18px;padding-top:10px;border-top:1px solid #22262b;
font-size:.8rem}
a{color:#4db6a0}
</style></head><body><div class="w">
<h1>Heat pump controller</h1><p id="stamp">loading...</p>
<div id="out"></div>
<footer><a href="/install">Configuration</a> &middot;
<a href="/telemetry.json">JSON</a> &middot;
<a href="/pv.json">PV JSON</a></footer>
</div><script>
var L={pv_power:"PV production",
controller_mode:"Mode",work_mode:"Work mode",temp_min:"T from",temp_max:"T to",
t_min:"T start",t_max:"T end",
cop:"COP",cop_min:"COP min",cop_max:"COP max",cop_bottom_start:"T bottom",
total_power:"Power",total_prod_today:"Today",total_prod:"Total",time:"Reading",
temperature:"Temp.",Tho:"T top",Ttarget:"T middle",Tmin:"T min",Tmax:"T max",
Tbe:"T before",Tae:"T after",Tsump:"T sump",EEV:"EEV",EEV_dt:"EEV dt",
EEV_pos:"EEV pos.",EEVmax:"EEV max",EEVmin:"EEV min",Watts:"Power",HCS:"Hot circuit",CCS:"Cold circuit",
HPS:"Compressor",F:"Forced",CO:"CO",ERR:"Error (code)",ERRn:"Event no.",ERRc:"Error count",
serial_queue_overflow:"Queue",serial_read_timeout:"Timeout",
serial_receive_overflow:"Receive",pv_crc_error:"PV CRC",
hp_json_error:"HP JSON",pv_frame_error:"PV frame",
cloud_http_status:"HTTP",cloud_request_error:"HTTP error",
websocket_disconnect:"WS disconn.",cloud_response_parse_error:"Parsing",
operation_validation_error:"Operations",preference_validation_error:"Settings"};
var DIAG=["cloud_http_status","cloud_request_error","websocket_disconnect",
"cloud_response_parse_error","serial_queue_overflow","serial_read_timeout",
"serial_receive_overflow","pv_crc_error","hp_json_error","pv_frame_error",
"operation_validation_error","preference_validation_error"];
var MAIN=["controller_mode","work_mode",
"temp_min","temp_max"];
var COP=["t_min","t_max","cop","cop_min","cop_max","cop_bottom_start"];
function lab(k){return L[k]||k}
function val(v){
  if(v===null||v===undefined||v==="")return "-";
  if(typeof v==="boolean")return v?"yes":"no";
  if(typeof v==="number")return Number.isInteger(v)?v:v.toFixed(2);
  return String(v);
}
function esc(s){return String(s).replace(/[&<>"]/g,function(c){
  return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})}
function grid(o,keys,raw){
  var h="",n=0;
  (keys||Object.keys(o)).forEach(function(k){
    if(!(k in o))return;
    n++;h+='<div class="r" title="'+esc(raw?lab(k):k)+'"><span>'+
      esc(raw?k:lab(k))+"</span><b>"+
      esc(val(o[k]))+"</b></div>";
  });
  return n?'<div class="g">'+h+"</div>":"";
}
function sec(t,body){return body?"<h2>"+esc(t)+"</h2>"+body:""}
function kwh(v){return typeof v==="number"?(v/1000).toFixed(1):val(v)}
function panels(list){
  if(!list||!list.length)return "";
  var h="<thead><tr><th>Serial no.</th><th>Port</th><th>W</th>"+
    "<th>V</th><th>A</th><th>Wh today</th><th>kWh</th><th>C</th>"+
    "<th>Grid V</th><th>Hz</th><th>Alarm</th></tr></thead><tbody>";
  list.forEach(function(p){
    var s=val(p.serial);
    h+='<tr><td title="'+esc(s)+'">'+esc(s.length>6?s.slice(-6):s)+
      "</td><td>"+esc(val(p.port))+"</td><td>"+esc(val(p.power))+
      "</td><td>"+esc(val(p.pv_voltage))+"</td><td>"+esc(val(p.pv_current))+
      "</td><td>"+esc(val(p.prod_today))+"</td><td>"+esc(kwh(p.prod_total))+
      "</td><td>"+esc(val(p.temperature))+"</td><td>"+esc(val(p.grid_voltage))+
      "</td><td>"+esc(val(p.grid_frequency))+"</td><td>"+esc(val(p.alarm_code))+
      "</td></tr>";
  });
  return '<div class="tw"><table>'+h+"</tbody></table></div>";
}
function render(d,pv){
  document.getElementById("stamp").textContent=d.time||"no timestamp";
  var hp=d.HP||{},o="";
  o+=sec("Controller",grid(d,MAIN));
  o+=sec("Heat pump",grid(hp,null,true));
  o+=sec("Cycle and COP",grid(d,COP));
  o+=sec("Diagnostics",grid(d,DIAG));
  o+=sec("Photovoltaics",grid(pv,["pv_power","total_power","total_prod_today",
    "total_prod","temperature","time"])+panels(pv.panels));
  document.getElementById("out").innerHTML=o||"<p>No data.</p>";
}
function load(u){return fetch(u,{cache:"no-store"}).then(function(r){
  return r.json()})}
function tick(){
  Promise.all([load("/telemetry.json"),load("/pv.json")]).then(function(a){
    render(a[0],a[1])}).catch(function(){
    document.getElementById("stamp").textContent="no connection"});
}
tick();setInterval(tick,5000);
</script></body></html>)VIEW";

// Configuration form on /install, behind basic auth.
const char PAGE_TEMPLATE[] PROGMEM = R"HTML(<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Heat pump controller</title><style>
*{box-sizing:border-box}
body{margin:0;padding:24px 16px;background:#14161a;color:#e8eaed;
font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
form{max-width:420px;margin:0 auto}
h1{font-size:1.25rem;margin:0 0 2px}
.sub{margin:0 0 24px;color:#9aa0a6;font-size:.875rem}
label{display:block;margin:18px 0 6px;font-size:.875rem;color:#c8cdd2}
input{width:100%;padding:11px 12px;border:1px solid #3c4043;border-radius:8px;
background:#1e2126;color:#e8eaed;font:inherit}
input:focus{outline:2px solid #5a9;outline-offset:-1px;border-color:#5a9}
input[readonly]{background:transparent;border-style:dashed;color:#9aa0a6;
font-family:ui-monospace,Consolas,monospace;font-size:.9rem}
input[readonly]:focus{outline:0;border-color:#3c4043}
small{display:block;margin-top:6px;color:#9aa0a6;font-size:.75rem}
.st{display:flex;align-items:center;gap:6px;margin-top:8px;font-size:.8rem}
.st:before{content:"";width:8px;height:8px;border-radius:50%;background:currentColor}
.st.on{color:#7fd6bb}.st.off{color:#f0b37a}
button{width:100%;margin-top:28px;padding:13px;border:0;border-radius:8px;
background:#4db6a0;color:#0b2b24;font:inherit;font-weight:600}
.msg{padding:12px 14px;border-radius:8px;margin-bottom:20px;font-size:.875rem}
.ok{background:#12352c;color:#7fd6bb}
.err{background:#3a1c1c;color:#f0a0a0}
a{color:#4db6a0}
</style></head><body><form method="POST" action="/save">
<h1>Heat pump controller</h1>
<p class="sub">Connection settings</p>
%MESSAGE%
<label for="ssid">Wi-Fi network</label>
<input id="ssid" name="ssid" value="%SSID%" required maxlength="63"
autocapitalize="off" autocorrect="off" spellcheck="false">
<label for="password">Wi-Fi password</label>
<input id="password" name="password" type="password" maxlength="63"
placeholder="unchanged">
<small>Leave empty to keep the current password.</small>
<label for="sn">SN</label>
<input id="sn" value="%SERIAL%" readonly>
<small>Controller serial number (factory MAC of the chip).</small>
<label for="rootid">Root ID</label>
<input id="rootid" value="%ROOTID%" placeholder="none" readonly>
%REGISTRATION%
<button type="submit">%BUTTON%</button>
<p class="sub" style="text-align:center;margin:22px 0 0"><a href="/">Telemetry view</a></p>
</form></body></html>)HTML";
String escapeHtml(const String &value)
{
  String escaped;
  escaped.reserve(value.length());
  for (size_t index = 0; index < value.length(); index++) {
    const char character = value.charAt(index);
    switch (character) {
      case '&': escaped += F("&amp;"); break;
      case '<': escaped += F("&lt;"); break;
      case '>': escaped += F("&gt;"); break;
      case '"': escaped += F("&quot;"); break;
      case '\'': escaped += F("&#39;"); break;
      default: escaped += character;
    }
  }
  return escaped;
}

// Wypełnia znaczniki %MESSAGE%, %SSID%, %SERIAL%, %ROOTID%, %REGISTRATION% i %BUTTON%
// w PAGE_TEMPLATE. Hasło Wi-Fi nigdy nie trafia do strony.
String renderPage(const String &message)
{
  const DeviceConfig &config = deviceConfig();
  String page = FPSTR(PAGE_TEMPLATE);
  page.replace("%MESSAGE%", message);
  page.replace("%SSID%", escapeHtml(config.wifiSsid));
  page.replace("%SERIAL%", escapeHtml(deviceSerial()));
  page.replace("%ROOTID%", escapeHtml(config.rootId));
  page.replace("%REGISTRATION%", deviceRegistered()
    ? F("<p class=\"st on\">Registered in the cloud</p>")
    : F("<p class=\"st off\">Not registered. The controller registers "
        "once it is connected to the internet.</p>"));
  page.replace("%BUTTON%", deviceRegistered()
    ? F("Save and restart") : F("Register and restart"));
  return page;
}

void sendPage(int status, const String &message)
{
  server.send(status, "text/html; charset=utf-8", renderPage(message));
}

bool authorized()
{
  if (server.authenticate(INSTALL_USER, INSTALL_PASSWORD)) return true;
  server.requestAuthentication(BASIC_AUTH, "Heat pump controller");
  return false;
}

void handleTelemetryPage()
{
  server.send_P(200, PSTR("text/html; charset=utf-8"), TELEMETRY_PAGE);
}

void handleTelemetryJson()
{
  if (telemetrySource == nullptr) {
    server.send(503, "application/json; charset=utf-8", "{}");
    return;
  }

  String payload;
  serializeJson(telemetrySource->document(), payload);
  server.send(200, "application/json; charset=utf-8", payload);
}

void handlePvJson()
{
  // Before the first reading the document is empty and serialises as null.
  if (pvTelemetrySource == nullptr || !pvTelemetrySource->hasReading()) {
    server.send(200, "application/json; charset=utf-8", "{}");
    return;
  }

  String payload;
  serializeJson(pvTelemetrySource->document(), payload);
  server.send(200, "application/json; charset=utf-8", payload);
}

void handleInstall()
{
  if (!authorized()) return;
  sendPage(200, "");
}

void handleSave()
{
  if (!authorized()) return;

  // An empty password field keeps the stored one, so the page never has to
  // echo the Wi-Fi password back over plain HTTP.
  String password = server.arg("password");
  if (password.length() == 0) password = deviceConfig().wifiPassword;

  if (!saveWifiConfig(server.arg("ssid"), password)) {
    sendPage(400, F("<div class=\"msg err\">Not saved. "
      "The Wi-Fi network cannot be empty.</div>"));
    return;
  }

  sendPage(200, F("<div class=\"msg ok\">Saved. "
    "The controller is restarting.</div>"));

  // Restarting here would cut the response short, so it is deferred until
  // handleClient() has closed the connection.
  restartRequested = true;
  restartRequestedAt = millis();
}
}

void beginConfigPortal(const Telemetry &telemetry, const PvTelemetry &pvTelemetry)
{
  if (running) return;

  telemetrySource = &telemetry;
  pvTelemetrySource = &pvTelemetry;
  server.on("/", HTTP_GET, handleTelemetryPage);
  server.on("/telemetry.json", HTTP_GET, handleTelemetryJson);
  server.on("/pv.json", HTTP_GET, handlePvJson);
  server.on("/install", HTTP_GET, handleInstall);
  server.on("/save", HTTP_POST, handleSave);
  server.onNotFound([]() {
    server.sendHeader("Location", "/");
    server.send(302, "text/plain", "");
  });
  server.begin();
  running = true;
}

void handleConfigPortal()
{
  if (!running) return;

  server.handleClient();

  constexpr unsigned long RESTART_DELAY_MS = 500;
  if (restartRequested && millis() - restartRequestedAt >= RESTART_DELAY_MS) {
    ESP.restart();
  }
}
