import axios from 'axios';

const productionApiUrl = 'https://reachinbox-api-1zw9.onrender.com';
const configuredApiUrl = import.meta.env.VITE_API_URL?.trim().replace(/\/+$/, '');

/** Empty in local dev so Vite proxies /api; production falls back to the deployed API. */
export const apiBaseUrl = configuredApiUrl || (import.meta.env.PROD ? productionApiUrl : '');

axios.defaults.baseURL = apiBaseUrl;
axios.defaults.withCredentials = true;

export function apiUrl(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return apiBaseUrl ? `${apiBaseUrl}${normalized}` : normalized;
}
