// Zakładka Harmonogram pompy (/schedules) w układzie makiety „Instrument” (#s-hp-harmonogram): karta „Tryb pracy”
// (przełącznik Ręczny / Automatyczny / Wyłączony i temperatura domyślna od–do; GET/PUT /device/properties) i karta
// „Wpisy” z listą (/schedules: praca albo przerwa OFF) oraz pozycją „Poza harmonogramem”. Wpis, który działa teraz
// (GET /schedules/current, odświeżane co minutę i po każdym zapisie), ma znacznik „działa teraz” i podświetlenie.
// Wpis dodaje i zmienia się w oknie „Wpis harmonogramu” (klasy .modal z makiety). Harmonogram działa tylko w trybie
// automatycznym; dawne wpisy CO i CWU są pokazywane jak praca.
import '../style.css';
import './style.css';
import { FormEvent, useEffect, useState } from 'react';
import { HpRequests } from '../../api';
import { DeviceRequests } from '../../../../core/api';
import { useDevice } from '../../../../core/context/DeviceContext';
import { CurrentSchedule, PumpWorkMode, pumpWorkMode, ScheduleEntry, ScheduleType, WeekDay } from '../../types';
import { DeviceProperties } from '../../../../core/types';
import Notification, { useSaveNotice } from '../../../../core/components/Notification';
import { IconButton } from '../../../../core/components/IconButton';
import { EditIcon, TrashIcon } from '../../../../core/components/icons';
import { Segmented, workModeHint, workModeOptions } from '../../components/Segmented';
import { CloseIcon } from '../../components/icons';
import { getLang, locale, t as tr, useLang } from '../../../../core/i18n';

// dni tygodnia i grupy dni: słownik day.* (core/i18n)
const WEEK_DAYS = [
  ['monday', WeekDay.MONDAY], ['tuesday', WeekDay.TUESDAY], ['wednesday', WeekDay.WEDNESDAY], ['thursday', WeekDay.THURSDAY],
  ['friday', WeekDay.FRIDAY], ['saturday', WeekDay.SATURDAY], ['sunday', WeekDay.SUNDAY],
] as const;
const weekDays = () => WEEK_DAYS.map(([key, value]) => [tr(`day.${key}`), value] as const);

const scheduleDayOptions = () => [
  [tr('day.any'), WeekDay.ANY_DAY],
  [tr('day.workdaysLong'), WeekDay.WORKDAYS],
  [tr('day.daysOffLong'), WeekDay.DAYS_OFF],
  ...weekDays(),
] as const;

// wartość listy „Dni” dla wpisu z konkretną datą (pole daty pod listą)
const DATE_OPTION = 'date';

const entryTypeOptions = () => [
  { value: 'heat', label: tr('hp.sch.work') },
  { value: 'off', label: tr('hp.sch.pause') },
] as const;

const emptyForm = {
  off: false,
  dayOfWeek: String(WeekDay.ANY_DAY),
  date: '',
  startTime: '',
  endTime: '',
  enabled: true,
  forceStart: false,
  minTemperature: '',
  maxTemperature: '',
};

// Opis dnia wpisu; data jednorazowa ma pierwszeństwo przed dniem tygodnia (jak w schedulerze).
const formatScheduleTarget = (schedule: ScheduleEntry): string => {
  if (schedule.date) return new Date(schedule.date).toLocaleDateString(locale(getLang()));
  if (schedule.dayOfWeek === WeekDay.ANY_DAY) return tr('day.any');
  if (schedule.dayOfWeek === WeekDay.WORKDAYS) return tr('day.workdays');
  if (schedule.dayOfWeek === WeekDay.DAYS_OFF) return tr('day.daysOff');
  return weekDays().find(([, value]) => value === schedule.dayOfWeek)?.[0] || tr('day.any');
};

// Temperatura od–do jak na serwerze (pump-mode.service.ts): 1–50 °C, od ≤ do.
// UWAGA: podniesienie maksymalnej temperatury pompy powyżej 50 °C wymaga podniesienia progu wstrzymania pompy przy gorącym kotle
// (BOILER_BLOCK_FROM 52 °C = maks. 50 + 2, server/src/modules/heat-pump/services/cwu-loading.service.ts), inaczej pompa
// zatrzyma się na wodzie, którą sama nagrzała.
const TEMPERATURE_MIN = 1;
const TEMPERATURE_MAX = 50;
const temperatureError = (min: string, max: string, required: boolean): string => {
  const values = [min, max].map((value) => value.trim());
  if (required && values.some((value) => value === '')) return tr('hp.sch.tempRequired');
  for (const value of values.filter(Boolean)) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < TEMPERATURE_MIN || number > TEMPERATURE_MAX) {
      return tr('hp.tempRange', { min: TEMPERATURE_MIN, max: TEMPERATURE_MAX });
    }
  }
  if (values[0] && values[1] && Number(values[0]) > Number(values[1])) return tr('hp.tempOrder');
  return '';
};

const text = (value?: string | String) => (value === undefined || value === null ? '' : String(value));

export const Schedules: React.FC = () => {
  const { device } = useDevice();
  const { t } = useLang();
  const [schedules, setSchedules] = useState<ScheduleEntry[]>([]);
  // wczytane properties (PUT zastępuje całe pole) i pola formularza ustawień domyślnych
  const [properties, setProperties] = useState<DeviceProperties | undefined>(undefined);
  const [mode, setMode] = useState<PumpWorkMode>('MANUAL');
  const [tempMin, setTempMin] = useState('');
  const [tempMax, setTempMax] = useState('');
  const [form, setForm] = useState(emptyForm);
  const [useDate, setUseDate] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [defaultSaving, setDefaultSaving] = useState(false);
  const [deleting, setDeleting] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [defaultError, setDefaultError] = useState('');
  // noticeBusy: komunikat widoczny, przyciski zapisu nieaktywne do jego zniknięcia (useSaveNotice)
  const { notice: saveNotice, showNotice, busy: noticeBusy } = useSaveNotice();
  const [currentSchedule, setCurrentSchedule] = useState<CurrentSchedule | null>(null);
  // zapisany tryb (nie bieżący wybór przycisków) decyduje, czy harmonogram działa
  const savedMode = pumpWorkMode(properties?.work_mode);

  const showSaveNotice = () => showNotice(t('common.saved'));

  const resetForm = () => {
    setForm(emptyForm);
    setUseDate(false);
    setEditingId(null);
    setShowForm(false);
    setError('');
  };

  const loadSchedules = () => {
    setLoading(true);
    HpRequests.getSchedules()
      .then((value) => setSchedules(value || []))
      .catch(() => setError(t('hp.sch.loadFailed')))
      .finally(() => setLoading(false));
  };

  // Temperatura od–do: nowe pola, a w urządzeniu sprzed zmiany para pasująca do podłączenia (jak serwer).
  const loadDefaultProperties = () => {
    DeviceRequests.getDeviceProperties()
      .then((value) => {
        const loaded = value ?? {};
        const co = device?.pumpConfig?.connection === 'co';
        setProperties(loaded);
        setMode(pumpWorkMode(loaded.work_mode));
        setTempMin(text(loaded.temp_min ?? (co ? loaded.co_min : loaded.cwu_min)));
        setTempMax(text(loaded.temp_max ?? (co ? loaded.co_max : loaded.cwu_max)));
      })
      .catch(() => setDefaultError(t('hp.sch.defaultsLoadFailed')));
  };

  const loadCurrentSchedule = () => {
    HpRequests.getCurrentSchedule()
      .then((value) => setCurrentSchedule(value))
      .catch(() => setCurrentSchedule(null));
  };

  useEffect(() => {
    loadSchedules();
    loadDefaultProperties();
    loadCurrentSchedule();
    // zaznaczenie działającej pozycji zmienia się z upływem czasu, scheduler liczy co minutę
    const timer = window.setInterval(loadCurrentSchedule, 60 * 1000);
    return () => window.clearInterval(timer);
  }, []);

  // okno wpisu zamyka Esc
  useEffect(() => {
    if (!showForm) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') resetForm(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showForm]);

  // PUT zastępuje całe properties: wysyłane są wczytane pola bez dawnych par co_*/cwu_* i dawnego trybu.
  // Zapis kasuje ręczne ustawienia z zakładki Ustawienia, a pompa dostaje nowe wartości w kilka sekund.
  const handleSaveDefaultProperties = async () => {
    const problem = temperatureError(tempMin, tempMax, true);
    setDefaultError(problem);
    if (problem) return;
    setDefaultSaving(true);
    try {
      const { co_min: _a, co_max: _b, cwu_min: _c, cwu_max: _d, ...rest } = properties ?? {};
      const saved = await DeviceRequests.updateDeviceProperties({
        ...rest,
        work_mode: mode,
        temp_min: tempMin.trim(),
        temp_max: tempMax.trim(),
      });
      setProperties(saved);
      loadCurrentSchedule();
      showSaveNotice();
    } catch {
      setDefaultError(t('hp.sch.defaultsSaveFailed'));
    } finally {
      setDefaultSaving(false);
    }
  };

  const updateForm = (field: keyof typeof form, value: string | boolean) => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  // puste pole = brak temperatury we wpisie; scheduler weźmie wtedy ustawienie domyślne
  const parseOptionalTemperature = (value: string): number | undefined => {
    const trimmed = value.trim();
    return trimmed === '' ? undefined : Number(trimmed);
  };

  // Uwaga: tworzenie idzie przez Requests.post, który nie rzuca wyjątku, więc błąd serwera przy
  // nowym wpisie nie pokaże komunikatu (edycja przez put rzuca i komunikat się pojawi).
  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const problem = form.off ? '' : temperatureError(form.minTemperature, form.maxTemperature, false);
    setError(problem);
    if (problem) return;
    setSaving(true);

    try {
      // HEAT = praca (serwer tłumaczy na CO albo CWU według podłączenia pompy), OFF = przerwa
      const payload = {
        type: form.off ? ScheduleType.OFF : ScheduleType.HEAT,
        enabled: form.enabled,
        ...(useDate
          ? { date: form.date }
          : { dayOfWeek: Number(form.dayOfWeek) }),
        startTime: form.startTime,
        endTime: form.endTime,
        // przerwa OFF nie używa temperatur ani wymuszenia
        forceStart: form.off ? false : form.forceStart,
        minTemperature: form.off ? undefined : parseOptionalTemperature(form.minTemperature),
        maxTemperature: form.off ? undefined : parseOptionalTemperature(form.maxTemperature),
      };

      if (editingId) {
        await HpRequests.updateSchedule(editingId, payload);
      } else {
        await HpRequests.createSchedule(payload);
      }

      resetForm();
      loadSchedules();
      loadCurrentSchedule();
      showSaveNotice();
    } catch {
      setError(t('hp.sch.entrySaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const startEditingSchedule = (schedule: ScheduleEntry) => {
    if (!schedule._id) return;

    setForm({
      off: schedule.type === ScheduleType.OFF,
      dayOfWeek: String(schedule.dayOfWeek ?? WeekDay.ANY_DAY),
      date: schedule.date ? schedule.date.slice(0, 10) : '',
      startTime: schedule.startTime,
      endTime: schedule.endTime,
      enabled: schedule.enabled,
      forceStart: schedule.forceStart,
      minTemperature: schedule.minTemperature === undefined ? '' : String(schedule.minTemperature),
      maxTemperature: schedule.maxTemperature === undefined ? '' : String(schedule.maxTemperature),
    });
    setUseDate(Boolean(schedule.date));
    setEditingId(schedule._id);
    setShowForm(true);
    setError('');
  };

  const handleDelete = async (schedule: ScheduleEntry) => {
    if (!schedule._id || !window.confirm(t('hp.sch.deleteConfirm'))) return;

    setDeleting(schedule._id);
    setError('');
    try {
      await HpRequests.deleteSchedule(schedule._id);
      setSchedules((current) => current.filter((item) => item._id !== schedule._id));
      loadCurrentSchedule();
    } catch {
      setError(t('hp.sch.entryDeleteFailed'));
    } finally {
      setDeleting('');
    }
  };

  // kolejność jak na liście dnia: data jednorazowa na końcu, w obrębie grupy po godzinie startu
  const sortedSchedules = [...schedules].sort((first, second) =>
    Number(Boolean(first.date)) - Number(Boolean(second.date)) || first.startTime.localeCompare(second.startTime));

  // temperatury pokazywane przy wpisach bez własnych (placeholder i opis) = zapisane ustawienie domyślne, a przed
  // pierwszym zapisem nowych pól para wczytana z dawnych co_* / cwu_*
  const savedMin = text(properties?.temp_min) || tempMin;
  const savedMax = text(properties?.temp_max) || tempMax;
  // „Poza harmonogramem” podświetlone, gdy żaden wpis nie działa; w trybie OFF nic nie jest zaznaczone
  const isDefaultCurrent = Boolean(currentSchedule && !currentSchedule.scheduleId && currentSchedule.work_mode !== 'OFF');
  const isScheduleCurrent = (schedule: ScheduleEntry) =>
    Boolean(schedule._id && currentSchedule?.scheduleId === schedule._id);
  // okno przez północ (start > koniec): koniec następnego dnia
  const overnight = (schedule: ScheduleEntry) => schedule.startTime > schedule.endTime;

  const describeEntry = (schedule: ScheduleEntry) => {
    if (schedule.type === ScheduleType.OFF) return t('hp.sch.pauseEntry');
    const temperatures = `${schedule.minTemperature ?? savedMin}–${schedule.maxTemperature ?? savedMax} °C`;
    return `${t('hp.sch.work')} · ${temperatures}${schedule.forceStart ? ` · ${t('hp.sch.forcedStartLower')}` : ''}${schedule.enabled ? '' : ` · ${t('hp.sch.entryDisabled')}`}`;
  };

  // lista „Dni” w oknie: dzień tygodnia albo „Konkretna data…” (pole daty pod listą)
  const dayValue = useDate ? DATE_OPTION : form.dayOfWeek;
  const changeDay = (value: string) => {
    if (value === DATE_OPTION) { setUseDate(true); return; }
    setUseDate(false);
    updateForm('dayOfWeek', value);
  };

  return (
    <div className="page page-device hp-view hp-schedules">
      <Notification message={saveNotice} />
      <section className="card">
        <header className="card-head"><h2>{t('hp.workMode')}</h2><span className="card-hint">{t('hp.sch.modeHint')}</span></header>
        <Segmented name="tryb" label={t('hp.workMode')} value={mode} options={workModeOptions(t)} onChange={setMode} />
        <p className="help">{workModeHint(mode, t)}</p>
        <div className="form-row">
          <label htmlFor="t-min">{t('hp.sch.defaultTemp')}</label>
          <div className="range-inputs">
            <input type="number" id="t-min" inputMode="numeric" aria-label={t('hp.tempFrom')} value={tempMin}
              aria-invalid={Boolean(defaultError)} onChange={(event) => setTempMin(event.target.value)} />
            <span className="dash">–</span>
            <input type="number" id="t-max" inputMode="numeric" aria-label={t('hp.tempTo')} value={tempMax}
              aria-invalid={Boolean(defaultError)} onChange={(event) => setTempMax(event.target.value)} />
            <span className="unit-txt">°C</span>
          </div>
        </div>
        {defaultError && <p className="field-error">{defaultError}</p>}
        <div className="actions">
          <button type="button" className="btn btn-primary" disabled={defaultSaving || noticeBusy || !properties} onClick={handleSaveDefaultProperties}>
            {defaultSaving ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </section>

      <section className="card">
        <header className="card-head">
          <h2>{t('hp.sch.entries')}</h2>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => { resetForm(); setShowForm(true); }}>{t('hp.sch.addEntry')}</button>
        </header>
        {properties && savedMode !== 'AUTO' && (
          <p className="help">
            {savedMode === 'OFF' ? t('hp.sch.inactiveOff') : t('hp.sch.inactiveManual')}
          </p>
        )}
        {!showForm && error && <p className="field-error">{error}</p>}
        {loading ? <p className="help">{t('common.loading')}</p> : (
          <ul className="entries">
            {schedules.length === 0 && <li className="help">{t('hp.sch.noEntries')}</li>}
            {sortedSchedules.map((schedule, index) => (
              <li
                className={`entry${isScheduleCurrent(schedule) ? ' is-current' : ''}${schedule.type === ScheduleType.OFF ? ' is-off' : ''}${schedule.enabled ? '' : ' is-disabled'}`}
                key={schedule._id || `${schedule.startTime}-${index}`}>
                <span className="entry-when">
                  <strong>{formatScheduleTarget(schedule)}</strong> {schedule.startTime}–{schedule.endTime}
                  {overnight(schedule) && <small> ({t('hp.sch.plusDay')})</small>}
                </span>
                <span className="entry-what">{describeEntry(schedule)}</span>
                {isScheduleCurrent(schedule) && <span className="entry-tag">{t('hp.sch.activeNow')}</span>}
                <span className="entry-actions">
                  <IconButton label={t('hp.sch.editEntry')} icon={<EditIcon />} onClick={() => startEditingSchedule(schedule)} />
                  <IconButton variant="danger" label={t('hp.sch.deleteEntry')} icon={<TrashIcon />}
                    disabled={!schedule._id || deleting === schedule._id} onClick={() => handleDelete(schedule)} />
                </span>
              </li>
            ))}
            {properties && (
              <li className={`entry is-default${isDefaultCurrent ? ' is-current' : ''}`}>
                <span className="entry-when"><strong>{t('hp.sch.outside')}</strong></span>
                <span className="entry-what">
                  {savedMode === 'OFF' ? t('hp.sch.pumpOff') : `${t('hp.sch.work')} · ${t('hp.sch.defaultSetting')} ${savedMin || '–'}–${savedMax || '–'} °C`}
                </span>
                {isDefaultCurrent && <span className="entry-tag">{t('hp.sch.activeNow')}</span>}
              </li>
            )}
          </ul>
        )}
      </section>

      {showForm && (
        <div className="modal-layer">
          <div className="scrim" onClick={resetForm} />
          <div className="modal" role="dialog" aria-labelledby="wpis-title">
            <form onSubmit={handleSubmit}>
              <header className="modal-head">
                <h2 id="wpis-title">{editingId ? t('hp.sch.editTitle') : t('hp.sch.newTitle')}</h2>
                <IconButton label={t('common.close')} icon={<CloseIcon />} onClick={resetForm} />
              </header>
              <div className="modal-body">
                <Segmented name="wpis-rodzaj" label={t('hp.sch.kind')} value={form.off ? 'off' : 'heat'} options={entryTypeOptions()}
                  onChange={(value) => updateForm('off', value === 'off')} />
                <label className="field">
                  <span>{t('hp.sch.days')}</span>
                  <select value={dayValue} onChange={(event) => changeDay(event.target.value)}>
                    {scheduleDayOptions().map(([name, value]) => <option key={value} value={value}>{name}</option>)}
                    <option value={DATE_OPTION}>{t('hp.sch.specificDate')}</option>
                  </select>
                </label>
                {useDate && (
                  <label className="field">
                    <span>{t('hp.sch.date')}</span>
                    <input type="date" required value={form.date} onChange={(event) => updateForm('date', event.target.value)} />
                  </label>
                )}
                <div className="form-grid">
                  <label htmlFor="wpis-od">{t('hp.sch.hours')}</label>
                  <div className="range-inputs">
                    <input type="time" id="wpis-od" required value={form.startTime} onChange={(event) => updateForm('startTime', event.target.value)} />
                    <span className="dash">–</span>
                    <input type="time" aria-label={t('hp.sch.hourTo')} required value={form.endTime} onChange={(event) => updateForm('endTime', event.target.value)} />
                  </div>
                  {!form.off && <>
                    <label htmlFor="wpis-tmin">{t('wx.temperature')}</label>
                    <div className="range-inputs">
                      <input type="number" id="wpis-tmin" step="1" placeholder={savedMin} value={form.minTemperature}
                        onChange={(event) => updateForm('minTemperature', event.target.value)} />
                      <span className="dash">–</span>
                      <input type="number" aria-label={t('hp.tempTo')} step="1" placeholder={savedMax} value={form.maxTemperature}
                        onChange={(event) => updateForm('maxTemperature', event.target.value)} />
                      <span className="unit-txt">°C</span>
                    </div>
                  </>}
                </div>
                <p className="help">
                  {form.off ? t('hp.sch.pauseHelp') : t('hp.sch.tempHelp')} {t('hp.sch.overnightHelp')}
                </p>
                {!form.off && (
                  <label className="check">
                    <input type="checkbox" checked={form.forceStart} onChange={(event) => updateForm('forceStart', event.target.checked)} />
                    <span>{t('hp.sch.forcedStart')}</span>
                    <small>{t('hp.sch.forcedStartHint')}</small>
                  </label>
                )}
                <label className="check">
                  <input type="checkbox" checked={form.enabled} onChange={(event) => updateForm('enabled', event.target.checked)} />
                  <span>{t('hp.sch.entryEnabled')}</span>
                </label>
                {error && <p className="field-error">{error}</p>}
              </div>
              <footer className="modal-foot">
                <button type="button" className="btn" onClick={resetForm}>{t('common.cancel')}</button>
                <button type="submit" className="btn btn-primary" disabled={saving || noticeBusy}>{saving ? t('common.saving') : t('hp.sch.saveEntry')}</button>
              </footer>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
