#include <net_recovery.hpp>

void NetRecovery::begin(uint32_t nowMs, bool afterNetRestart)
{
  sinceMs_ = nowMs;
  afterNetRestart_ = afterNetRestart;
  httpResetDone_ = false;
  reconnected_ = false;
}

void NetRecovery::online(uint32_t nowMs)
{
  sinceMs_ = nowMs;
  httpResetDone_ = false;
  reconnected_ = false;
  afterNetRestart_ = false;
}

NetAction NetRecovery::next(uint32_t nowMs, bool canRestart)
{
  const uint32_t offline = nowMs - sinceMs_;
  const uint32_t restartAfter = afterNetRestart_ ? times.restartAfterNetRestartMs : times.restartMs;
  if (offline >= restartAfter && canRestart) return NetAction::Restart;
  if (offline >= times.reconnectWifiMs && (!reconnected_ || nowMs - lastReconnectMs_ >= times.reconnectEveryMs)) {
    reconnected_ = true;
    lastReconnectMs_ = nowMs;
    wifiReconnects_++;
    return NetAction::ReconnectWifi;
  }
  if (offline >= times.resetHttpMs && !httpResetDone_) {
    httpResetDone_ = true;
    httpResets_++;
    return NetAction::ResetHttp;
  }
  return NetAction::None;
}
