// Google OAuth — Desktop/Installed app loopback flow.
// Opens the user's browser, runs a one-shot local HTTP server on an ephemeral
// port to catch the redirect, exchanges the code for a refresh token.
import { google } from 'googleapis';
import http from 'node:http';
import { URL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { loadCredentials, loadTokens, saveTokens } from './state.js';

const SCOPES = ['https://www.googleapis.com/auth/calendar'];

export async function getAuthedClient() {
  const creds = await loadCredentials();
  if (!creds) throw new Error('No Google credentials. Run: csync-calendar setup');
  const { client_id, client_secret } = creds.installed || creds.web || creds;
  const tokens = await loadTokens();
  if (!tokens) throw new Error('Not authenticated. Run: csync-calendar setup');

  const oAuth2 = new google.auth.OAuth2(client_id, client_secret, tokens.redirect_uri);
  oAuth2.setCredentials(tokens);
  oAuth2.on('tokens', async (t) => {
    // Persist refreshed access token
    const merged = { ...tokens, ...t };
    await saveTokens(merged);
  });
  return oAuth2;
}

// Interactive OAuth — blocks until the user completes the browser step.
export async function runSetupFlow({ clientId, clientSecret }) {
  // Bind 127.0.0.1 on an ephemeral port for the redirect. Google allows any
  // http://127.0.0.1 port for Desktop app type.
  const server = http.createServer();
  const port = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const oAuth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  const state = randomBytes(16).toString('hex');
  const url = oAuth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state,
  });

  const result = new Promise((resolve, reject) => {
    server.on('request', async (req, res) => {
      try {
        const parsed = new URL(req.url, `http://127.0.0.1:${port}`);
        if (parsed.pathname !== '/callback') {
          res.writeHead(404); res.end('not found'); return;
        }
        const code = parsed.searchParams.get('code');
        const gotState = parsed.searchParams.get('state');
        const errParam = parsed.searchParams.get('error');
        if (errParam) { res.writeHead(400); res.end(`error: ${errParam}`); reject(new Error(errParam)); return; }
        if (gotState !== state) { res.writeHead(400); res.end('state mismatch'); reject(new Error('state mismatch')); return; }
        const { tokens } = await oAuth2.getToken(code);
        tokens.redirect_uri = redirectUri;
        await saveTokens(tokens);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>Canvas Sync — Calendar connected</h1><p>You can close this window.</p>');
        resolve(tokens);
      } catch (err) {
        try { res.writeHead(500); res.end('internal error'); } catch {}
        reject(err);
      } finally {
        setTimeout(() => server.close(), 250);
      }
    });
  });

  openInBrowser(url);
  console.log(`\nIf the browser didn't open, visit:\n\n  ${url}\n`);
  return result;
}

function openInBrowser(url) {
  const cmd =
    process.platform === 'darwin' ? ['open', url] :
    process.platform === 'win32'  ? ['cmd', '/c', 'start', '', url] :
    ['xdg-open', url];
  try {
    spawn(cmd[0], cmd.slice(1), { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* non-fatal; user can copy the URL manually */
  }
}
