// Logowanie i rejestracja (konta użytkowników, 2026-10-11) w wyglądzie „Instrument” z makiet/ (#s-logowanie, 2026-10-17):
// karta .auth-card z marką, kroki e-mail → kod z maila (6 cyfr, 10 min, 5 prób, nowy kod po 60 s) albo link z maila
// (/login?token=…). Wpisanie „system” zamiast e-maila pokazuje pole hasła (użytkownik systemowy; bez osobnego linku).
// Logika w AuthContext (signIn), żądania w AuthRequests; style w components/account.css.
import { FormEvent, useEffect, useState } from 'react';
import { AuthRequests } from '../../api';
import { useAuth } from '../../context/AuthContext';
import { ApiError } from '../../http';
import { t as tr, useLang } from '../../i18n';
import '../../components/account.css';

const SYSTEM_LOGIN = 'system';
const message = (error: unknown) => (error instanceof ApiError ? error.message : tr('common.somethingWrong'));

const ErrorAlert = ({ text }: { text: string }) => (
  <div className="alert alert-err" role="alert"><div><strong>{text}</strong></div></div>
);

export function Login() {
  const { signIn } = useAuth();
  const { t } = useLang();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const isSystem = email.trim().toLowerCase() === SYSTEM_LOGIN;

  // link z maila: /login?token=… — token jest jednorazowy, więc od razu znika z adresu (odświeżenie strony
  // nie próbuje go użyć drugi raz i nie pokazuje błędu „link wykorzystany”)
  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('token');
    if (!token) return;
    window.history.replaceState(null, '', '/');
    setBusy(true);
    AuthRequests.verifyLink(token)
      .then((session) => signIn(session.token, session.user))
      .catch((caught) => setError(`${message(caught)} ${t('login.linkFailedHint')}`))
      .finally(() => setBusy(false));
  }, []);

  // odliczanie do „Wyślij ponownie” (resendAt z serwera), tylko na kroku z kodem
  useEffect(() => {
    if (!sentTo) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [sentTo]);

  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (isSystem) {
        const session = await AuthRequests.system(password);
        signIn(session.token, session.user);
        return;
      }
      const result = await AuthRequests.start(email);
      setSentTo(result.email);
      setCode('');
      setResendAt(Date.now() + result.resendAfterSeconds * 1000);
      setNow(Date.now());
    } catch (caught) {
      // 429 = kod już wysłany i jeszcze nie minęło 60 s: przejście na krok z kodem z odliczaniem, bo poprzedni kod
      // nadal działa (serwer go nie unieważnia)
      if (caught instanceof ApiError && caught.status === 429 && caught.retryAfterSeconds && !isSystem) {
        setSentTo(email.trim().toLowerCase());
        setResendAt(Date.now() + caught.retryAfterSeconds * 1000);
      }
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  };

  const verify = async (event: FormEvent) => {
    event.preventDefault();
    if (!sentTo) return;
    setBusy(true);
    setError('');
    try {
      const session = await AuthRequests.verifyCode(sentTo, code);
      signIn(session.token, session.user);
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  };

  // wersja demo (2026-10-21): przycisk pod formularzem, gdy serwer ma DEMO_OWNER_EMAIL
  const [demo, setDemo] = useState(false);
  useEffect(() => { AuthRequests.demoAvailable().then((result) => setDemo(result.available)).catch(() => setDemo(false)); }, []);
  const enterDemo = async () => {
    setBusy(true);
    setError('');
    try {
      const session = await AuthRequests.demo();
      signIn(session.token, session.user);
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  };

  const wait = Math.max(0, Math.ceil((resendAt - now) / 1000));
  const waitText = `${Math.floor(wait / 60)}:${String(wait % 60).padStart(2, '0')}`;

  return (
    <div className="auth">
      <div className="auth-card">
        <div className="brand brand-big"><span className="brand-mark" /><span className="brand-name">My Home</span></div>
        <h1>{t('login.title')}</h1>
        {sentTo === null ? (
          <form className="auth-step" onSubmit={send}>
            <p className="help">{t('login.intro')}</p>
            <label className="field">
              <span>{t('login.email')}</span>
              <input type="text" inputMode="email" autoComplete="username" autoCapitalize="none" required autoFocus placeholder={t('login.emailPlaceholder')}
                value={email} onChange={(event) => setEmail(event.target.value)} />
            </label>
            {isSystem && (
              <label className="field">
                <span>{t('login.password')}</span>
                <input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} />
              </label>
            )}
            {error && <ErrorAlert text={error} />}
            <button type="submit" className="btn btn-primary btn-block" disabled={busy}>{isSystem ? t('login.signIn') : t('login.sendCode')}</button>
          </form>
        ) : (
          <form className="auth-step" onSubmit={verify}>
            <p className="help">{t('login.codeSentBefore')} <strong>{sentTo}</strong>. {t('login.codeSentAfter')}</p>
            <label className="field">
              <span>{t('login.code')}</span>
              <input className="code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} required autoFocus placeholder={t('login.codePlaceholder')}
                value={code} onChange={(event) => setCode(event.target.value.replace(/[^\d ]/g, ''))} />{/* maxLength 7 = „123 456” ze spacją */}
            </label>
            {error && <ErrorAlert text={error} />}
            <button type="submit" className="btn btn-primary btn-block" disabled={busy}>{t('login.signIn')}</button>
            <div className="auth-links">
              <button type="button" className="link-btn" disabled={busy || wait > 0} onClick={() => send()}>
                {wait > 0 ? t('login.resendIn', { time: waitText }) : t('login.resend')}
              </button>
              <button type="button" className="link-btn" onClick={() => { setSentTo(null); setError(''); }}>{t('login.otherEmail')}</button>
            </div>
          </form>
        )}
        {demo && sentTo === null && (
          <div className="auth-demo">
            <button type="button" className="link-btn" disabled={busy} onClick={() => void enterDemo()}>{t('login.demo')}</button>
          </div>
        )}
      </div>
    </div>
  );
}
