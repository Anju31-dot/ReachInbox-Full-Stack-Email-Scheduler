import { ChangeEvent, FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { Clock3, ExternalLink, LogOut, Mail, Plus, Search, Send, TriangleAlert } from 'lucide-react';
import { apiUrl } from './api-client';
import { parseRecipientCsv } from './recipient-import';

type Email = {
  id: string;
  recipients: string[];
  subject: string;
  body: string;
  scheduledAt: string;
  sentAt: string | null;
  status: 'SCHEDULED' | 'SENDING' | 'SENT' | 'FAILED';
  error: string | null;
};

type Integrations = {
  etherealConfigured: boolean;
  elasticsearchConfigured: boolean;
  googleOAuth: boolean;
  slackOAuth: boolean;
  slackNotificationsConfigured: boolean;
};

type User = { id: string; email: string; name: string; picture: string | null; queueAdmin: boolean };
type SlackStatus = { connected: boolean; integration: { teamName: string | null; teamId: string; channelId: string | null } | null };
const emptyForm = { recipients: '', subject: '', body: '', scheduledAt: '' };

function App() {
  const [emails, setEmails] = useState<Email[]>([]);
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [slack, setSlack] = useState<SlackStatus | null>(null);
  const [slackChannel, setSlackChannel] = useState('');
  const [slackMessage, setSlackMessage] = useState('');
  const [integrations, setIntegrations] = useState<Integrations | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | Email['status']>('ALL');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [importMessage, setImportMessage] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const requestIdentity = useRef({ fingerprint: '', key: crypto.randomUUID() });

  const loadEmails = useCallback(async (query = '') => {
    try {
      const response = await axios.get<Email[]>(query ? '/api/emails/search' : '/api/emails', { params: query ? { q: query } : undefined });
      setEmails(response.data);
    } catch {
      setError('Cannot reach the backend. Start PostgreSQL, Redis, and the backend server.');
    }
  }, []);

  useEffect(() => {
    const authError = new URLSearchParams(window.location.search).get('authError');
    if (authError) setError(`Authentication could not be completed (${authError}). Check your OAuth app settings and try again.`);
    void axios.get<{ user: Omit<User, 'queueAdmin'>; queueAdmin: boolean }>('/api/auth/me').then(({ data }) => setUser({ ...data.user, queueAdmin: data.queueAdmin })).catch(() => setUser(null)).finally(() => setAuthLoading(false));
    void axios.get<Integrations>('/api/integrations').then(({ data }) => setIntegrations(data)).catch(() => setError('Unable to load integration configuration.'));
  }, []);

  useEffect(() => {
    if (!user) return;
    void loadEmails(search);
    void axios.get<SlackStatus>('/api/slack/status').then(({ data }) => {
      setSlack(data);
      setSlackChannel(data.integration?.channelId || '');
    }).catch(() => setSlack(null));
    const timer = window.setInterval(() => void loadEmails(search), 5000);
    return () => window.clearInterval(timer);
  }, [loadEmails, search, user]);

  async function disconnectSlack() {
    try {
      await axios.delete('/api/slack/connection');
      setSlack({ connected: false, integration: null });
      setSlackChannel('');
      setSlackMessage('Slack disconnected.');
    } catch (reason) {
      if (axios.isAxiosError(reason) && reason.response?.status === 502) {
        setSlack({ connected: false, integration: null });
        setSlackMessage(reason.response.data?.error || 'Slack was removed locally but remote revocation failed.');
      } else {
        setSlackMessage('Could not disconnect Slack.');
      }
    }
  }

  async function saveSlackChannel() {
    try {
      await axios.put('/api/slack/connection', { channelId: slackChannel });
      setSlackMessage('Slack notification channel saved.');
      setSlack((current) => current?.integration ? { ...current, integration: { ...current.integration, channelId: slackChannel } } : current);
    } catch (reason) {
      setSlackMessage(axios.isAxiosError(reason) ? reason.response?.data?.error || 'Could not save Slack channel.' : 'Could not save Slack channel.');
    }
  }

  async function logout() {
    try {
      await axios.post('/api/auth/logout');
      setUser(null);
      setEmails([]);
    } catch {
      setError('Could not end the current session.');
    }
  }

  async function schedule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setLoading(true);
    try {
      const recipients = form.recipients.split(/[\s,;]+/).map((address) => address.trim()).filter(Boolean);
      const payload = { ...form, recipients, scheduledAt: new Date(form.scheduledAt).toISOString() };
      const fingerprint = JSON.stringify(payload);
      if (requestIdentity.current.fingerprint !== fingerprint) {
        requestIdentity.current = { fingerprint, key: crypto.randomUUID() };
      }
      await axios.post('/api/emails', payload, { headers: { 'Idempotency-Key': requestIdentity.current.key } });
      setForm(emptyForm);
      requestIdentity.current = { fingerprint: '', key: crypto.randomUUID() };
      await loadEmails(search);
    } catch (reason) {
      setError(axios.isAxiosError(reason) ? reason.response?.data?.error || 'Could not schedule email.' : 'Could not schedule email.');
    } finally {
      setLoading(false);
    }
  }

  async function importRecipients(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.csv')) {
      setImportMessage('Choose a CSV file.');
      return;
    }
    try {
      const result = parseRecipientCsv(await file.text());
      if (!result.recipients.length) {
        setImportMessage('No valid email addresses were found in that CSV.');
        return;
      }
      setForm((current) => ({
        ...current,
        recipients: [...new Set([
          ...current.recipients.split(/[\s,;]+/).map((address) => address.trim().toLowerCase()).filter(Boolean),
          ...result.recipients,
        ])].join(', '),
      }));
      setImportMessage(`${result.recipients.length} address${result.recipients.length === 1 ? '' : 'es'} imported${result.invalid.length ? `; skipped ${result.invalid.length} invalid value${result.invalid.length === 1 ? '' : 's'}` : ''}.`);
    } catch {
      setImportMessage('Could not read the selected CSV file.');
    }
  }

  const stats = {
    total: emails.length,
    scheduled: emails.filter((email) => email.status === 'SCHEDULED').length,
    sent: emails.filter((email) => email.status === 'SENT').length,
    failed: emails.filter((email) => email.status === 'FAILED').length,
  };
  const visibleEmails = statusFilter === 'ALL' ? emails : emails.filter((email) => email.status === statusFilter);

  if (authLoading) return <main className="auth-shell"><div className="card auth-card">Checking your session…</div></main>;
  if (!user) return (
    <main className="auth-shell">
      <section className="card auth-card">
        <span className="brand-icon"><Mail size={19} /></span>
        <p className="eyebrow">REACHINBOX SCHEDULER</p>
        <h1>Schedule with confidence.</h1>
        <p className="muted">Sign in with Google to manage your email queue and workspace integrations.</p>
        {error && <div className="error-banner">{error}</div>}
        <a className="primary-button login-button" href={apiUrl('/api/auth/google')}>Continue with Google <ExternalLink size={15} /></a>
        {!integrations?.googleOAuth && <p className="integration-footnote">Google OAuth is not configured on the backend.</p>}
      </section>
    </main>
  );

  return (
    <main className="shell">
      <header className="topbar">
        <a className="brand" href="#"><span className="brand-icon"><Mail size={19} /></span>ReachInbox<span className="brand-subtitle">SCHEDULER</span></a>
        <div className="user-menu">{user.picture && <img src={user.picture} alt="" />}<span>{user.name}</span>{user.queueAdmin && <a className="queue-link" href={apiUrl('/admin/queues')} target="_blank" rel="noreferrer">Queue monitor <span>↗</span></a>}<button className="icon-button" onClick={() => void logout()} aria-label="Sign out"><LogOut size={15} /></button></div>
      </header>
      <section className="intro">
        <div><p className="eyebrow">EMAIL CAMPAIGNS</p><h1>Scheduled emails</h1><p className="muted">Compose once. Deliver at the right time.</p></div>
        <div className="status-live"><span /> LIVE QUEUE</div>
      </section>
      <section className="stats">
        <Stat label="Total emails" value={stats.total} icon={<Mail />} />
        <Stat label="Scheduled" value={stats.scheduled} icon={<Clock3 />} />
        <Stat label="Sent" value={stats.sent} icon={<Send />} />
        <Stat label="Failed" value={stats.failed} icon={<TriangleAlert />} />
      </section>
      <section className="content-grid">
        <form className="compose card" onSubmit={schedule}>
          <div className="card-heading"><div><span className="heading-icon"><Plus size={17} /></span><h2>Compose email</h2></div><span className="required">ALL FIELDS REQUIRED</span></div>
          {error && <div className="error-banner">{error}</div>}
          {integrations && !integrations.etherealConfigured && <div className="notice">Add ETHEREAL_USER and ETHEREAL_PASS to backend/.env to send real test emails.</div>}
          <label>Recipients <span>Separate addresses with commas or spaces</span>
            <textarea required rows={3} placeholder="alex@example.com, sam@example.com" value={form.recipients} onChange={(event) => setForm({ ...form, recipients: event.target.value })} />
            <input ref={fileInput} aria-label="Import recipients from CSV" className="visually-hidden" type="file" accept=".csv,text/csv" onChange={(event) => void importRecipients(event)} />
            <button className="secondary-button import-button" type="button" onClick={() => fileInput.current?.click()}>Import CSV</button>
            {importMessage && <span className="import-message" role="status">{importMessage}</span>}
          </label>
          <label>Subject<input required maxLength={998} placeholder="A clear, concise subject" value={form.subject} onChange={(event) => setForm({ ...form, subject: event.target.value })} /></label>
          <label>Message<textarea required rows={6} maxLength={100000} placeholder="Write your email..." value={form.body} onChange={(event) => setForm({ ...form, body: event.target.value })} /></label>
          <label>Send at<input required type="datetime-local" value={form.scheduledAt} min={localDateTimeString(new Date(Date.now() + 60000))} onChange={(event) => setForm({ ...form, scheduledAt: event.target.value })} /></label>
          <button className="primary-button" type="submit" disabled={loading}><Clock3 size={16} />{loading ? 'Scheduling…' : 'Schedule email'}</button>
        </form>
        <section className="emails card">
          <div className="card-heading"><div><span className="heading-icon"><Mail size={17} /></span><h2>Recent emails</h2></div><span className="count">{emails.length}</span></div>
          <div className="search"><Search size={16} /><input placeholder="Search subject, message, recipient" value={search} onChange={(event) => setSearch(event.target.value)} /></div>
          <div className="status-filters">{(['ALL', 'SCHEDULED', 'SENDING', 'SENT', 'FAILED'] as const).map((status) => <button className={statusFilter === status ? 'active' : ''} key={status} onClick={() => setStatusFilter(status)}>{status === 'ALL' ? 'All' : status.toLowerCase()}</button>)}</div>
          <div className="slack-panel">
            <div className="slack-title"><strong>Slack notifications</strong>{slack?.connected ? <span className="slack-connected">Connected {slack.integration?.teamName || ''}</span> : <span className="muted-small">Not connected</span>}</div>
            {slack?.connected ? <>
              <div className="slack-controls"><input value={slackChannel} onChange={(event) => setSlackChannel(event.target.value)} placeholder="Channel ID (for example C0123456789)" /><button onClick={() => void saveSlackChannel()}>Save channel</button><button className="disconnect" onClick={() => void disconnectSlack()}>Disconnect</button></div>
              <span className="muted-small">Invite the ReachInbox bot to the channel before saving its ID.</span>
            </> : integrations?.slackOAuth
              ? <a className="slack-connect" href={apiUrl('/api/slack/connect')}>Connect a Slack workspace <ExternalLink size={13} /></a>
              : <span className="muted-small">Add Slack OAuth credentials to enable workspace connection.</span>}
            {slackMessage && <span className="muted-small">{slackMessage}</span>}
          </div>
          <div className="email-list">
            {visibleEmails.length === 0 ? <div className="empty"><Mail size={25} /><strong>No emails found</strong><span>Try another status or search term.</span></div> : visibleEmails.map((email) => (
              <article className="email-row" key={email.id}>
                <div className="email-top"><h3>{email.subject}</h3><Status status={email.status} /></div>
                <p className="recipients">{email.recipients.join(', ')}</p>
                <p className="email-snippet">{email.body}</p>
                <div className="email-bottom"><span>{email.status === 'SENT' && email.sentAt ? `Sent ${formatDate(email.sentAt)}` : `Scheduled ${formatDate(email.scheduledAt)}`}</span>{email.error && <span className="failure" title={email.error}>{email.error}</span>}</div>
              </article>
            ))}
          </div>
          <p className="integration-footnote">Elasticsearch: {integrations?.elasticsearchConfigured ? 'configured' : 'not configured'} · Google OAuth: {integrations?.googleOAuth ? 'configured' : 'not configured'}</p>
        </section>
      </section>
      <footer>Powered by BullMQ · Redis · PostgreSQL</footer>
    </main>
  );
}

function Stat({ label, value, icon }: { label: string; value: number; icon: React.ReactNode }) {
  return <div className="stat card"><span className="stat-icon">{icon}</span><div><span>{label}</span><strong>{value}</strong></div></div>;
}

function Status({ status }: { status: Email['status'] }) {
  return <span className={`badge ${status.toLowerCase()}`}><i />{status.toLowerCase()}</span>;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function localDateTimeString(date: Date): string {
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return localDate.toISOString().slice(0, 16);
}

export default App;
