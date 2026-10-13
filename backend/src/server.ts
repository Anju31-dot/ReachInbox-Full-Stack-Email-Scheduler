import 'dotenv/config';
import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import { Queue, Worker, Job, DelayedError, UnrecoverableError } from 'bullmq';
import IORedis from 'ioredis';
import nodemailer from 'nodemailer';
import { Prisma, PrismaClient } from '@prisma/client';
import { Client as ElasticsearchClient } from '@elastic/elasticsearch';
import { ExpressAdapter } from '@bull-board/express';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { randomUUID } from 'node:crypto';
import { createCipheriv, createDecipheriv, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { URLSearchParams } from 'node:url';
import { createIdempotencyKey, emailSchema, parseRateReservation, positiveInteger } from './email-scheduling';

declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

const port = Number(process.env.PORT || 5000);
const concurrency = positiveInteger(process.env.WORKER_CONCURRENCY, 5);
const minSendDelayMs = positiveInteger(process.env.MIN_SEND_DELAY_SECONDS, 2) * 1000;
const hourlyLimit = positiveInteger(process.env.MAX_HOURLY_RATE_PER_SENDER, 10);
const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
const encryptionSecret = process.env.JWT_SECRET;
const queueAdmins = new Set((process.env.QUEUE_DASHBOARD_ADMIN_EMAILS || '').split(',').map((email) => email.trim().toLowerCase()).filter(Boolean));
const queueName = 'scheduled-emails';
const enableHttp = process.env.ENABLE_HTTP !== 'false';
const enableWorker = process.env.ENABLE_WORKER !== 'false';
const prisma = new PrismaClient();

function createRedisConnection(): IORedis {
  const redisUrl = process.env.REDIS_URL?.trim();
  if (redisUrl) {
    return new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      tls: redisUrl.startsWith('rediss://') ? {} : undefined,
    });
  }
  return new IORedis({
    host: process.env.REDIS_HOST || 'localhost',
    port: positiveInteger(process.env.REDIS_PORT, 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}

const redis = createRedisConnection();

function sessionCookieOptions(path = '/'): {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'lax' | 'none';
  path: string;
  maxAge?: number;
} {
  const production = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: production,
    sameSite: production ? 'none' : 'lax',
    path,
  };
}

const queue = new Queue(queueName, { connection: redis });
const app = express();
app.set('trust proxy', 1);
app.use(cors({ origin: frontendUrl, credentials: true }));
app.use(express.json({ limit: '1mb' }));

function googleOAuthClient(): OAuth2Client {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Google OAuth credentials are not configured.');
  return new OAuth2Client(clientId, clientSecret, process.env.GOOGLE_CALLBACK_URL || 'http://localhost:5000/api/auth/google/callback');
}

function slackRedirectUri(): string {
  return process.env.SLACK_REDIRECT_URI || 'http://localhost:5000/api/slack/callback';
}

function sessionSecret(): string {
  if (!encryptionSecret || encryptionSecret.length < 32 || encryptionSecret === 'reachinbox_super_secret_jwt_key_2026') {
    throw new Error('Set JWT_SECRET to a unique random value of at least 32 characters.');
  }
  return encryptionSecret;
}

function sessionCookie(req: Request): string | undefined {
  return readCookie(req, 'reachinbox_session');
}

function readCookie(req: Request, name: string): string | undefined {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return undefined;
  const match = cookieHeader.split(';').map((item) => item.trim()).find((item) => item.startsWith(`${name}=`));
  if (!match) return undefined;
  try {
    return decodeURIComponent(match.slice(name.length + 1));
  } catch {
    return undefined;
  }
}

async function setSessionCookie(res: Response, userId: string): Promise<void> {
  const token = randomBytes(32).toString('base64url');
  await redis.set(`session:${createHash('sha256').update(token).digest('hex')}`, userId, 'EX', 7 * 24 * 60 * 60);
  res.cookie('reachinbox_session', token, {
    ...sessionCookieOptions('/'),
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

function clearSessionCookie(res: Response): void {
  res.clearCookie('reachinbox_session', sessionCookieOptions('/'));
}

async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = sessionCookie(req);
  if (!token) {
    res.status(401).json({ error: 'Sign in with Google to continue.' });
    return;
  }
  try {
    const userId = await redis.get(`session:${createHash('sha256').update(token).digest('hex')}`);
    if (!userId) {
      clearSessionCookie(res);
      res.status(401).json({ error: 'Your session is invalid or expired. Sign in again.' });
      return;
    }
    req.userId = userId;
    next();
  } catch (error) {
    console.error('Session lookup failed:', error);
    res.status(503).json({ error: 'Session service is temporarily unavailable.' });
  }
}

function verifySameOrigin(req: Request, res: Response, next: NextFunction): void {
  const origin = req.get('origin');
  if (origin && origin !== new URL(frontendUrl).origin) {
    res.status(403).json({ error: 'Cross-origin request rejected.' });
    return;
  }
  next();
}

async function slackOAuthExchange(code: string): Promise<{
  ok?: boolean;
  error?: string;
  access_token?: string;
  bot_user_id?: string;
  team?: { id?: string; name?: string };
}> {
  const clientId = process.env.SLACK_CLIENT_ID;
  const clientSecret = process.env.SLACK_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Slack OAuth credentials are not configured.');
  const response = await fetch('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: slackRedirectUri(),
    }),
  });
  if (!response.ok) throw new Error(`Slack OAuth returned HTTP ${response.status}.`);
  return await response.json() as {
    ok?: boolean;
    error?: string;
    access_token?: string;
    bot_user_id?: string;
    team?: { id?: string; name?: string };
  };
}

function encryptionKey(): Buffer {
  return createHash('sha256').update(sessionSecret()).digest();
}

function encryptSecret(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}

function decryptSecret(value: string): string {
  const [iv, tag, encrypted] = value.split('.');
  if (!iv || !tag || !encrypted) throw new Error('Stored Slack access token has an invalid format.');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8');
}

const scheduler = new ExpressAdapter();
scheduler.setBasePath('/admin/queues');
createBullBoard({ queues: [new BullMQAdapter(queue)], serverAdapter: scheduler });

app.get('/api/auth/google', async (_req, res, next) => {
  try {
    const client = googleOAuthClient();
    const state = randomUUID();
    const browserNonce = randomBytes(32).toString('base64url');
    await redis.set(`oauth:google:${state}`, browserNonce, 'EX', 600, 'NX');
    res.cookie('reachinbox_google_oauth', browserNonce, {
      ...sessionCookieOptions('/api/auth/google/callback'),
      maxAge: 10 * 60 * 1000,
    });
    res.redirect(client.generateAuthUrl({
      access_type: 'online',
      prompt: 'select_account',
      scope: ['openid', 'email', 'profile'],
      state,
    }));
  } catch (error) {
    next(error);
  }
});

app.get('/api/auth/google/callback', async (req, res) => {
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  try {
    const expectedNonce = state ? await redis.getdel(`oauth:google:${state}`) : null;
    const actualNonce = readCookie(req, 'reachinbox_google_oauth');
    res.clearCookie('reachinbox_google_oauth', sessionCookieOptions('/api/auth/google/callback'));
    if (!code || !expectedNonce || !actualNonce || expectedNonce.length !== actualNonce.length
      || !timingSafeEqual(Buffer.from(expectedNonce), Buffer.from(actualNonce))) {
      res.redirect(`${frontendUrl}/?authError=google_state`);
      return;
    }
    const client = googleOAuthClient();
    const { tokens } = await client.getToken(code);
    if (!tokens.id_token) throw new Error('Google OAuth returned no ID token.');
    const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: process.env.GOOGLE_CLIENT_ID });
    const identity = ticket.getPayload();
    if (!identity?.sub || !identity.email || identity.email_verified !== true) {
      throw new Error('Google account is missing a verified email address.');
    }
    const user = await prisma.user.upsert({
      where: { googleId: identity.sub },
      create: { googleId: identity.sub, email: identity.email, name: identity.name || identity.email, picture: identity.picture },
      update: { email: identity.email, name: identity.name || identity.email, picture: identity.picture },
    });
    await setSessionCookie(res, user.id);
    res.redirect(frontendUrl);
  } catch (error) {
    console.error('Google OAuth callback failed:', error);
    res.redirect(`${frontendUrl}/?authError=google_callback`);
  }
});

app.get('/api/auth/me', requireAuth, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId! },
      select: { id: true, email: true, name: true, picture: true },
    });
    if (!user) {
      clearSessionCookie(res);
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    res.json({ user, queueAdmin: queueAdmins.has(user.email.toLowerCase()) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/logout', requireAuth, verifySameOrigin, async (req, res, next) => {
  try {
    const token = sessionCookie(req);
    if (token) await redis.del(`session:${createHash('sha256').update(token).digest('hex')}`);
    clearSessionCookie(res);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get('/api/slack/connect', requireAuth, async (req, res, next) => {
  try {
    const clientId = process.env.SLACK_CLIENT_ID;
    if (!clientId || !process.env.SLACK_CLIENT_SECRET) {
      res.status(503).json({ error: 'Slack OAuth credentials are not configured.' });
      return;
    }
    const state = randomUUID();
    const browserNonce = randomBytes(32).toString('base64url');
    await redis.set(`oauth:slack:${state}`, JSON.stringify({ userId: req.userId, browserNonce }), 'EX', 600, 'NX');
    res.cookie('reachinbox_slack_oauth', browserNonce, {
      ...sessionCookieOptions('/api/slack/callback'),
      maxAge: 10 * 60 * 1000,
    });
    const params = new URLSearchParams({
      client_id: clientId,
      scope: 'chat:write',
      redirect_uri: slackRedirectUri(),
      state,
    });
    res.redirect(`https://slack.com/oauth/v2/authorize?${params.toString()}`);
  } catch (error) {
    next(error);
  }
});

app.get('/api/slack/callback', async (req, res) => {
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  try {
    const oauthValue = state ? await redis.getdel(`oauth:slack:${state}`) : null;
    const actualNonce = readCookie(req, 'reachinbox_slack_oauth');
    res.clearCookie('reachinbox_slack_oauth', sessionCookieOptions('/api/slack/callback'));
    const savedState = oauthValue ? JSON.parse(oauthValue) as { userId?: string; browserNonce?: string } : null;
    const userId = savedState?.userId;
    const expectedNonce = savedState?.browserNonce || '';
    if (!code || !userId || !actualNonce || expectedNonce.length !== actualNonce.length
      || !timingSafeEqual(Buffer.from(expectedNonce), Buffer.from(actualNonce))) {
      res.redirect(`${frontendUrl}/?authError=slack_state`);
      return;
    }
    const result = await slackOAuthExchange(code);
    if (!result.ok || !result.access_token || !result.team?.id) {
      throw new Error(`Slack OAuth rejected the connection: ${result.error || 'incomplete response'}.`);
    }
    await prisma.slackIntegration.upsert({
      where: { userId },
      create: {
        userId,
        teamId: result.team.id,
        teamName: result.team.name,
        botUserId: result.bot_user_id,
        encryptedAccessToken: encryptSecret(result.access_token),
      },
      update: {
        teamId: result.team.id,
        teamName: result.team.name,
        botUserId: result.bot_user_id,
        encryptedAccessToken: encryptSecret(result.access_token),
      },
    });
    res.redirect(`${frontendUrl}/?slack=connected`);
  } catch (error) {
    console.error('Slack OAuth callback failed:', error);
    res.redirect(`${frontendUrl}/?authError=slack_callback`);
  }
});

app.get('/api/slack/status', requireAuth, async (req, res, next) => {
  try {
    const integration = await prisma.slackIntegration.findUnique({
      where: { userId: req.userId! },
      select: { teamId: true, teamName: true, channelId: true, updatedAt: true },
    });
    res.json({ connected: Boolean(integration), integration });
  } catch (error) {
    next(error);
  }
});

app.put('/api/slack/connection', requireAuth, verifySameOrigin, async (req, res, next) => {
  const channelId = typeof req.body?.channelId === 'string' ? req.body.channelId.trim() : '';
  if (!/^[A-Z0-9]{2,32}$/.test(channelId)) {
    res.status(400).json({ error: 'Enter a Slack channel ID, for example C0123456789.' });
    return;
  }
  try {
    const result = await prisma.slackIntegration.updateMany({
      where: { userId: req.userId! },
      data: { channelId },
    });
    if (!result.count) {
      res.status(404).json({ error: 'Connect a Slack workspace before setting a channel.' });
      return;
    }
    res.json({ channelId });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/slack/connection', requireAuth, verifySameOrigin, async (req, res, next) => {
  try {
    const integration = await prisma.slackIntegration.findUnique({ where: { userId: req.userId! } });
    if (!integration) {
      res.status(204).end();
      return;
    }
    await prisma.slackIntegration.delete({ where: { userId: req.userId! } });
    const token = decryptSecret(integration.encryptedAccessToken);
    try {
      const revoked = await fetch('https://slack.com/api/auth.revoke', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: '',
        signal: AbortSignal.timeout(5000),
      });
      const result = await revoked.json() as { ok?: boolean; error?: string };
      if (!revoked.ok || !result.ok) throw new Error(result.error || `HTTP ${revoked.status}`);
    } catch (error) {
      console.error('Slack connection was removed locally but its remote token could not be revoked:', error);
      res.status(502).json({ error: 'Slack was disconnected locally, but remote token revocation failed. Revoke the app token in Slack settings.' });
      return;
    }
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get('/api/health', async (_req, res) => {
  try {
    await Promise.all([prisma.$queryRaw`SELECT 1`, redis.ping()]);
    res.json({ status: 'ok', services: { postgres: 'ok', redis: 'ok' } });
  } catch {
    res.status(503).json({ status: 'degraded', message: 'PostgreSQL or Redis is unavailable.' });
  }
});

app.get('/api/integrations', (_req, res) => {
  res.json({
    etherealConfigured: Boolean(process.env.ETHEREAL_USER && process.env.ETHEREAL_PASS),
    elasticsearchConfigured: Boolean(process.env.ELASTICSEARCH_NODE),
    googleOAuth: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    slackOAuth: Boolean(process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET),
    slackNotificationsConfigured: Boolean(process.env.SLACK_WEBHOOK_URL || (process.env.SLACK_BOT_TOKEN && process.env.SLACK_NOTIFICATION_CHANNEL)),
  });
});

app.use('/api/emails', requireAuth, verifySameOrigin);
app.get('/api/emails', async (req, res, next) => {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status.toUpperCase() : undefined;
    if (status && !['SCHEDULED', 'SENDING', 'SENT', 'FAILED'].includes(status)) {
      res.status(400).json({ error: 'Invalid email status.' });
      return;
    }
    const emails = await prisma.email.findMany({
      where: { userId: req.userId!, ...(status ? { status: status as 'SCHEDULED' | 'SENDING' | 'SENT' | 'FAILED' } : {}) },
      orderBy: [{ scheduledAt: 'desc' }, { createdAt: 'desc' }],
      take: 200,
    });
    res.json(emails);
  } catch (error) {
    next(error);
  }
});

app.post('/api/emails', async (req, res, next) => {
  const parsed = emailSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid email request.' });
    return;
  }
  const input = parsed.data;
  const scheduledAt = new Date(input.scheduledAt);
  if (scheduledAt.getTime() <= Date.now()) {
    res.status(400).json({ error: 'Scheduled send time must be in the future.' });
    return;
  }

  const clientKey = req.header('Idempotency-Key') || randomUUID();
  const idempotencyKey = createIdempotencyKey(req.userId!, clientKey);
  try {
    const existing = await prisma.email.findFirst({ where: { userId: req.userId!, idempotencyKey } });
    if (existing) {
      await enqueue(existing);
      res.status(200).json(existing);
      return;
    }
    const owner = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! }, select: { email: true, name: true } });
    const email = await prisma.email.create({
      data: {
        userId: req.userId!,
        idempotencyKey,
        recipients: [...new Set(input.recipients.map((address) => address.trim().toLowerCase()))],
        subject: input.subject,
        body: input.body,
        scheduledAt,
        senderEmail: owner.email,
        senderName: owner.name,
      },
    });
    await enqueue(email);
    await indexEmail(email.id).catch((error: unknown) => console.error('Elasticsearch indexing failed:', error));
    res.status(201).json(email);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const duplicate = await prisma.email.findFirst({ where: { userId: req.userId!, idempotencyKey } });
      if (duplicate) {
        await enqueue(duplicate);
        res.status(200).json(duplicate);
        return;
      }
      res.status(409).json({ error: 'Idempotency key conflicts with another operation.' });
      return;
    }
    next(error);
  }
});

app.get('/api/emails/search', async (req, res, next) => {
  const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!query) {
    res.status(400).json({ error: 'A non-empty q search parameter is required.' });
    return;
  }
  try {
    const node = process.env.ELASTICSEARCH_NODE;
    if (node) {
      try {
        const result = await elasticsearchClient(node).search<{ subject: string; body: string; recipients: string[] }>({
          index: process.env.ELASTICSEARCH_INDEX || 'emails',
          query: {
            bool: {
              must: [{ multi_match: { query, fields: ['subject', 'body', 'recipients'] } }],
              filter: [{ term: { 'userId.keyword': req.userId! } }],
            },
          },
          size: 100,
        });
        const ids = result.hits.hits.map((hit) => hit._id).filter((id): id is string => typeof id === 'string');
        const matches = ids.length ? await prisma.email.findMany({ where: { userId: req.userId!, id: { in: ids } } }) : [];
        const byId = new Map(matches.map((email) => [email.id, email]));
        res.json(ids.map((id) => byId.get(id)).filter((email): email is NonNullable<typeof email> => Boolean(email)));
        return;
      } catch (error) {
        console.error('Elasticsearch search failed; using PostgreSQL search:', error);
        res.setHeader('X-Search-Source', 'postgres-fallback');
      }
    }
    const emails = await prisma.email.findMany({
      where: { userId: req.userId!, OR: [{ subject: { contains: query, mode: 'insensitive' } }, { body: { contains: query, mode: 'insensitive' } }, { recipients: { has: query.toLowerCase() } }] },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    res.json(emails);
  } catch (error) {
    next(error);
  }
});

async function requireQueueAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.userId) {
    res.status(401).json({ error: 'Sign in with Google to continue.' });
    return;
  }
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId }, select: { email: true } });
    if (!user || !queueAdmins.has(user.email.toLowerCase())) {
      res.status(403).json({ error: 'Queue dashboard access is restricted to configured administrators.' });
      return;
    }
    next();
  } catch (error) {
    next(error);
  }
}

app.use('/admin/queues', requireAuth, requireQueueAdmin);
app.use('/admin/queues', scheduler.getRouter());

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error('API request failed:', error);
  res.status(500).json({ error: 'The request could not be completed.' });
});

async function enqueue(email: { id: string; scheduledAt: Date }): Promise<void> {
  await queue.add('send-email', { emailId: email.id }, {
    jobId: email.id,
    delay: Math.max(0, email.scheduledAt.getTime() - Date.now()),
    attempts: 1,
    removeOnComplete: false,
    removeOnFail: false,
  });
}

const reservationScript = `
local now = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local spacing = tonumber(ARGV[3])
local window = 3600000
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
local count = tonumber(redis.call('ZCARD', KEYS[1]))
local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
local last = tonumber(redis.call('GET', KEYS[2]) or '0')
local wait = 0
local reason = ''
if count >= limit then wait = math.max(wait, tonumber(oldest[2]) + window - now); reason = 'hourly' end
if last + spacing - now > wait then wait = last + spacing - now; reason = 'spacing' end
if wait > 0 then return {wait, reason, count >= limit and 1 or 0} end
redis.call('ZADD', KEYS[1], now, ARGV[4])
redis.call('PEXPIRE', KEYS[1], window)
redis.call('SET', KEYS[2], now, 'PX', math.max(spacing * 2, 60000))
return 0
`;

async function processEmailJob(job: Job<{ emailId: string }>): Promise<void> {
  const email = await prisma.email.findUnique({ where: { id: job.data.emailId } });
  if (!email || email.status !== 'SCHEDULED') return;
  if (!process.env.ETHEREAL_USER || !process.env.ETHEREAL_PASS) {
    await prisma.email.update({ where: { id: email.id }, data: { status: 'FAILED', error: 'Ethereal SMTP credentials are not configured.' } });
    await indexEmail(email.id).catch((error: unknown) => console.error('Elasticsearch indexing failed:', error));
    throw new UnrecoverableError('Ethereal SMTP credentials are not configured.');
  }
  const reservation = await redis.eval(
    reservationScript,
    2,
    `email-rate:${email.senderEmail}`,
    `email-spacing:${email.senderEmail}`,
    Date.now(),
    hourlyLimit,
    minSendDelayMs,
    email.id,
  );
  const { waitMs, hourlyLimitReached } = parseRateReservation(reservation);
  if (waitMs > 0) {
    if (Number(hourlyLimitReached) === 1 && email.userId) {
      const alertKey = `email-hourly-alert:${email.userId}:${email.senderEmail}`;
      const shouldAlert = await redis.set(alertKey, '1', 'EX', 3600, 'NX');
      if (shouldAlert) {
        await notifyUserSlack(email.userId, `Hourly sending limit reached for ${email.senderEmail}. The message "${email.subject}" has been rescheduled and will send when the limit window resets.`)
          .catch((error: unknown) => console.error('Slack hourly-limit notification failed:', error));
      }
    }
    await job.moveToDelayed(Date.now() + waitMs, job.token);
    throw new DelayedError();
  }
  const claimed = await prisma.email.updateMany({
    where: { id: email.id, status: 'SCHEDULED' },
    data: { status: 'SENDING', error: null },
  });
  if (!claimed.count) return;
  await indexEmail(email.id).catch((error: unknown) => console.error('Elasticsearch indexing failed:', error));

  try {
    const transport = nodemailer.createTransport({
      host: 'smtp.ethereal.email',
      port: 587,
      secure: false,
      auth: { user: process.env.ETHEREAL_USER, pass: process.env.ETHEREAL_PASS },
    });
    const info = await transport.sendMail({
      from: { address: email.senderEmail, name: email.senderName },
      to: email.recipients,
      subject: email.subject,
      text: email.body,
    });
    await prisma.email.update({ where: { id: email.id }, data: { status: 'SENT', sentAt: new Date(), error: null } });
    const preview = nodemailer.getTestMessageUrl(info);
    if (preview) console.info(`Ethereal preview for ${email.id}: ${preview}`);
    await indexEmail(email.id).catch((error: unknown) => console.error('Elasticsearch indexing failed:', error));
  } catch (error) {
    await prisma.email.update({
      where: { id: email.id },
      data: { status: 'FAILED', error: error instanceof Error ? error.message.slice(0, 2000) : 'SMTP delivery failed.' },
    });
    await indexEmail(email.id).catch((indexError: unknown) => console.error('Elasticsearch indexing failed:', indexError));
    throw error;
  }
}

const worker = enableWorker
  ? new Worker<{ emailId: string }>(queueName, processEmailJob, { connection: redis, concurrency })
  : null;

async function indexEmail(id: string): Promise<void> {
  const node = process.env.ELASTICSEARCH_NODE;
  if (!node) return;
  const email = await prisma.email.findUnique({ where: { id } });
  if (!email) return;
  const index = process.env.ELASTICSEARCH_INDEX || 'emails';
  const client = elasticsearchClient(node);
  try {
    await client.indices.create({
      index,
      settings: { number_of_shards: 1 },
      mappings: {
        properties: {
          userId: { type: 'keyword' },
          subject: { type: 'text' },
          body: { type: 'text' },
          recipients: { type: 'keyword' },
          status: { type: 'keyword' },
          sentAt: { type: 'date' },
        },
      },
    });
  } catch (error) {
    const responseError = error as { meta?: { body?: { error?: { type?: string } } } };
    if (responseError.meta?.body?.error?.type !== 'resource_already_exists_exception') throw error;
  }
  await client.index({
    index,
    id,
    document: { userId: email.userId, subject: email.subject, body: email.body, recipients: email.recipients, status: email.status, sentAt: email.sentAt },
    refresh: 'wait_for',
  });
}

async function notifyUserSlack(userId: string, message: string): Promise<void> {
  const integration = await prisma.slackIntegration.findUnique({ where: { userId } });
  if (integration) {
    if (!integration.channelId) return;
    const response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { authorization: `Bearer ${decryptSecret(integration.encryptedAccessToken)}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ channel: integration.channelId, text: message }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Slack API returned HTTP ${response.status}.`);
    const result = await response.json() as { ok?: boolean; error?: string };
    if (!result.ok) throw new Error(`Slack API rejected the notification: ${result.error || 'unknown error'}.`);
    return;
  }
  await notifySlack(message);
}

async function notifySlack(message: string): Promise<void> {
  const webhook = process.env.SLACK_WEBHOOK_URL;
  if (webhook) {
    const response = await fetch(webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: message }), signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Slack webhook returned HTTP ${response.status}.`);
    return;
  }
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_NOTIFICATION_CHANNEL;
  if (!token || !channel) return;
  const response = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ channel, text: message }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`Slack API returned HTTP ${response.status}.`);
  const result = await response.json() as { ok?: boolean; error?: string };
  if (!result.ok) throw new Error(`Slack API rejected the notification: ${result.error || 'unknown error'}.`);
}

function elasticsearchClient(node: string): ElasticsearchClient {
  return new ElasticsearchClient({
    node,
    requestTimeout: 2000,
    auth: process.env.ELASTICSEARCH_USERNAME ? {
      username: process.env.ELASTICSEARCH_USERNAME,
      password: process.env.ELASTICSEARCH_PASSWORD || '',
    } : undefined,
  });
}

async function recoverQueue(): Promise<void> {
  const uncertain = await prisma.email.updateMany({
    where: { status: 'SENDING' },
    data: { status: 'FAILED', error: 'Process restarted while delivery was in progress; delivery outcome is unknown and will not be retried automatically.' },
  });
  if (uncertain.count) console.warn(`Marked ${uncertain.count} interrupted delivery(s) as failed to prevent duplicate sends.`);
  const scheduled = await prisma.email.findMany({ where: { status: 'SCHEDULED' }, select: { id: true, scheduledAt: true } });
  for (const email of scheduled) await enqueue(email);
}

async function start(): Promise<void> {
  await Promise.all([prisma.$connect(), redis.ping()]);
  if (enableWorker) await recoverQueue();
  if (enableHttp) {
    app.listen(port, () => console.info(`ReachInbox API listening on port ${port}`));
  } else if (enableWorker) {
    console.info('ReachInbox queue worker running (HTTP server disabled).');
  } else {
    throw new Error('Set ENABLE_HTTP and/or ENABLE_WORKER; both cannot be false.');
  }
}

if (worker) {
  worker.on('failed', (job, error) => console.error(`Email job ${job?.id || 'unknown'} failed:`, error.message));
  worker.on('error', (error) => console.error('Email worker error:', error));
}

start().catch(async (error: unknown) => {
  console.error('Startup failed. Confirm PostgreSQL and Redis are running and DATABASE_URL is valid.', error);
  if (worker) await worker.close().catch(() => undefined);
  await queue.close().catch(() => undefined);
  await prisma.$disconnect().catch(() => undefined);
  process.exitCode = 1;
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void Promise.all([
      worker ? worker.close() : Promise.resolve(),
      queue.close(),
      redis.quit(),
      prisma.$disconnect(),
    ]).finally(() => process.exit(0));
  });
}
