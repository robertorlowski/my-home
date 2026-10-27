// Ustawienia zaawansowane → grupa „Pompa ciepła / Pellet”: nastawy kotła stosowane po wyborze trybu
// pracy (Ustawienia → Tryb pracy), w dwóch kolumnach (tabela .data w .table-wrap, przycisk zapisu z prawej). Zapis w ustawieniach harmonogramu na serwerze
// (PUT /schedule-settings, pole profiles; wartości surowe jak w zleceniach). Edycja zawsze możliwa —
// to ustawienia aplikacji, nie regulatora; regulator sprawdzi zakres przy przełączeniu trybu.
import { FormEvent, useEffect, useState } from 'react';
import { PelletBoilerRequests } from '../api';
import { useSaveNotice } from '../../../core/components/Notification';
import { PelletBoilerMode, PelletBoilerParameter, PelletBoilerScheduleSettings, PelletBoilerSettings } from '../types';
import { COMMANDS_CHANGED, PROFILE_ROWS, choicesOf, display, itemOfKey } from './MainParameters';
import { t as tr, useLang } from '../../../core/i18n';

const modes = (): { key: PelletBoilerMode; label: string }[] => [
  { key: 'heat-pump', label: tr('type.heat_pump') },
  { key: 'pellet', label: tr('pb.pellet') },
];

const findParameter = (settings: PelletBoilerSettings, key: string): PelletBoilerParameter | undefined => {
  const item = itemOfKey(key);
  return item.kind === 'ecomax'
    ? settings.groups?.flatMap((g) => g.parameters).find((p) => p.index === item.index)
    : settings.mixers?.find((m) => m.mixer === item.mixer)?.parameters.find((p) => p.index === item.index);
};
const toRaw = (p: PelletBoilerParameter, value: number) => Math.round(value / (p.step ?? 1) + (p.offset ?? 0));
const fromRaw = (p: PelletBoilerParameter, raw: number) => Math.round((raw - (p.offset ?? 0)) * (p.step ?? 1) * 1e6) / 1e6;

// formId: przycisk zapisu poza formularzem (stopka okna „Nastawy trybów”: <button form={formId}>), wtedy bez własnego przycisku
export const ModeProfiles: React.FC<{ settings: PelletBoilerSettings; formId?: string }> = ({ settings, formId }) => {
  const { t } = useLang();
  const MODES = modes();
  const [schedule, setSchedule] = useState<PelletBoilerScheduleSettings | null>(null);
  // wartości formularza w jednostkach (tekst), klucz: tryb → parametr
  const [values, setValues] = useState<Record<PelletBoilerMode, Record<string, string>> | null>(null);
  const [error, setError] = useState('');
  // komunikat w karcie (nie Notification); przycisk nieaktywny w trakcie zapisu i dopóki go widać
  const { notice, showNotice, run, busy } = useSaveNotice();

  useEffect(() => {
    PelletBoilerRequests.getScheduleSettings().then((loaded) => {
      if (!loaded) return;
      setSchedule(loaded);
      const form = { 'heat-pump': {}, pellet: {} } as Record<PelletBoilerMode, Record<string, string>>;
      for (const { key: mode } of MODES) {
        for (const key of PROFILE_ROWS) {
          const parameter = findParameter(settings, key);
          const raw = loaded.profiles[mode]?.[key];
          if (parameter && raw !== undefined) form[mode][key] = String(fromRaw(parameter, raw));
        }
      }
      setValues(form);
    });
  }, [settings]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!schedule || !values) return;
    const profiles = { 'heat-pump': {}, pellet: {} } as PelletBoilerScheduleSettings['profiles'];
    for (const { key: mode, label } of MODES) {
      for (const key of PROFILE_ROWS) {
        const parameter = findParameter(settings, key);
        const text = values[mode][key];
        if (!parameter || text === undefined || text === '') continue;
        const number = Number(text.replace(',', '.'));
        if (!Number.isFinite(number)) return setError(`${label}: ${parameter.label}: ${t('pb.profiles.invalidNumber')}`);
        profiles[mode][key] = toRaw(parameter, number);
      }
    }
    await run(async () => { try {
      const saved = await PelletBoilerRequests.saveScheduleSettings({ ...schedule, profiles });
      setSchedule(saved);
      setError('');
      showNotice(t('pb.profiles.saved'));
      window.dispatchEvent(new Event(COMMANDS_CHANGED));
    } catch {
      setError(t('pb.profiles.saveFailed'));
    } });
  };

  if (!values) return <p className="help">{t('common.loading')}</p>;

  return (
    <form className="boiler-profiles-table" onSubmit={save} id={formId}>
      <div className="table-wrap">
      <table className="data">
        <thead>
          <tr><th>{t('pb.profiles.parameter')}</th>{MODES.map((mode) => <th key={mode.key}>{mode.label}</th>)}</tr>
        </thead>
        <tbody>
          {PROFILE_ROWS.map((key) => {
            const parameter = findParameter(settings, key);
            if (!parameter) return null;
            const item = itemOfKey(key);
            const choices = choicesOf(item, parameter);
            const name = `${item.kind === 'mixer' ? `${t('boiler.mixer', { n: item.mixer ?? 0 })}: ` : ''}${parameter.label ?? parameter.name}`;
            return (
              <tr key={key}>
                <td title={`${t('pb.range')} ${display(item, parameter, parameter.min)} – ${display(item, parameter, parameter.max)}`}>
                  {name}{parameter.unit && !choices ? ` [${parameter.unit}]` : ''}
                </td>
                {MODES.map(({ key: mode }) => (
                  <td key={mode}>
                    {choices ? (
                      <select value={values[mode][key] ?? ''} aria-label={`${name}: ${mode}`}
                        onChange={(event) => setValues({ ...values, [mode]: { ...values[mode], [key]: event.target.value } })}>
                        {choices.map((label, index) => <option key={label} value={String(index)}>{label}</option>)}
                      </select>
                    ) : (
                      <input type="number" step={parameter.step ?? 1} value={values[mode][key] ?? ''} aria-label={`${name}: ${mode}`}
                        onChange={(event) => setValues({ ...values, [mode]: { ...values[mode], [key]: event.target.value } })} />
                    )}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
      {error && <p className="help danger-text">{error}</p>}
      {notice && <p className="help">{notice}</p>}
      {!formId && <div className="actions"><button type="submit" className="btn btn-primary btn-sm" disabled={busy}>{t('pb.profiles.save')}</button></div>}
    </form>
  );
};
