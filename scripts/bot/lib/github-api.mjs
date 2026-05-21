// GitHub Issues API wrapper. Uses GH_TOKEN (issued via gh auth) or
// GITHUB_TOKEN (provided by Actions). On Vercel webhook we don't need
// to mutate issues until M2 (builder-fix trigger) — kept minimal for M1.

import { GITHUB_REPO, getEnv } from '../config.mjs';

function getToken({ required = false } = {}) {
  const t = getEnv('GH_TOKEN') || getEnv('GITHUB_TOKEN');
  if (!t && required) throw new Error('GH_TOKEN or GITHUB_TOKEN must be set for GitHub API mutations');
  return t;
}

async function ghFetch(path, init = {}, { authRequired = false } = {}) {
  const headers = {
    'accept': 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    ...(init.headers || {}),
  };
  const token = getToken({ required: authRequired });
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`https://api.github.com${path}`, { ...init, headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API ${path}: ${res.status} ${body}`);
  }
  return res.json();
}

// Public repo read — works without token (60 req/hr anon limit, 5000/hr with token).
export async function listIssuesByLabel(label) {
  const issues = await ghFetch(
    `/repos/${GITHUB_REPO}/issues?labels=${encodeURIComponent(label)}&state=open&per_page=50`
  );
  return issues.map(i => ({
    number: i.number,
    title: i.title,
    body: i.body,
    labels: i.labels.map(l => l.name),
    html_url: i.html_url,
  }));
}

export async function getIssue(issueNumber) {
  return ghFetch(`/repos/${GITHUB_REPO}/issues/${issueNumber}`);
}

export async function setLabel(issueNumber, labelToAdd, labelToRemove = null) {
  const token = getToken({ required: true });
  if (labelToRemove) {
    await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/issues/${issueNumber}/labels/${encodeURIComponent(labelToRemove)}`,
      { method: 'DELETE', headers: { authorization: `Bearer ${token}` } }
    );
  }
  return ghFetch(`/repos/${GITHUB_REPO}/issues/${issueNumber}/labels`, {
    method: 'POST',
    body: JSON.stringify({ labels: [labelToAdd] }),
  }, { authRequired: true });
}

export async function commentOnIssue(issueNumber, body) {
  return ghFetch(`/repos/${GITHUB_REPO}/issues/${issueNumber}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  }, { authRequired: true });
}

// ---- Contents API (commit one file via REST) ----------------------------
// Used to ship `_data/{slug}/visual_review_input.json` from the bot webhook
// straight into the repo so the GH Actions workflow can pick it up.

// Get current sha of a file at given path (or null if it doesn't exist).
async function getFileSha(path, ref = 'main') {
  const token = getToken({ required: true });
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`,
    { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' } }
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`getFileSha ${path}: ${res.status} ${body}`);
  }
  const data = await res.json();
  return data.sha;
}

// Commits `content` (string) to `path` on `branch`. Creates or updates.
export async function putFile({ path, content, message, branch = 'main' }) {
  const sha = await getFileSha(path, branch);
  const base64 = Buffer.from(content, 'utf8').toString('base64');
  const body = {
    message,
    content: base64,
    branch,
    ...(sha ? { sha } : {}),
  };
  return ghFetch(`/repos/${GITHUB_REPO}/contents/${encodeURIComponent(path)}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  }, { authRequired: true });
}

// ---- Workflow dispatch --------------------------------------------------

export async function dispatchWorkflow({ workflow, ref = 'main', inputs = {} }) {
  return ghFetch(`/repos/${GITHUB_REPO}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, {
    method: 'POST',
    body: JSON.stringify({ ref, inputs }),
  }, { authRequired: true });
}

