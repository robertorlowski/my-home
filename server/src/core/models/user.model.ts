// Konta użytkowników (kolekcja users, od 2026-10-11): logowanie kodem z maila, dane osobowe, jedna lokalizacja
// konta i układ listy sterowników (szachownica i ukryte kafelki, osobno dla każdego użytkownika). Użytkownik systemowy
// (login „system”, od 2026-11-13 kod z maila na adres SYSTEM_EMAIL z ustawień zamiast hasła SYSTEM_PASSWORD) to
// dokument z isSystem i bez e-maila; widzi wszystkie sterowniki.
import mongoose, { Schema } from 'mongoose';

export interface UserLocation {
  lat: number;
  lng: number;
}

export interface UserNotificationRule {
  rootId: string;
  /** klucze zdarzeń z katalogu rodzaju (PUSH_EVENTS w push.service.ts) */
  events: string[];
}

export interface UserNotifications {
  rules: UserNotificationRule[];
  quietFrom?: string | null;
  quietTo?: string | null;
}

export interface UserEntry {
  _id: mongoose.Types.ObjectId;
  /** małe litery; brak tylko u użytkownika systemowego */
  email?: string;
  isSystem?: boolean;
  /** tylko w pamięci (sesja demo, auth.service.ts): dokument właściciela widziany w trybie tylko do odczytu */
  isDemo?: boolean;
  firstName?: string;
  lastName?: string;
  street?: string;
  postalCode?: string;
  city?: string;
  country?: string;
  location?: UserLocation | null;
  /** język aplikacji i maili konta (2026-10-21): 'pl' albo 'en'; pusty = nie wybrano (klient bierze język przeglądarki) */
  language?: string;
  /** układ listy /devices: pola szachownicy (Root ID sterownika, id kafelka pogody albo null = puste pole) */
  deviceOrder?: (string | null)[];
  /** kafelki ukryte na liście tego konta (tile-layout.service.ts) */
  hiddenTiles?: string[];
  /** sterowniki pokazywane na liście tego konta jako kafelek prosty (duże przyciski; włącznik, 2026-10-20) */
  simpleTiles?: string[];
  /** powiadomienia Web Push (2026-10-21, core/services/push.service.ts): zdarzenia wybrane dla sterowników
   *  i cisza nocna (HH:mm, w Warszawie; pilne zdarzenia — błąd, alarm — idą mimo ciszy) */
  notifications?: UserNotifications | null;
  createdAt: Date;
  updatedAt: Date;
}

const UserSchema = new Schema<UserEntry>(
  {
    email: { type: String, trim: true, lowercase: true },
    isSystem: { type: Boolean },
    firstName: { type: String, trim: true, default: '' },
    lastName: { type: String, trim: true, default: '' },
    street: { type: String, trim: true, default: '' },
    postalCode: { type: String, trim: true, default: '' },
    city: { type: String, trim: true, default: '' },
    country: { type: String, trim: true, default: '' },
    location: { type: new Schema<UserLocation>({ lat: Number, lng: Number }, { _id: false }), default: null },
    language: { type: String, default: '' },
    deviceOrder: { type: [String], default: undefined },
    hiddenTiles: { type: [String], default: undefined },
    simpleTiles: { type: [String], default: undefined },
    notifications: {
      type: new Schema<UserNotifications>({
        rules: { type: [new Schema<UserNotificationRule>({ rootId: { type: String, required: true }, events: { type: [String], default: [] } }, { _id: false })], default: [] },
        quietFrom: { type: String, default: null },
        quietTo: { type: String, default: null },
      }, { _id: false }),
      default: null,
    },
  },
  { timestamps: true, collection: 'users' },
);

// e-mail unikalny wśród kont z e-mailem (użytkownik systemowy go nie ma)
UserSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: 'string' } } });

export const UserModel = mongoose.model<UserEntry>('User', UserSchema);
