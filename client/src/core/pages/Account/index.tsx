// „Moje dane” (/account, menu konta w nagłówku; konta użytkowników, 2026-10-11) w wyglądzie „Instrument” z makiet/
// (od 2026-10-21 także karta „Powiadomienia” — PushSettingsCard, Web Push)
// (#s-konto, 2026-10-17): karty „Moje dane” (e-mail ze zmianą przez kod na nowy adres, dane i lokalizacja konta —
// ProfileForm), „Sesja” (wylogowanie) i czerwona „Usunięcie konta” (.card-danger; link potwierdzający w mailu,
// okno .modal). DeleteAccountConfirm (/account/delete?token=…) to strona z linku — działa także bez zalogowania.
import { FormEvent, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AuthRequests } from '../../api';
import { ProfileForm } from '../../components/ProfileForm';
import { PushSettingsCard } from '../../components/PushSettingsCard';
import { useAuth, userDisplayName } from '../../context/AuthContext';
import { ApiError } from '../../http';
import { t as tr, useLang } from '../../i18n';
import '../../components/account.css';

const message = (error: unknown) => (error instanceof ApiError ? error.message : tr('common.somethingWrong'));

const ErrorAlert = ({ text }: { text: string }) => (
  <div className="alert alert-err" role="alert"><div><strong>{text}</strong></div></div>
);

// Wiersz „E-mail” karty „Moje dane”: adres i link „zmień”, który rozwija pod wierszem kroki nowy adres → kod.
function EmailRow({ email }: { email: string }) {
  const { setUser } = useAuth();
  const { t } = useLang();
  const [step, setStep] = useState<'idle' | 'email' | 'code'>('idle');
  const [newEmail, setNewEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);

  const cancel = () => { setStep('idle'); setError(''); setCode(''); };
  const send = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await AuthRequests.changeEmail(newEmail);
      setStep('code');
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  };
  const verify = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      // serwer zwraca zaktualizowany profil; setUser podmienia go w AuthContext, więc nagłówek i menu od razu mają nowy adres
      const user = await AuthRequests.verifyEmail(code);
      setUser(user);
      setDone(t('account.emailChanged', { email: user.email ?? '' }));
      cancel();
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <dl className="kv">
        <div>
          <dt>{t('login.email')}</dt>
          <dd>
            {email}{' '}
            {step === 'idle' && <button type="button" className="link-btn" onClick={() => { setStep('email'); setNewEmail(''); setDone(''); }}>{t('account.change')}</button>}
          </dd>
        </div>
      </dl>
      {step === 'email' && (
        <form className="auth-step account-inline" onSubmit={send}>
          <p className="help">{t('account.newEmailHint')}</p>
          <label className="field"><span>{t('account.newEmail')}</span><input type="email" required autoFocus value={newEmail} onChange={(event) => setNewEmail(event.target.value)} /></label>
          {error && <ErrorAlert text={error} />}
          <div className="actions actions-gap">
            <button type="button" className="btn" onClick={cancel} disabled={busy}>{t('common.cancel')}</button>
            <button type="submit" className="btn btn-primary" disabled={busy}>{t('login.sendCode')}</button>
          </div>
        </form>
      )}
      {step === 'code' && (
        <form className="auth-step account-inline" onSubmit={verify}>
          <p className="help">{t('login.codeSentBefore')} <strong>{newEmail}</strong> {t('account.codeValid')}</p>
          <label className="field"><span>{t('login.code')}</span><input className="code" inputMode="numeric" maxLength={7} required autoFocus placeholder={t('login.codePlaceholder')} value={code} onChange={(event) => setCode(event.target.value.replace(/[^\d ]/g, ''))} /></label>
          {error && <ErrorAlert text={error} />}
          <div className="actions actions-gap">
            <button type="button" className="btn" onClick={cancel} disabled={busy}>{t('common.cancel')}</button>
            <button type="submit" className="btn btn-primary" disabled={busy}>{t('account.changeEmail')}</button>
          </div>
        </form>
      )}
      {done && <div className="toast toast-ok">{done}</div>}
    </>
  );
}

// Okno „Usunąć konto?” (.modal z makiety): wysyła link potwierdzający na e-mail konta.
function DeleteDialog({ email, onClose }: { email: string; onClose: () => void }) {
  const { t, tn } = useLang();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState<number | null>(null);
  const send = async () => {
    setBusy(true);
    setError('');
    try {
      setSent((await AuthRequests.deleteAccount()).devices);
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-layer">
      <div className="scrim" onClick={onClose} />
      <div className="modal modal-sm" role="alertdialog" aria-modal="true" aria-labelledby="delete-title">
        <header className="modal-head"><h2 id="delete-title">{t('account.deleteTitle')}</h2></header>
        <div className="modal-body">
          {sent === null ? (
            <>
              <p>{t('account.deleteWhat')}</p>
              <p>{t('account.deleteLinkBefore')} <strong>{email}</strong> {t('account.deleteLinkAfter')}</p>
              {error && <ErrorAlert text={error} />}
            </>
          ) : (
            <p>{t('account.deleteSentBefore')} <strong>{email}</strong>. {sent ? tn('account.deleteSentDevices', sent) : t('account.deleteSentAfter')}</p>
          )}
        </div>
        <footer className="modal-foot">
          {sent === null ? (
            <>
              <button type="button" className="btn" onClick={onClose} disabled={busy}>{t('common.cancel')}</button>
              <button type="button" className="btn btn-danger" onClick={send} disabled={busy}>{t('account.sendLink')}</button>
            </>
          ) : (
            <button type="button" className="btn btn-primary" onClick={onClose}>OK</button>
          )}
        </footer>
      </div>
    </div>
  );
}

export function Account() {
  const { user, setUser, logout } = useAuth();
  const { t } = useLang();
  const navigate = useNavigate();
  // /account?delete=1 otwiera od razu okno usuwania (pozycja „Usuń konto” w menu konta, UserMenu)
  const [deleting, setDeleting] = useState(() => new URLSearchParams(window.location.search).has('delete'));
  const [saved, setSaved] = useState(false);
  if (!user) return null;

  // wersja demo: jedna karta z wyjaśnieniem i wyjściem (bez danych, powiadomień i usuwania konta)
  if (user.isDemo) {
    return (
      <div className="page page-narrow account-page">
        <section className="card">
          <header className="card-head"><h2>{t('account.demoTitle')}</h2></header>
          <p className="help">{t('account.demoText')}</p>
          <div className="actions"><button type="button" className="btn btn-ghost" onClick={() => void logout()}>{t('account.demoExit')}</button></div>
        </section>
      </div>
    );
  }

  return (
    <div className="page page-narrow account-page">
      <section className="card">
        <header className="card-head"><h2>{user.isSystem ? t('account.systemTitle') : t('menu.myData')}</h2><span className="card-hint">{userDisplayName(user, t)}</span></header>
        {user.email && <EmailRow email={user.email} />}
        {!user.isSystem && (
          <ProfileForm user={user} onSaved={(updated) => { setUser(updated); setSaved(true); }} onCancel={() => navigate(-1)} />
        )}
        {saved && <div className="toast toast-ok">{t('common.saved')}</div>}
        {user.isSystem && <p className="help">{t('account.systemHint')}</p>}
      </section>

      <PushSettingsCard />

      <section className="card">
        <header className="card-head"><h2>{t('account.session')}</h2></header>
        <p className="help">{t('account.sessionHint')}</p>
        <div className="actions"><button type="button" className="btn btn-ghost" onClick={() => void logout()}>{t('menu.logout')}</button></div>
      </section>

      {!user.isSystem && (
        <section className="card card-danger">
          <header className="card-head"><h2>{t('account.deleteCard')}</h2></header>
          <p className="help">{t('account.deleteCardHint')}</p>
          <div className="actions"><button type="button" className="btn btn-danger-ghost" onClick={() => setDeleting(true)}>{t('account.deleteButton')}</button></div>
        </section>
      )}
      {deleting && user.email && <DeleteDialog email={user.email} onClose={() => setDeleting(false)} />}
    </div>
  );
}

// Strona z linku w mailu: kliknięcie linku jest potwierdzeniem (decyzja 2026-10-11), usunięcie od razu.
export function DeleteAccountConfirm() {
  const { logout } = useAuth();
  const { t } = useLang();
  const [state, setState] = useState<{ done?: number; error?: string }>({});
  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('token') ?? '';
    AuthRequests.confirmDelete(token)
      .then((result) => {
        // konto już nie istnieje: wylogowanie czyści token w przeglądarce (bez tego /auth/me dawałoby 401 w kółko)
        setState({ done: result.devices });
        void logout();
      })
      .catch((caught) => setState({ error: message(caught) }));
  }, []);
  return (
    <div className="auth">
      <div className="auth-card">
        <div className="brand brand-big"><span className="brand-mark" /><span className="brand-name">My Home</span></div>
        <h1>{t('account.deleteCard')}</h1>
        {state.done === undefined && !state.error && <p className="help">{t('account.deleting')}</p>}
        {state.done !== undefined && <p className="help">{t('account.deleted')}{state.done ? ` (${t('account.deletedDevices', { n: state.done })})` : ''}.</p>}
        {state.error && <ErrorAlert text={state.error} />}
        <a className="btn btn-primary btn-block" href="/">{t('account.loginPage')}</a>
      </div>
    </div>
  );
}
