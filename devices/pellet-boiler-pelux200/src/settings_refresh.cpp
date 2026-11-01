// Kiedy czytać i ponownie wysłać ustawienia regulatora: opis w settings_refresh.hpp.
#include <settings_refresh.hpp>

SettingsRefresh::Reason SettingsRefresh::onReading(uint32_t nowMs, uint32_t targets, uint32_t readDoneMs,
  bool requested, bool blocked)
{
  if (hasReading_ && nowMs - lastReadingMs_ >= GAP_MS) gapPending_ = true;
  hasReading_ = true;
  lastReadingMs_ = nowMs;
  const bool targetsChanged = targets_ != 0 && targets != targets_;
  targets_ = targets;
  if (requested) {
    gapPending_ = false;
    return Reason::NONE;
  }
  if (blocked) return Reason::NONE;
  Reason reason = Reason::NONE;
  if (gapPending_) reason = Reason::AFTER_GAP;
  else if (targetsChanged && nowMs - lastTriggerMs_ >= TRIGGER_MIN_MS && nowMs - readDoneMs >= AFTER_READ_MS) {
    reason = Reason::TARGETS;
  } else if (nowMs - readDoneMs >= REFRESH_MS) {
    reason = Reason::PERIODIC;
  }
  if (reason != Reason::NONE) {
    lastTriggerMs_ = nowMs;
    gapPending_ = false;
  }
  return reason;
}

void SettingsUpload::onResult(bool ok, uint32_t nowMs)
{
  retrying_ = !ok;
  retryAtMs_ = nowMs + RETRY_MS;
}
