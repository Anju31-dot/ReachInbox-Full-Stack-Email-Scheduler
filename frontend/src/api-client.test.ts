import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('api client configuration', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('uses the production API when VITE_API_URL is missing', async () => {
    vi.stubEnv('PROD', true);
    vi.stubEnv('VITE_API_URL', '');

    const { apiBaseUrl, apiUrl } = await import('./api-client');

    expect(apiBaseUrl).toBe('https://reachinbox-api-1zw9.onrender.com');
    expect(apiUrl('/api/auth/google')).toBe('https://reachinbox-api-1zw9.onrender.com/api/auth/google');
  }, 15000);

  it('prefers the configured API URL and removes trailing slashes', async () => {
    vi.stubEnv('PROD', true);
    vi.stubEnv('VITE_API_URL', 'https://api.example.com///');

    const { apiBaseUrl } = await import('./api-client');

    expect(apiBaseUrl).toBe('https://api.example.com');
  });

  it('keeps relative API paths in development for the Vite proxy', async () => {
    vi.stubEnv('PROD', false);
    vi.stubEnv('VITE_API_URL', '');

    const { apiBaseUrl, apiUrl } = await import('./api-client');

    expect(apiBaseUrl).toBe('');
    expect(apiUrl('/api/auth/google')).toBe('/api/auth/google');
  });
});
