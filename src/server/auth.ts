import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

const COOKIE = 'ambiance_session';
const SESSION_DAYS = 30;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60_000;

// Reachable without a session: the login page and what it needs, plus the health check.
const PUBLIC_PATHS = new Set(['/login.html', '/styles.css', '/api/login', '/api/health']);

/**
 * Single-user password login. A session is a signed cookie holding its expiry time;
 * there's nothing to store server-side. Changing SESSION_SECRET logs everyone out.
 */
export function registerAuth(app: FastifyInstance, opts: { password: string; secret: string }): void {
  const failures = new Map<string, { count: number; until: number }>();

  const sign = (value: string) => createHmac('sha256', opts.secret).update(value).digest('base64url');

  const isValidSession = (req: FastifyRequest): boolean => {
    const raw = readCookie(req.headers.cookie, COOKIE);
    if (!raw) return false;
    const [expires, sig] = raw.split('.');
    if (!expires || !sig || !safeEqual(sig, sign(expires))) return false;
    return Number(expires) > Date.now();
  };

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0]!;
    if (PUBLIC_PATHS.has(path) || isValidSession(req)) return;
    if (path.startsWith('/api/') || path.startsWith('/assets/')) {
      return reply.code(401).send({ error: 'Not logged in' });
    }
    return reply.redirect('/login.html');
  });

  app.post('/api/login', async (req, reply) => {
    const ip = req.ip;
    const lock = failures.get(ip);
    if (lock && lock.until > Date.now()) {
      return reply.code(429).send({ error: 'Too many attempts. Try again in a few minutes.' });
    }
    const { password } = z.object({ password: z.string().max(500) }).parse(req.body ?? {});
    if (!safeEqual(password, opts.password)) {
      const count = (lock?.count ?? 0) + 1;
      failures.set(ip, { count, until: count >= MAX_FAILURES ? Date.now() + LOCKOUT_MS : 0 });
      return reply.code(401).send({ error: 'Wrong password' });
    }
    failures.delete(ip);
    const expires = String(Date.now() + SESSION_DAYS * 86_400_000);
    setCookie(reply, req, `${expires}.${sign(expires)}`, SESSION_DAYS * 86_400);
    return { ok: true };
  });

  app.post('/api/logout', async (req, reply) => {
    setCookie(reply, req, '', 0);
    return { ok: true };
  });
}

function setCookie(reply: FastifyReply, req: FastifyRequest, value: string, maxAgeS: number): void {
  const secure = req.protocol === 'https' ? '; Secure' : '';
  reply.header('set-cookie', `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${secure}`);
}

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
