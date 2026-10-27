// Zakładka Harmonogram włącznika (/schedules), układ z makiety „Instrument” (#s-switch-harmonogram): karta na
// przekaźnik z chipem trybu (harmonogram / tryb ręczny blokuje harmonogram), lista wpisów (.entries; wpis działający
// teraz podświetlony ze znacznikiem „działa teraz” — scheduleId z GET /switch/relays, odświeżane co minutę; wpis
// nieaktywny i wpisy przekaźnika w trybie ręcznym wyszarzone) i „+ Dodaj wpis”. Wpis edytuje okno modalne
// (GET/POST/PUT/DELETE /switch/schedules). Dni jak w pompie ciepła; okno przez północ należy do dnia startu.
import { FormEvent, useEffect, useState } from 'react';
import { WeekDay } from '../../../core/types';
import Notification, { useSaveNotice } from '../../../core/components/Notification';
import { IconButton } from '../../../core/components/IconButton';
import { EditIcon, TrashIcon } from '../../../core/components/icons';
import { SwitchRequests } from '../api';
import { SwitchRelay, SwitchSchedule } from '../types';
import { formatMoment, relayLabel } from '../utils/format';
import { CloseIcon } from '../components/icons';
import { getLang, locale, t as tr, useLang } from '../../../core/i18n';
import './style.css';

// dni tygodnia: słownik day.* (core/i18n)
const WEEK_DAYS = [
  ['monday', WeekDay.MONDAY], ['tuesday', WeekDay.TUESDAY], ['wednesday', WeekDay.WEDNESDAY], ['thursday', WeekDay.THURSDAY],
  ['friday', WeekDay.FRIDAY], ['saturday', WeekDay.SATURDAY], ['sunday', WeekDay.SUNDAY],
] as const;
const weekDays = () => WEEK_DAYS.map(([key, value]) => [tr(`day.${key}`), value] as const);

// lista „Dni” w oknie wpisu; ostatnia pozycja odsłania pole daty
const DATE_OPTION = 'date';
const dayOptions = () => [
  [tr('day.any'), String(WeekDay.ANY_DAY)],
  [tr('day.workdaysLong'), String(WeekDay.WORKDAYS)],
  [tr('day.daysOffLong'), String(WeekDay.DAYS_OFF)],
  ...weekDays().map(([name, value]) => [name, String(value)] as const),
  [tr('hp.sch.specificDate'), DATE_OPTION],
] as const;

const emptyForm = { relay: '1', day: String(WeekDay.ANY_DAY), date: '', startTime: '', endTime: '', enabled: true };

const formatDay = (schedule: SwitchSchedule) => {
  if (schedule.date) return new Date(schedule.date).toLocaleDateString(locale(getLang()), { timeZone: 'Europe/Warsaw' });
  if (schedule.dayOfWeek === WeekDay.ANY_DAY) return tr('day.any');
  if (schedule.dayOfWeek === WeekDay.WORKDAYS) return tr('day.workdays');
  if (schedule.dayOfWeek === WeekDay.DAYS_OFF) return tr('day.daysOff');
  return weekDays().find(([, value]) => value === schedule.dayOfWeek)?.[0] ?? '---';
};

// chip w nagłówku karty przekaźnika: tryb, w którym jest teraz (słownik sw.chip.*)
const modeChip = (relay: SwitchRelay) => {
  switch (relay.mode) {
    case 'off': return <span className="chip chip-err">{tr('sw.chip.off')}</span>;
    case 'on': return <span className="chip chip-warn">{tr('sw.chip.on')}</span>;
    case 'timer': return <span className="chip chip-warn">{tr('sw.chip.timer')}</span>;
    case 'pause': return <span className="chip chip-warn">{tr('sw.chip.pause')}</span>;
    default: return <span className="chip chip-ok"><i className="dot" />{tr('sw.chip.schedule')}</span>;
  }
};

export const SwitchSchedules: React.FC = () => {
  const { t } = useLang();
  const [relays, setRelays] = useState<SwitchRelay[]>([]);
  const [schedules, setSchedules] = useState<SwitchSchedule[] | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // noticeBusy: komunikat widoczny, przycisk zapisu nieaktywny do jego zniknięcia (useSaveNotice)
  const { notice, showNotice, busy: noticeBusy } = useSaveNotice();

  const loadRelays = () => SwitchRequests.getRelays().then((result) => result && setRelays(result));
  const loadSchedules = () => SwitchRequests.getSchedules().then((result) => setSchedules(result ?? []));

  // przekaźniki co minutę: niosą scheduleId wpisu działającego teraz i nextStart (serwer liczy je z harmonogramu);
  // same wpisy zmieniają się tylko z tego okna, więc są pobierane po zapisie
  useEffect(() => {
    loadRelays();
    loadSchedules();
    const timer = window.setInterval(loadRelays, 60 * 1000);
    return () => window.clearInterval(timer);
  }, []);

  // Esc zamyka okno wpisu
  useEffect(() => {
    if (!showForm) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') closeForm(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showForm]);

  const closeForm = () => {
    setForm(emptyForm);
    setEditingId(null);
    setShowForm(false);
    setError('');
  };

  const openNew = (relay: number) => {
    setForm({ ...emptyForm, relay: String(relay) });
    setEditingId(null);
    setShowForm(true);
    setError('');
  };

  const update = (field: keyof typeof form, value: string | boolean) => setForm((current) => ({ ...current, [field]: value }));
  const useDate = form.day === DATE_OPTION;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    // data ma pierwszeństwo przed dniem tygodnia (serwer), więc wysyłane jest tylko jedno z nich
    const payload: SwitchSchedule = {
      relay: Number(form.relay),
      enabled: form.enabled,
      ...(useDate ? { date: form.date } : { dayOfWeek: Number(form.day) as WeekDay }),
      startTime: form.startTime,
      endTime: form.endTime,
    };
    try {
      if (editingId) await SwitchRequests.updateSchedule(editingId, payload);
      else await SwitchRequests.createSchedule(payload);
      closeForm();
      loadSchedules();
      loadRelays();
      showNotice(t('sw.sch.saved'));
    } catch {
      setError(t('sw.sch.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const edit = (schedule: SwitchSchedule) => {
    setForm({
      relay: String(schedule.relay),
      day: schedule.date ? DATE_OPTION : String(schedule.dayOfWeek ?? WeekDay.ANY_DAY),
      date: schedule.date ? schedule.date.slice(0, 10) : '',
      startTime: schedule.startTime,
      endTime: schedule.endTime,
      enabled: schedule.enabled,
    });
    setEditingId(schedule._id ?? null);
    setShowForm(true);
    setError('');
  };

  const remove = async (schedule: SwitchSchedule) => {
    if (!schedule._id || !window.confirm(t('hp.sch.deleteConfirm'))) return;
    try {
      await SwitchRequests.deleteSchedule(schedule._id);
      loadSchedules();
      loadRelays();
    } catch {
      setError(t('sw.sch.deleteFailed'));
    }
  };

  // wpis działający teraz = scheduleId z GET /switch/relays (jeden na przekaźnik); karty po jednej na przekaźnik
  const currentIds = new Set(relays.map((relay) => relay.scheduleId).filter(Boolean));
  const groups = relays.map((relay) => ({
    relay,
    schedules: (schedules ?? []).filter((schedule) => schedule.relay === relay.relay),
  }));
  const formRelay = relays.find((relay) => relay.relay === Number(form.relay));

  return (
    <div className="page page-device switch-page">
      <Notification message={notice} />
      {schedules === null && <section className="card"><p className="help">{t('common.loading')}</p></section>}
      {schedules !== null && relays.length === 0 && <section className="card"><p className="help">{t('sw.noRelays')}</p></section>}
      {error && !showForm && <section className="card card-danger"><p className="danger-text">{error}</p></section>}

      {schedules !== null && groups.map(({ relay, schedules: items }) => (
        <section className="card" key={relay.relay}>
          <header className="card-head"><h2>{relayLabel(relay)}</h2>{modeChip(relay)}</header>
          {items.length === 0 && <p className="help">{t('hp.sch.noEntries')}</p>}
          {items.length > 0 && (
            <ul className="entries">
              {items.map((schedule) => {
                const current = Boolean(schedule._id && currentIds.has(schedule._id));
                // tryb ręczny on / off blokuje harmonogram (timer i pause same wracają do schedule, więc nie wyszarzają);
                // start > koniec = okno przez północ, należy do dnia startu (serwer, calendar.service)
                const blocked = relay.mode === 'off' || relay.mode === 'on';
                const overnight = schedule.startTime > schedule.endTime;
                return (
                  <li key={schedule._id} className={`entry${current ? ' is-current' : ''}${!schedule.enabled || blocked ? ' is-off' : ''}`}>
                    <span className="entry-when">
                      <strong>{formatDay(schedule)}</strong> {schedule.startTime}–{schedule.endTime}{overnight && <small> ({t('hp.sch.plusDay')})</small>}
                    </span>
                    <span className="entry-what">
                      {!schedule.enabled ? t('hp.sch.entryDisabled') : t('sw.sch.enabled')}
                      {schedule.enabled && blocked && ` · ${t(relay.mode === 'off' ? 'sw.sch.blockedOff' : 'sw.sch.blockedOn')}`}
                      {schedule.enabled && !blocked && current && relay.nextStart && ` · ${t('sw.sch.nextStart', { when: formatMoment(relay.nextStart) })}`}
                      {schedule.enabled && !blocked && !current && overnight && ` · ${t('sw.sch.overnightNote')}`}
                    </span>
                    {current && <span className="entry-tag">{t('hp.sch.activeNow')}</span>}
                    <span className="entry-actions">
                      <IconButton label={t('hp.sch.editEntry')} icon={<EditIcon />} onClick={() => edit(schedule)} />
                      <IconButton label={t('hp.sch.deleteEntry')} variant="danger" icon={<TrashIcon />} onClick={() => remove(schedule)} />
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => openNew(relay.relay)}>{t('hp.sch.addEntry')}</button>
          </div>
        </section>
      ))}

      {relays.length > 0 && (
        <p className="help">{t('sw.sch.help')}</p>
      )}

      {showForm && (
        <div className="modal-layer">
          <div className="scrim" onClick={closeForm} />
          <form className="modal" role="dialog" aria-labelledby="switch-entry-title" onSubmit={submit}>
            <header className="modal-head">
              <h2 id="switch-entry-title">{editingId ? t('hp.sch.newTitle') : t('sw.sch.newEntry')}{formRelay ? ` · ${relayLabel(formRelay)}` : ''}</h2>
              <button type="button" className="icon-btn sm" aria-label={t('common.close')} onClick={closeForm}><CloseIcon /></button>
            </header>
            <div className="modal-body">
              {relays.length > 1 && (
                <label className="field">
                  <span>{t('sw.relay')}</span>
                  <select value={form.relay} onChange={(event) => update('relay', event.target.value)}>
                    {relays.map((relay) => <option key={relay.relay} value={relay.relay}>{relayLabel(relay)}</option>)}
                  </select>
                </label>
              )}
              <label className="field">
                <span>{t('hp.sch.days')}</span>
                <select value={form.day} onChange={(event) => update('day', event.target.value)}>
                  {dayOptions().map(([name, value]) => <option key={value} value={value}>{name}</option>)}
                </select>
              </label>
              {useDate && (
                <label className="field">
                  <span>{t('hp.sch.date')}</span>
                  <input type="date" required value={form.date} onChange={(event) => update('date', event.target.value)} />
                </label>
              )}
              <div className="form-grid">
                <label htmlFor="switch-entry-from">{t('hp.sch.hours')}</label>
                <div className="range-inputs">
                  <input type="time" id="switch-entry-from" required value={form.startTime} onChange={(event) => update('startTime', event.target.value)} />
                  <span className="dash">–</span>
                  <input type="time" required aria-label={t('common.to')} value={form.endTime} onChange={(event) => update('endTime', event.target.value)} />
                </div>
              </div>
              <p className="help">
                {t('sw.sch.windowHelp')}
                {form.startTime && form.endTime && form.startTime > form.endTime && ` ${t('sw.sch.overnightUntil', { time: form.endTime })}`}
              </p>
              <label className="check">
                <input type="checkbox" checked={form.enabled} onChange={(event) => update('enabled', event.target.checked)} />
                <span>{t('hp.sch.entryEnabled')}</span>
              </label>
              {error && <p className="danger-text">{error}</p>}
            </div>
            <footer className="modal-foot">
              <button type="button" className="btn" onClick={closeForm}>{t('common.cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving || noticeBusy}>
                {saving ? t('common.saving') : editingId ? t('sw.sch.saveChanges') : t('hp.sch.saveEntry')}
              </button>
            </footer>
          </form>
        </div>
      )}
    </div>
  );
};
