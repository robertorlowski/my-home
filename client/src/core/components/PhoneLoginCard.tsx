// Karta „Logowanie kodem z telefonu” (TOTP, od 2026-11-13) na /account (zwykłe konto) i w „Moje dane” konta system.
// Włączenie: serwer losuje klucz i pokazuje go jako kod QR i tekst do przepisania (aplikacja Microsoft Authenticator albo
// Google Authenticator, wpis „mojeturnie.pl” z adresem konta); pierwszy kod z aplikacji zapisuje telefon. Telefon jest
// wspólny dla wszystkich aplikacji mojeturnie.pl (wspólna baza kluczy na serwerze, core/services/totp.service.ts), więc
// karta pokazuje też, w której go zarejestrowano. Wyłączenie wymaga kodu z telefonu albo z maila („Wyślij kod na maila”).
// Klucz jest tylko w pamięci tego ekranu i na serwerze do 10 minut; po zapisie strona go nie pokazuje.
import { FormEvent, useEffect, useState } from 'react';
import { PhoneRequests, PhoneSetup, PhoneStatus } from '../api';
import { ApiError } from '../http';
import { t as tr, useLang } from '../i18n';
import { dateLabel } from '../i18n/format';
import './account.css';

const message = (error: unknown) => (error instanceof ApiError ? error.message : tr('common.somethingWrong'));
/** klucz w grupach po 4 znaki, łatwiej przepisać */
const groups = (key: string) => key.match(/.{1,4}/g)?.join(' ') ?? key;
const APPS: Record<string, string> = { 'my-home': 'phone.app.myHome', archiwum: 'phone.app.archive', admin: 'phone.app.admin' };

export function PhoneLoginCard({ system = false }: { system?: boolean }) {
  const { t } = useLang();
  const [status, setStatus] = useState<PhoneStatus | null>(null);
  const [setup, setSetup] = useState<PhoneSetup | null>(null);
  const [disabling, setDisabling] = useState(false);
  const [mailSent, setMailSent] = useState<'mail' | 'log' | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    PhoneRequests.status().then(setStatus).catch((caught) => setError(message(caught)));
  }, []);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setDone('');
    try {
      await action();
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  };

  const start = () => run(async () => {
    setSetup(await PhoneRequests.setup());
    setCode('');
  });
  const cancelSetup = () => {
    setSetup(null);
    setCode('');
    setError('');
    void PhoneRequests.cancel().catch(() => undefined);
  };
  const confirm = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      setStatus(await PhoneRequests.confirm(code));
      setSetup(null);
      setCode('');
      setDone(t('phone.enabled'));
    });
  };
  const sendMail = () => run(async () => {
    setMailSent((await PhoneRequests.disableCode()).delivery);
  });
  const disable = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      setStatus(await PhoneRequests.disable(code));
      setDisabling(false);
      setMailSent(null);
      setCode('');
      setDone(t('phone.disabled'));
    });
  };

  const codeField = (label: string) => (
    <label className="field">
      <span>{label}</span>
      <input className="code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} required autoFocus placeholder={t('login.codePlaceholder')}
        value={code} onChange={(event) => setCode(event.target.value.replace(/[^\d ]/g, ''))} />
    </label>
  );

  const body = () => {
    if (!status) return error ? null : <p className="help">{t('common.loading')}</p>;
    if (!status.available) {
      return <p className="help">{t(status.reason === 'address' ? 'phone.noAddress' : 'phone.unavailable')}</p>;
    }
    if (setup) {
      return (
        <form className="settings-form" onSubmit={confirm}>
          <p className="help">{t('phone.setupHint', { address: setup.address })}</p>
          <img className="phone-qr" src={setup.qr} width={200} height={200} alt={t('phone.qrAlt')} />
          <div className="phone-key">
            <span className="help">{t('phone.keyLabel')}</span>
            <code>{groups(setup.secret)}</code>
          </div>
          {codeField(t('phone.firstCode'))}
          {error && <div className="alert alert-err" role="alert"><div><strong>{error}</strong></div></div>}
          <div className="actions actions-gap">
            <button type="button" className="btn" disabled={busy} onClick={cancelSetup}>{t('common.cancel')}</button>
            <button type="submit" className="btn btn-primary" disabled={busy}>{t('phone.confirm')}</button>
          </div>
        </form>
      );
    }
    if (!status.enabled) {
      return (
        <>
          <p className="help">{t('phone.offHint')}</p>
          <div className="actions"><button type="button" className="btn btn-primary" disabled={busy} onClick={() => void start()}>{t('phone.enable')}</button></div>
        </>
      );
    }
    const app = status.app ? (APPS[status.app] ? t(APPS[status.app]) : status.app) : '';
    return (
      <>
        <p className="help">{t('phone.onSince', { date: dateLabel(status.since), app })}</p>
        <p className="help">{t('phone.onHint')}</p>
        {disabling ? (
          <form className="settings-form" onSubmit={disable}>
            {codeField(t('phone.disableCode'))}
            {mailSent && <p className="help">{t(mailSent === 'log' ? 'phone.mailLog' : system ? 'phone.mailSentSystem' : 'phone.mailSent')}</p>}
            {error && <div className="alert alert-err" role="alert"><div><strong>{error}</strong></div></div>}
            <div className="actions actions-gap">
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void sendMail()}>{t('phone.sendMail')}</button>
              <button type="button" className="btn" disabled={busy} onClick={() => { setDisabling(false); setMailSent(null); setCode(''); setError(''); }}>{t('common.cancel')}</button>
              <button type="submit" className="btn btn-danger" disabled={busy}>{t('phone.disable')}</button>
            </div>
          </form>
        ) : (
          <div className="actions"><button type="button" className="btn btn-danger-ghost" onClick={() => { setDisabling(true); setDone(''); }}>{t('phone.disableStart')}</button></div>
        )}
      </>
    );
  };

  return (
    <section className="card">
      <header className="card-head"><h2>{t('phone.title')}</h2>{status?.enabled && <span className="card-hint">{t('phone.on')}</span>}</header>
      {body()}
      {error && !setup && !disabling && <div className="alert alert-err" role="alert"><div><strong>{error}</strong></div></div>}
      {done && <div className="toast toast-ok">{done}</div>}
    </section>
  );
}
