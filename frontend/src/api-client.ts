import axios from 'axios';

/** Production backend origin (no trailing slash). Empty in local dev — Vite proxies /api. */
export const apiBaseUrl = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') || '';

axios.defaults.baseURL = apiBaseUrl;
axios.defaults.withCredentials = true;

export function apiUrl(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return apiBaseUrl ? `${apiBaseUrl}${normalized}` : normalized;
}
