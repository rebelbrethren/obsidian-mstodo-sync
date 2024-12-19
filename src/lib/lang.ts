import en from './locale/en.json';
import zhCN from './locale/zh-cn.json';

export type Translations = Record<string, string>;

const localeMap: Record<string, Translations> = {
  en,
  'en-GB': en, // Yes I know it's not the same. But it's close enough.
  zh: zhCN,
};

const lang = globalThis.localStorage.getItem('language');
const locale = localeMap[lang ?? 'en'];

export function t(string_: string): string {
  if (!locale) {
    console.error('Error: locale not found', lang);
  }

  return locale?.[string_] || string_;
}
