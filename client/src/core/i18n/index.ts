// Wersja językowa aplikacji (2026-10-21): polski i angielski bez biblioteki. Słowniki pl.ts i en.ts (te same klucze,
// en sprawdzany typem względem pl), funkcja t(klucz, parametry) z podstawianiem {nazwa}, liczebniki tn() przez
// Intl.PluralRules (pl: one / few / many, en: one / other). Wybór: localStorage chpc.lang; bez wyboru język
// przeglądarki (polski, gdy zaczyna się od „pl”, inaczej angielski). Zalogowane konto ma język w profilu
// (users.language, PUT /auth/me/language): przy logowaniu wygrywa język konta, zmiana z menu zapisuje się w koncie
// (AuthContext, UserMenu). Zmiana rozsyła zdarzenie, więc każdy komponent z useLang() rysuje się od nowa; <html lang>
// ustawia skrypt w client/index.html przed pierwszym rysowaniem i applyLang() po zmianie.
// Formatowanie dat i liczb: locale() daje 'pl-PL' albo 'en-GB' do Intl / toLocaleString.
import { useEffect, useState } from 'react';
import { pl } from './pl';
import { en } from './en';

export type Lang = 'pl' | 'en';
export const LANGS: Lang[] = ['pl', 'en'];
export const LANG_NAMES: Record<Lang, string> = { pl: 'Polski', en: 'English' };

const KEY = 'chpc.lang';
const CHANGE_EVENT = 'chpc-lang-change';
const DICTS: Record<Lang, Record<string, string>> = { pl, en };

export const isLang = (value: unknown): value is Lang => value === 'pl' || value === 'en';

// język przeglądarki: polski tylko dla pl-*, każdy inny → angielski
export const browserLang = (): Lang => (typeof navigator !== 'undefined' && (navigator.language || '').toLowerCase().startsWith('pl') ? 'pl' : 'en');

let current: Lang = (() => {
  try {
    const stored = localStorage.getItem(KEY);
    return isLang(stored) ? stored : browserLang();
  } catch {
    return browserLang();
  }
})();

export const getLang = (): Lang => current;

export function applyLang(lang: Lang) {
  document.documentElement.setAttribute('lang', lang);
  // nazwa karty przeglądarki i skrótu na iPhonie; index.html ma polską, bo przed tym skryptem język nie jest znany
  const name = translate(lang, 'app.name');
  document.title = name;
  document.querySelector('meta[name="apple-mobile-web-app-title"]')?.setAttribute('content', name);
}

export function setLang(lang: Lang) {
  if (!isLang(lang)) return;
  current = lang;
  try {
    localStorage.setItem(KEY, lang);
  } catch {
    // prywatne okno: wybór działa do przeładowania
  }
  applyLang(lang);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export const locale = (lang: Lang = current): string => (lang === 'pl' ? 'pl-PL' : 'en-GB');

export type Params = Record<string, string | number>;

const fill = (text: string, params?: Params) =>
  params ? text.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match)) : text;

// Tekst dla klucza: bieżący język → polski → sam klucz (brak tłumaczenia widać w interfejsie, nic się nie wywraca)
export function translate(lang: Lang, key: string, params?: Params): string {
  const text = DICTS[lang][key] ?? DICTS.pl[key] ?? key;
  return fill(text, params);
}

const rules: Partial<Record<Lang, Intl.PluralRules>> = {};
const pluralRule = (lang: Lang) => (rules[lang] ??= new Intl.PluralRules(locale(lang)));

// Liczebnik: klucz.one / .few / .many / .other z liczbą w {n}; brak formy → .other → .many → .one
export function translatePlural(lang: Lang, key: string, n: number, params?: Params): string {
  const dict = DICTS[lang];
  const form = pluralRule(lang).select(n);
  const text = dict[`${key}.${form}`] ?? dict[`${key}.other`] ?? dict[`${key}.many`] ?? dict[`${key}.one`] ?? DICTS.pl[`${key}.many`] ?? key;
  return fill(text, { n, ...params });
}

export const t = (key: string, params?: Params) => translate(current, key, params);
export const tn = (key: string, n: number, params?: Params) => translatePlural(current, key, n, params);

// Hook: bieżący język i funkcje t / tn; komponent rysuje się od nowa po zmianie języka
export function useLang() {
  const [lang, setState] = useState<Lang>(current);
  useEffect(() => {
    const onChange = () => setState(current);
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => window.removeEventListener(CHANGE_EVENT, onChange);
  }, []);
  return {
    lang,
    locale: locale(lang),
    t: (key: string, params?: Params) => translate(lang, key, params),
    tn: (key: string, n: number, params?: Params) => translatePlural(lang, key, n, params),
  };
}

// po definicjach translate i słowników: nazwa aplikacji w języku wybranym przy poprzedniej wizycie
applyLang(current);
