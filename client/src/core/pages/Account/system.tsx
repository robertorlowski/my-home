// Konto systemowe (/account, od 2026-11-07): panele w bocznym menu po lewej (komputer) albo w dolnej nawigacji
// (telefon), tak samo jak widoki sterownika i pogody. Panel jest w ?tab= (Moje dane = bez parametru).
// Panele: Moje dane, Powiadomienia i Ustawienia (karty Poczta, Aplikacja, Klucze powiadomień, Serwer, każda z własnym zapisem).
// Ustawienia aplikacji: POST /api/settings/read i PUT /api/settings, z hasłem ustawień (serwer core/services/settings.service.ts). Sekrety nie wracają
// z serwera, pole pokazuje tylko, że są ustawione; zapis wysyła wyłącznie zmienione pola.
import { FormEvent, ReactNode, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { SettingsRequests } from '../../api';
import { BottomNavItems, NavItem, SideTabs } from '../../components/Header';
import { BackIcon } from '../../components/icons';
import { PushSettingsCard } from '../../components/PushSettingsCard';
import { UserMenu } from '../../components/UserMenu';
import { useAuth } from '../../context/AuthContext';
import { ApiError } from '../../http';
import { useLang } from '../../i18n';
import { AppSetting, SettingGroup } from '../../types';

const icon = (path: ReactNode) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
    strokeLinejoin="round" aria-hidden="true">{path}</svg>
);

const SYSTEM_TABS = [
  { key: 'data', icon: icon(<><circle fill="none" cx="12" cy="8" r="4" /><path fill="none" d="M4 21c0-4 4-7 8-7s8 3 8 7" /></>) },
  { key: 'notifications', icon: icon(<path fill="none" d="M6 9a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8M10 21h4" />) },
  { key: 'settings', icon: icon(<><path fill="none" d="M4 7h10M18 7h2M4 17h2M10 17h10" /><circle fill="none" cx="16" cy="7" r="2" /><circle fill="none" cx="8" cy="17" r="2" /></>) },
] as const;
type SystemTabKey = (typeof SYSTEM_TABS)[number]['key'];
const SETTING_GROUPS: SettingGroup[] = ['mail', 'app', 'push', 'server'];

const systemTab = (value: string | null): SystemTabKey => SYSTEM_TABS.find((item) => item.key === value)?.key ?? 'data';

function useSystemItems(): { items: NavItem[]; active: SystemTabKey } {
  const location = useLocation();
  const [search] = useSearchParams();
  const { t } = useLang();
  const active = systemTab(search.get('tab'));
  return {
    active,
    items: SYSTEM_TABS.map((item) => ({
      key: item.key,
      to: { pathname: location.pathname, search: item.key === 'data' ? '' : `?tab=${item.key}` },
      label: t(`settings.tab.${item.key}`),
      icon: item.icon,
      active: active === item.key,
      replace: true,
    })),
  };
}

export function SystemAccountHeader() {
  const { items, active } = useSystemItems();
  const { t } = useLang();
  return (
    <>
      <Link to="/devices" className="nav-back" title={t('nav.deviceList')} aria-label={t('nav.backToList')}><BackIcon /></Link>
      <div className="device-title"><h1>{t(`settings.tab.${active}`)}</h1></div>
      <SideTabs items={items} label={t('settings.panels')} />
      <UserMenu />
    </>
  );
}

export function SystemAccountBottomNav() {
  const { t } = useLang();
  return <BottomNavItems items={useSystemItems().items} label={t('settings.panels')} />;
}

// Pole jednego ustawienia. Tekst w polu to wartość do zapisania; puste pole sekretu oznacza „bez zmian”.
function SettingField({ item, value, cleared, onChange, onClear }: {
  item: AppSetting; value: string; cleared: boolean; onChange: (text: string) => void; onClear: () => void;
}) {
  const { t } = useLang();
  const label = t(`settings.key.${item.key}`);
  const hint = <small className="help">{t(`settings.hint.${item.key}`)}</small>;
  if (item.kind === 'relay' || item.kind === 'jobs') {
    const on = item.kind === 'relay' ? '1' : 'on';
    const off = item.kind === 'relay' ? '0' : 'off';
    return (
      <label className="field">
        <span>{label}</span>
        <select value={value === on ? on : off} onChange={(event) => onChange(event.target.value)}>
          <option value={off}>{t('settings.off')}</option>
          <option value={on}>{t('settings.on')}</option>
        </select>
        {hint}
      </label>
    );
  }
  if (item.kind === 'secret') {
    const placeholder = item.isSet && !cleared ? t('settings.secretSet') : t('settings.secretEmpty');
    return (
      <label className="field">
        <span>{label}</span>
        <input type="password" autoComplete="new-password" value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
        {hint}
        {item.isSet && !cleared && !value && (
          <button type="button" className="btn btn-link settings-clear" onClick={onClear}>{t('settings.clearSecret')}</button>
        )}
      </label>
    );
  }
  return (
    <label className="field">
      <span>{label}</span>
      <input type={item.kind === 'port' ? 'number' : 'text'} autoComplete="off" value={value} onChange={(event) => onChange(event.target.value)} />
      {hint}
    </label>
  );
}

function SettingsPanel({ group, initial, save, onLocked }: {
  group: SettingGroup;
  initial: AppSetting[];
  save: (values: Record<string, string | null>) => Promise<AppSetting[]>;
  onLocked: () => void;
}) {
  const { t } = useLang();
  const [settings, setSettings] = useState(initial);
  const [draft, setDraft] = useState<Record<string, string>>(() => Object.fromEntries(initial.map((item) => [item.key, item.value ?? ''])));
  const [cleared, setCleared] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const load = (items: AppSetting[]) => {
    setSettings(items);
    setDraft(Object.fromEntries(items.map((item) => [item.key, item.value ?? ''])));
    setCleared({});
  };

  const items = settings.filter((item) => item.group === group);
  const changes = (): Record<string, string | null> => {
    const result: Record<string, string | null> = {};
    for (const item of items) {
      if (cleared[item.key]) result[item.key] = null;
      else if (item.kind === 'secret') { if (draft[item.key]) result[item.key] = draft[item.key]; }
      else if (draft[item.key] !== (item.value ?? '')) result[item.key] = draft[item.key];
    }
    return result;
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const values = changes();
    setDone(false);
    setError('');
    if (Object.keys(values).length === 0) return;
    setBusy(true);
    try {
      load(await save(values));
      setDone(true);
    } catch (caught) {
      // np. po północy hasło ustawień jest już inne
      if (caught instanceof ApiError && (caught.status === 403 || caught.status === 429)) onLocked();
      else setError(caught instanceof ApiError ? caught.message : t('common.somethingWrong'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <header className="card-head"><h2>{t(`settings.tab.${group}`)}</h2></header>
      <p className="help">{t(`settings.groupHint.${group}`)}</p>
      <form className="settings-form" onSubmit={submit}>
        {items.map((item) => (
          <SettingField key={item.key} item={item} value={draft[item.key] ?? ''} cleared={!!cleared[item.key]}
            onChange={(text) => { setDone(false); setDraft((current) => ({ ...current, [item.key]: text })); }}
            onClear={() => { setDone(false); setCleared((current) => ({ ...current, [item.key]: true })); }} />
        ))}
        {error && <div className="alert alert-err" role="alert"><div><strong>{error}</strong></div></div>}
        {done && <div className="toast toast-ok">{t('settings.saved')}</div>}
        <div className="actions actions-gap">
          <button type="submit" className="btn btn-primary" disabled={busy}>{t('common.save')}</button>
        </div>
      </form>
    </section>
  );
}

// Zakładka Ustawienia: najpierw hasło ustawień. Hasło jest tylko w pamięci tego ekranu, więc odświeżenie strony
// albo wyjście z konta wymaga podania go ponownie. Sprawdza je serwer przy każdym odczycie i zapisie.
function SettingsArea() {
  const { t } = useLang();
  const [password, setPassword] = useState('');
  const [unlocked, setUnlocked] = useState<{ password: string; settings: AppSetting[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const unlock = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      setUnlocked({ password, settings: await SettingsRequests.read(password) });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('settings.loadFailed'));
    } finally {
      setPassword('');
      setBusy(false);
    }
  };

  if (!unlocked) {
    return (
      <section className="card">
        <header className="card-head"><h2>{t('settings.tab.settings')}</h2></header>
        <p className="help">{t('settings.lockHint')}</p>
        <form className="settings-form" onSubmit={unlock}>
          <label className="field">
            <span>{t('settings.lockPassword')}</span>
            <input type="password" required autoFocus autoComplete="off" value={password} onChange={(event) => setPassword(event.target.value)} />
          </label>
          {error && <div className="alert alert-err" role="alert"><div><strong>{error}</strong></div></div>}
          <div className="actions actions-gap">
            <button type="submit" className="btn btn-primary" disabled={busy}>{t('settings.unlock')}</button>
          </div>
        </form>
      </section>
    );
  }
  return (
    <>
      {SETTING_GROUPS.map((group) => (
        <SettingsPanel key={group} group={group} initial={unlocked.settings}
          save={(values) => SettingsRequests.save(unlocked.password, values)}
          onLocked={() => { setUnlocked(null); setError(t('settings.lockedAgain')); }} />
      ))}
    </>
  );
}

export function SystemAccount() {
  const { logout } = useAuth();
  const { t } = useLang();
  const { active } = useSystemItems();
  return (
    <div className="page page-narrow account-page">
      {active === 'data' && (
        <>
          <section className="card">
            <header className="card-head"><h2>{t('account.systemTitle')}</h2></header>
            <p className="help">{t('account.systemHint')}</p>
          </section>
          <section className="card">
            <header className="card-head"><h2>{t('account.session')}</h2></header>
            <div className="actions"><button type="button" className="btn" onClick={() => void logout()}>{t('menu.logout')}</button></div>
          </section>
        </>
      )}
      {active === 'notifications' && <PushSettingsCard />}
      {active === 'settings' && <SettingsArea />}
    </div>
  );
}
