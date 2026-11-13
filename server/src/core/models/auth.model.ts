// Logowanie (2026-10-11): kody i linki z maila (auth_codes) oraz sesje (sessions). W bazie są tylko skróty
// SHA-256 kodu, linku i tokenu sesji, nie same wartości. Oba rodzaje dokumentów wygasają same (indeks TTL).
// Konto system (od 2026-11-13, kod z maila zamiast hasła, auth.service.ts): jego kod, ślady wysłanych kodów i blokada
// po błędnych kodach też są tu, bo czyta je i zmienia także polecenie awaryjne (core/cli.ts), osobny proces.
import mongoose, { Schema } from 'mongoose';

/** login: logowanie i rejestracja; email-change: nowy adres; delete-account: potwierdzenie usunięcia konta;
 *  konto system (email: 'system'): system-login = kod (ważny 5 min), system-sent = ślad wysłanego kodu do limitu
 *  na godzinę (expiresAt = wysłanie + 1 h), system-lock = blokada po błędnych kodach (do expiresAt) */
export type AuthCodePurpose = 'login' | 'email-change' | 'delete-account' | 'system-login' | 'system-sent' | 'system-lock';
export const AUTH_CODE_PURPOSES: AuthCodePurpose[] = ['login', 'email-change', 'delete-account', 'system-login', 'system-sent', 'system-lock'];
/** jak dotarł kod konta system: mail, dziennik serwera (bez poczty albo adresu), polecenie awaryjne */
export type SystemCodeDelivery = 'mail' | 'log' | 'emergency';

export interface AuthCodeEntry {
  _id: mongoose.Types.ObjectId;
  purpose: AuthCodePurpose;
  /** adres, na który poszedł mail (przy zmianie e-maila nowy adres); dla konta system napis 'system' */
  email: string;
  /** konto, którego dotyczy (zmiana e-maila, usunięcie konta) */
  userId?: string;
  codeHash?: string;
  tokenHash?: string;
  attempts: number;
  /** konto system: adres IP, z którego zamówiono kod (system-login, system-sent) albo wpisano ostatni błędny (system-lock) */
  ip?: string;
  /** konto system: jak dotarł kod */
  delivery?: SystemCodeDelivery;
  expiresAt: Date;
  createdAt: Date;
}

const AuthCodeSchema = new Schema<AuthCodeEntry>(
  {
    purpose: { type: String, enum: AUTH_CODE_PURPOSES, required: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    userId: { type: String },
    codeHash: { type: String },
    tokenHash: { type: String },
    attempts: { type: Number, default: 0 },
    ip: { type: String },
    delivery: { type: String, enum: ['mail', 'log', 'emergency'] },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'auth_codes' },
);
AuthCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
AuthCodeSchema.index({ purpose: 1, email: 1, createdAt: -1 });
AuthCodeSchema.index({ tokenHash: 1 });

export const AuthCodeModel = mongoose.model<AuthCodeEntry>('AuthCode', AuthCodeSchema);

export interface SessionEntry {
  _id: mongoose.Types.ObjectId;
  tokenHash: string;
  userId: string;
  /** „Zapamiętać na 90 dni”: stałe 90 dni od zalogowania; bez tego 24 h od ostatniego użycia */
  remember: boolean;
  /** wersja demo (2026-10-21): sesja na koncie właściciela z DEMO_OWNER_EMAIL, tylko odczyt, 2 h bez przedłużania */
  demo?: boolean;
  expiresAt: Date;
  lastSeenAt: Date;
  createdAt: Date;
}

const SessionSchema = new Schema<SessionEntry>(
  {
    tokenHash: { type: String, required: true, unique: true },
    userId: { type: String, required: true },
    remember: { type: Boolean, default: false },
    demo: { type: Boolean, default: false },
    expiresAt: { type: Date, required: true },
    lastSeenAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'sessions' },
);
SessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
SessionSchema.index({ userId: 1 });

export const SessionModel = mongoose.model<SessionEntry>('Session', SessionSchema);
