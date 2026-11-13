// Logowanie i rejestracja (konta użytkowników, 2026-10-11) w wyglądzie „Instrument” z makiet/ (#s-logowanie, 2026-10-17):
// karta .auth-card z marką, kroki e-mail → kod z maila (6 cyfr, 10 min, 5 prób, nowy kod po 60 s) albo link z maila
// (/login?token=…). Wpisanie „system” zamiast e-maila (od 2026-11-13 bez hasła): „Wyślij kod” wysyła kod na stały adres
// konta system z ustawień serwera (bez poczty kod jest w dzienniku serwera), potem ten sam krok z kodem (5 min) i pytanie
// o zapamiętanie jak u innych; „Mam już kod” przechodzi do kroku z kodem bez wysyłania (kod z maila, awaryjny z polecenia
// na serwerze albo z telefonu). Kod z aplikacji na telefonie (TOTP, od 2026-11-13): krok 1 najpierw pyta serwer
// (POST /auth/methods), czy adres ma zarejestrowany telefon; jeśli tak, zamiast maila jest krok „Kod z aplikacji”
// z przyciskiem „Wyślij kod na maila” (dotychczasowa droga, zawsze dostępna). Konta bez telefonu działają jak dotąd.
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

/** krok: adres → kod z telefonu (gdy adres ma telefon) albo kod z maila */
type Step = 'email' | 'phone' | 'code';
/** skąd wziąć kod konta system: mail, dziennik serwera (bez poczty) albo „Mam już kod” (null) */
type SystemDelivery = 'mail' | 'log' | null;

export function Login() {
  const { signIn } = useAuth();
  const { t } = useLang();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<Step>('email');
  // adres (albo „system”), którego dotyczą kroki z kodem
  const [target, setTarget] = useState('');
  const [systemDelivery, setSystemDelivery] = useState<SystemDelivery>(null);
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const isSystem = email.trim().toLowerCase() === SYSTEM_LOGIN;
  const systemTarget = target === SYSTEM_LOGIN;

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

  // odliczanie do „Wyślij ponownie” (resendAt z serwera), tylko na kroku z kodem z maila
  useEffect(() => {
    if (step !== 'code') return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [step]);

  const showCodeStep = (to: string, resendAfterSeconds: number) => {
    setTarget(to);
    setStep('code');
    setCode('');
    setResendAt(Date.now() + resendAfterSeconds * 1000);
    setNow(Date.now());
  };

  // kod z maila: zwykłe konto POST /auth/start, konto system POST /auth/system
  const sendMailCode = async (to: string) => {
    setBusy(true);
    setError('');
    try {
      if (to === SYSTEM_LOGIN) {
        const result = await AuthRequests.systemStart();
        setSystemDelivery(result.delivery);
        showCodeStep(SYSTEM_LOGIN, result.resendAfterSeconds);
      } else {
        const result = await AuthRequests.start(to);
        showCodeStep(result.email, result.resendAfterSeconds);
      }
    } catch (caught) {
      // 429 = kod już wysłany i jeszcze nie minęło 60 s (u konta system także limit kodów na godzinę): przejście na krok
      // z kodem z odliczaniem, bo poprzedni kod nadal działa (serwer go nie unieważnia); blokada (locked) zostawia
      // bieżący krok z samym komunikatem
      if (caught instanceof ApiError && caught.status === 429 && caught.retryAfterSeconds && !caught.locked) {
        showCodeStep(to === SYSTEM_LOGIN ? SYSTEM_LOGIN : to.trim().toLowerCase(), caught.retryAfterSeconds);
      }
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  };

  // krok 1: adres z telefonem → kod z aplikacji; inaczej od razu kod z maila jak dotąd. Gdy serwer nie umie odpowiedzieć
  // (np. starsza wersja bez /auth/methods), też kod z maila, żeby logowanie zawsze działało.
  const next = async (event?: FormEvent) => {
    event?.preventDefault();
    setBusy(true);
    setError('');
    const login = isSystem ? SYSTEM_LOGIN : email;
    try {
      const methods = await AuthRequests.methods(login);
      if (methods.totp) {
        setTarget(methods.email);
        setStep('phone');
        setCode('');
        setBusy(false);
        return;
      }
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 400) {
        setError(message(caught));
        setBusy(false);
        return;
      }
    }
    await sendMailCode(login);
  };

  // konto system: kod już jest (kod awaryjny z polecenia na serwerze, mail sprzed chwili albo telefon), bez wysyłania
  const haveSystemCode = () => {
    setTarget(SYSTEM_LOGIN);
    setStep('code');
    setSystemDelivery(null);
    setCode('');
    setError('');
  };

  const back = () => {
    setStep('email');
    setTarget('');
    setSystemDelivery(null);
    setError('');
  };

  const verify = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      // konto system przyjmuje na jednym adresie kod z maila, awaryjny i z telefonu
      const session = systemTarget ? await AuthRequests.systemVerify(code)
        : step === 'phone' ? await AuthRequests.phoneVerify(target, code)
          : await AuthRequests.verifyCode(target, code);
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
  const systemSentText = systemDelivery === 'mail' ? t('login.systemSentMail')
    : systemDelivery === 'log' ? t('login.systemSentLog') : t('login.systemHaveCode');
  // maxLength 7 = „123 456” ze spacją
  const codeInput = (
    <input className="code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} required autoFocus placeholder={t('login.codePlaceholder')}
      value={code} onChange={(event) => setCode(event.target.value.replace(/[^\d ]/g, ''))} />
  );

  return (
    <div className="auth">
      <div className="auth-card">
        <div className="brand brand-big"><span className="brand-mark" /><span className="brand-name">{t('app.name')}</span></div>
        <h1>{t('login.title')}</h1>
        {step === 'email' && (
          <form className="auth-step" onSubmit={next}>
            <p className="help">{t('login.intro')}</p>
            <label className="field">
              <span>{t('login.email')}</span>
              <input type="text" inputMode="email" autoComplete="username" autoCapitalize="none" required autoFocus placeholder={t('login.emailPlaceholder')}
                value={email} onChange={(event) => setEmail(event.target.value)} />
            </label>
            {isSystem && <p className="help">{t('login.systemHint')}</p>}
            {error && <ErrorAlert text={error} />}
            <button type="submit" className="btn btn-primary btn-block" disabled={busy}>{t('login.sendCode')}</button>
            {isSystem && (
              <div className="auth-links">
                <button type="button" className="link-btn" disabled={busy} onClick={haveSystemCode}>{t('login.haveCode')}</button>
              </div>
            )}
          </form>
        )}
        {step === 'phone' && (
          <form className="auth-step" onSubmit={verify}>
            <p className="help">
              {t('login.phoneIntro')}{!systemTarget && <> {t('login.phoneAccount')} <strong>{target}</strong>.</>}
            </p>
            <label className="field">
              <span>{t('login.phoneCode')}</span>
              {codeInput}
            </label>
            {error && <ErrorAlert text={error} />}
            <button type="submit" className="btn btn-primary btn-block" disabled={busy}>{t('login.signIn')}</button>
            <button type="button" className="btn btn-ghost btn-block" disabled={busy} onClick={() => void sendMailCode(target)}>{t('login.phoneSendMail')}</button>
            <div className="auth-links">
              <span />
              <button type="button" className="link-btn" onClick={back}>{t('login.otherEmail')}</button>
            </div>
          </form>
        )}
        {step === 'code' && (
          <form className="auth-step" onSubmit={verify}>
            {systemTarget
              ? <p className="help">{systemSentText} {t('login.systemCodeValid')}</p>
              : <p className="help">{t('login.codeSentBefore')} <strong>{target}</strong>. {t('login.codeSentAfter')}</p>}
            <label className="field">
              <span>{systemTarget ? t('login.systemCode') : t('login.code')}</span>
              {codeInput}
            </label>
            {error && <ErrorAlert text={error} />}
            <button type="submit" className="btn btn-primary btn-block" disabled={busy}>{t('login.signIn')}</button>
            <div className="auth-links">
              <button type="button" className="link-btn" disabled={busy || wait > 0} onClick={() => void sendMailCode(target)}>
                {wait > 0 ? t('login.resendIn', { time: waitText }) : systemTarget && systemDelivery === null ? t('login.sendCode') : t('login.resend')}
              </button>
              <button type="button" className="link-btn" onClick={back}>{t('login.otherEmail')}</button>
            </div>
          </form>
        )}
        {demo && step === 'email' && (
          <div className="auth-demo">
            <button type="button" className="link-btn" disabled={busy} onClick={() => void enterDemo()}>{t('login.demo')}</button>
          </div>
        )}
      </div>
    </div>
  );
}
