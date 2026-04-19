/**
 * Comprehensive end-to-end test for Circular Planner.
 * Runs serially; uses three users (alice, bob, carol) and exercises
 * every user-facing feature. Idempotent: works on a fresh or existing DB.
 */
import { test, expect, APIRequestContext, BrowserContext, Page } from '@playwright/test';

const BASE = 'http://localhost:3000';

// ─── shared state between tests ───────────────────────────────────────────────
let aliceCtx: BrowserContext;
let bobCtx: BrowserContext;
let carolCtx: BrowserContext;
let alicePage: Page;
let bobPage: Page;
let carolPage: Page;
let aliceApi: APIRequestContext;
let bobApi: APIRequestContext;
let carolApi: APIRequestContext;

let sharedPlannerId: number;
let engineeringLaneId: string;
let groupId: number;
let aliceUserId: number;
let bobUserId: number;
let carolUserId: number;

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Register a user via API; if already exists, login instead. Returns userId. */
async function ensureUser(
  api: APIRequestContext,
  username: string,
  email: string,
  password: string,
): Promise<number> {
  let r = await api.post(`${BASE}/api/auth/register`, { data: { username, email, password } });
  if (r.status() === 409) {
    r = await api.post(`${BASE}/api/auth/login`, { data: { email, password } });
  }
  const status = r.status();
  if (status !== 200 && status !== 201) {
    throw new Error(`ensureUser(${username}): unexpected status ${status}`);
  }
  const data = await r.json();
  return data.user.id;
}

async function loginUser(page: Page, email: string, password: string) {
  await page.goto('/index.html');
  await page.fill('#login-email', email);
  await page.fill('#login-password', password);
  await page.click('#login-form button[type=submit]');
  await page.waitForURL('**/dashboard.html', { timeout: 10000 });
}

// ─── Setup: ensure authenticated sessions before any test runs ────────────────
test.beforeAll(async ({ browser }) => {
  aliceCtx  = await browser.newContext();
  bobCtx    = await browser.newContext();
  carolCtx  = await browser.newContext();
  alicePage = await aliceCtx.newPage();
  bobPage   = await bobCtx.newPage();
  carolPage = await carolCtx.newPage();
  aliceApi  = aliceCtx.request;
  bobApi    = bobCtx.request;
  carolApi  = carolCtx.request;

  // Register or login all three users — idempotent across test runs
  aliceUserId = await ensureUser(aliceApi, 'alice', 'alice@test.local', 'Alice1234!');
  bobUserId   = await ensureUser(bobApi,   'bob',   'bob@test.local',   'Bob12345!');
  carolUserId = await ensureUser(carolApi, 'carol', 'carol@test.local', 'Carol123!');

  // Navigate pages so the browser context has the auth cookie loaded
  await alicePage.goto(`${BASE}/dashboard.html`);
  await bobPage.goto(`${BASE}/dashboard.html`);
  await carolPage.goto(`${BASE}/dashboard.html`);
});

test.afterAll(async () => {
  // Delete all planners and groups owned by alice to prevent state accumulation across runs
  try {
    const planners = await (await aliceApi.get(`${BASE}/api/planners`)).json();
    for (const p of planners) {
      if (p.permission === 'owner') await aliceApi.delete(`${BASE}/api/planners/${p.id}`);
    }
    const groups = await (await aliceApi.get(`${BASE}/api/groups`)).json();
    for (const g of groups) {
      await aliceApi.delete(`${BASE}/api/groups/${g.id}`);
    }
  } catch { /* best-effort cleanup */ }

  await aliceCtx.close();
  await bobCtx.close();
  await carolCtx.close();
});

// ═══════════════════════════════════════════════════════════════════════════════
// §1  AUTHENTICATION
// ═══════════════════════════════════════════════════════════════════════════════

test('§1.1 authenticated session returns user info', async () => {
  const me = await (await aliceApi.get(`${BASE}/api/auth/me`)).json();
  expect(me.user.username).toBe('alice');
  expect(me.user.id).toBe(aliceUserId);
});

test('§1.2 bob and carol sessions are independent', async () => {
  const [bMe, cMe] = await Promise.all([
    (await bobApi.get(`${BASE}/api/auth/me`)).json(),
    (await carolApi.get(`${BASE}/api/auth/me`)).json(),
  ]);
  expect(bMe.user.username).toBe('bob');
  expect(cMe.user.username).toBe('carol');
});

test('§1.3 browser login — alice dashboard loads', async () => {
  await expect(alicePage).toHaveURL(/dashboard/);
  await expect(alicePage.locator('#planners-grid')).toBeVisible({ timeout: 5000 });
});

test('§1.4 duplicate email rejected', async ({ request }) => {
  const r = await request.post(`${BASE}/api/auth/register`, {
    data: { username: 'alice2', email: 'alice@test.local', password: 'Test1234!' },
  });
  expect(r.status()).toBe(409);
});

test('§1.5 duplicate username rejected', async ({ request }) => {
  const r = await request.post(`${BASE}/api/auth/register`, {
    data: { username: 'alice', email: 'other@test.local', password: 'Test1234!' },
  });
  expect(r.status()).toBe(409);
});

test('§1.6 wrong password rejected — error shown in browser', async ({ browser }) => {
  // Use a fresh unauthenticated context so /index.html does not redirect
  const ctx = await browser.newContext();
  const pg = await ctx.newPage();
  await pg.goto('/index.html');
  await pg.fill('#login-email', 'alice@test.local');
  await pg.fill('#login-password', 'wrongpassword');
  await pg.click('#login-form button[type=submit]');
  // Server returns 400 for invalid credentials (not 401, which would redirect)
  await expect(pg.locator('#login-error')).toBeVisible({ timeout: 5000 });
  await expect(pg.locator('#login-error')).not.toHaveClass(/hidden/);
  await ctx.close();
});

test('§1.7 logout clears session', async ({ browser }) => {
  const ctx = await browser.newContext();
  const pg = await ctx.newPage();
  await loginUser(pg, 'alice@test.local', 'Alice1234!');
  await pg.click('#logout-btn');
  await pg.waitForURL('**/index.html');
  await pg.goto('/dashboard.html');
  await pg.waitForURL('**/index.html', { timeout: 5000 });
  await ctx.close();
});

test('§1.8 unauthenticated access to planner redirects to login', async ({ browser }) => {
  const ctx = await browser.newContext();
  const pg = await ctx.newPage();
  await pg.goto('/planner.html?id=1');
  await pg.waitForURL('**/index.html', { timeout: 5000 });
  await ctx.close();
});

test('§1.9 registration via browser UI', async ({ browser }) => {
  // Use a unique user so this test works on any DB state
  const ts = Date.now();
  const ctx = await browser.newContext();
  const pg = await ctx.newPage();
  await pg.goto('/index.html');
  await pg.click('[data-tab="register"]');
  await pg.fill('#reg-username', `testuser_${ts}`);
  await pg.fill('#reg-email', `testuser_${ts}@test.local`);
  await pg.fill('#reg-password', 'TestUser1!');
  await pg.click('#register-form button[type=submit]');
  await pg.waitForURL('**/dashboard.html', { timeout: 10000 });
  await expect(pg).toHaveURL(/dashboard/);
  await ctx.close();
});

// ═══════════════════════════════════════════════════════════════════════════════
// §2  DASHBOARD & PLANNER CRUD
// ═══════════════════════════════════════════════════════════════════════════════

test('§2.1 dashboard loads and shows planners grid', async () => {
  await alicePage.goto('/dashboard.html');
  await expect(alicePage.locator('#planners-grid')).toBeVisible();
  await expect(alicePage.locator('#groups-grid')).toBeVisible();
});

test('§2.2 create planner via dialog', async () => {
  await alicePage.goto('/dashboard.html');
  await alicePage.click('#new-planner-btn');
  await expect(alicePage.locator('#new-planner-overlay')).toBeVisible();
  await alicePage.fill('#np-title', '2026 Roadmap');
  await alicePage.fill('#np-start', '01/01/2026');
  await alicePage.fill('#np-end', '31/12/2026');
  await alicePage.click('#new-planner-form button[type=submit]');
  await alicePage.waitForURL('**/planner.html?id=**', { timeout: 10000 });
});

test('§2.3 planner disc renders (SVG present)', async () => {
  await expect(alicePage.locator('svg').first()).toBeVisible({ timeout: 5000 });
});

test('§2.4 add lane via sidebar', async () => {
  await alicePage.click('button:has-text("+ Add Lane")');
  await expect(alicePage.locator('#cp-lane-name')).toBeVisible();
  await alicePage.fill('#cp-lane-name', 'Engineering');
  await alicePage.click('#cp-lane-save');
  await expect(alicePage.locator('.cp-sidebar-lane-row')).toBeVisible({ timeout: 3000 });
  const plannerUrl = alicePage.url();
  const plannerId = parseInt(new URL(plannerUrl).searchParams.get('id')!, 10);
  const r = await aliceApi.get(`${BASE}/api/planners/${plannerId}`);
  const { data } = await r.json();
  expect(data.lanes.length).toBeGreaterThanOrEqual(1);
  const engLane = data.lanes.find((l: { name: string }) => l.name === 'Engineering');
  expect(engLane).toBeDefined();
  engineeringLaneId = engLane.id;
  sharedPlannerId = plannerId;
});

test('§2.5 add activities via API and verify via list view', async () => {
  const r = await aliceApi.get(`${BASE}/api/planners/${sharedPlannerId}`);
  const { data } = await r.json();
  const lane = data.lanes[0];

  const put = await aliceApi.put(`${BASE}/api/planners/${sharedPlannerId}`, {
    data: {
      lanes: [{
        ...lane,
        activities: [
          { id: 'act-001', laneId: lane.id, title: 'Q1 Planning', description: 'First quarter planning', startDate: '2026-01-05', endDate: '2026-01-31', color: '#0052cc', label: 'planning' },
          { id: 'act-002', laneId: lane.id, title: 'Q2 Launch',   description: 'Product launch',        startDate: '2026-04-01', endDate: '2026-06-30', color: '#0052cc', label: 'launch'   },
        ],
      }],
    },
  });
  expect(put.status()).toBe(200);

  await alicePage.reload();
  await alicePage.click('button[title="Timeline list view"]');
  await expect(alicePage.locator('text=Q1 Planning')).toBeVisible({ timeout: 5000 });
  await expect(alicePage.locator('text=Q2 Launch')).toBeVisible();
});

test('§2.6 edit activity via dialog in list view', async () => {
  await alicePage.click('text=Q1 Planning');
  await expect(alicePage.locator('#cp-act-title')).toBeVisible({ timeout: 3000 });
  await alicePage.fill('#cp-act-title', 'Q1 Planning — UPDATED');
  await alicePage.click('#cp-act-save');
  await expect(alicePage.locator('text=Q1 Planning — UPDATED')).toBeVisible({ timeout: 3000 });
});

test('§2.7 delete activity via dialog', async () => {
  await alicePage.click('text=Q2 Launch');
  await expect(alicePage.locator('#cp-act-delete')).toBeVisible();
  await alicePage.click('#cp-act-delete');
  await expect(alicePage.locator('text=Q2 Launch')).not.toBeVisible({ timeout: 3000 });
});

test('§2.8 planner shown on dashboard with Owner badge', async () => {
  await alicePage.goto('/dashboard.html');
  await expect(alicePage.locator('.badge-owner')).toBeVisible({ timeout: 5000 });
  await expect(alicePage.locator('text=2026 Roadmap')).toBeVisible();
});

test('§2.9 delete planner then recreate for subsequent tests', async () => {
  const r = await aliceApi.delete(`${BASE}/api/planners/${sharedPlannerId}`);
  expect(r.status()).toBe(200);
  const list = await (await aliceApi.get(`${BASE}/api/planners`)).json();
  expect(list.find((p: { id: number }) => p.id === sharedPlannerId)).toBeUndefined();
  // Re-create a clean planner for all subsequent tests
  const create = await aliceApi.post(`${BASE}/api/planners`, {
    data: { title: 'Shared Planner', startDate: '2026-01-01', endDate: '2026-12-31' },
  });
  expect(create.status()).toBe(201);
  const p = await create.json();
  sharedPlannerId = p.id;
  // Add Engineering lane + one activity
  const put = await aliceApi.put(`${BASE}/api/planners/${sharedPlannerId}`, {
    data: {
      lanes: [{
        id: 'eng-lane', name: 'Engineering', order: 0, color: '#0052cc',
        activities: [
          { id: 'act-003', laneId: 'eng-lane', title: 'Feature A', description: '', startDate: '2026-02-01', endDate: '2026-03-31', color: '#0052cc', label: '' },
        ],
      }],
    },
  });
  expect(put.status()).toBe(200);
  engineeringLaneId = 'eng-lane';
});

// ═══════════════════════════════════════════════════════════════════════════════
// §3  PER-USER SHARING
// ═══════════════════════════════════════════════════════════════════════════════

test('§3.1 share planner with bob (view)', async () => {
  const r = await aliceApi.post(`${BASE}/api/planners/${sharedPlannerId}/shares`, {
    data: { email: 'bob@test.local', permission: 'view' },
  });
  expect(r.status()).toBe(200);
});

test('§3.2 bob sees shared planner on dashboard', async () => {
  await bobPage.goto('/dashboard.html');
  await expect(bobPage.locator('text=Shared Planner')).toBeVisible({ timeout: 5000 });
  await expect(bobPage.locator('.badge-view')).toBeVisible();
});

test('§3.3 bob has view-only access (Add Lane hidden)', async () => {
  await bobPage.goto(`/planner.html?id=${sharedPlannerId}`);
  await expect(bobPage.locator('svg').first()).toBeVisible({ timeout: 5000 });
  await expect(bobPage.locator('button:has-text("+ Add Lane")')).not.toBeVisible();
});

test('§3.4 bob cannot PUT planner (403)', async () => {
  const r = await bobApi.get(`${BASE}/api/planners/${sharedPlannerId}`);
  const { data } = await r.json();
  const put = await bobApi.put(`${BASE}/api/planners/${sharedPlannerId}`, { data });
  expect(put.status()).toBe(403);
});

test('§3.5 upgrade bob to edit', async () => {
  const r = await aliceApi.post(`${BASE}/api/planners/${sharedPlannerId}/shares`, {
    data: { email: 'bob@test.local', permission: 'edit' },
  });
  expect(r.status()).toBe(200);
});

test('§3.6 bob can now PUT planner (200)', async () => {
  const r = await bobApi.get(`${BASE}/api/planners/${sharedPlannerId}`);
  const { data } = await r.json();
  const put = await bobApi.put(`${BASE}/api/planners/${sharedPlannerId}`, { data });
  expect(put.status()).toBe(200);
});

test('§3.7 revoke share — bob loses access', async () => {
  const r = await aliceApi.delete(`${BASE}/api/planners/${sharedPlannerId}/shares/${bobUserId}`);
  expect(r.status()).toBe(200);
  const get = await bobApi.get(`${BASE}/api/planners/${sharedPlannerId}`);
  expect(get.status()).toBe(403);
});

test('§3.8 share to unknown email returns 404', async () => {
  const r = await aliceApi.post(`${BASE}/api/planners/${sharedPlannerId}/shares`, {
    data: { email: 'nobody@nowhere.invalid', permission: 'view' },
  });
  expect(r.status()).toBe(404);
});

// ═══════════════════════════════════════════════════════════════════════════════
// §4  GROUPS
// ═══════════════════════════════════════════════════════════════════════════════

test('§4.1 create group "Team Alpha" via UI', async () => {
  await alicePage.goto('/groups.html');
  await alicePage.click('#new-group-btn');
  await expect(alicePage.locator('#new-group-overlay')).toBeVisible();
  await alicePage.fill('#ng-name', 'Team Alpha');
  await alicePage.fill('#ng-desc', 'Engineering group');
  await alicePage.click('#new-group-form button[type=submit]');
  await alicePage.waitForURL('**/groups.html?id=**', { timeout: 10000 });
  const id = parseInt(new URL(alicePage.url()).searchParams.get('id')!, 10);
  groupId = id;
  expect(groupId).toBeGreaterThan(0);
});

test('§4.2 group detail shows alice as admin', async () => {
  await expect(alicePage.locator('#detail-name')).toHaveText('Team Alpha');
  await expect(alicePage.locator('.badge-admin').first()).toBeVisible();
});

test('§4.3 user search finds bob', async () => {
  const r = await aliceApi.get(`${BASE}/api/users?q=bob`);
  expect(r.status()).toBe(200);
  const users = await r.json();
  expect(users.length).toBeGreaterThan(0);
  expect(users[0].username).toBe('bob');
});

test('§4.4 empty search returns empty array', async () => {
  const r = await aliceApi.get(`${BASE}/api/users?q=`);
  const users = await r.json();
  expect(users).toEqual([]);
});

test('§4.5 add bob as member via API', async () => {
  const r = await aliceApi.post(`${BASE}/api/groups/${groupId}/members`, {
    data: { user_id: bobUserId, role: 'member' },
  });
  expect(r.status()).toBe(200);
  const detail = await (await aliceApi.get(`${BASE}/api/groups/${groupId}`)).json();
  const bob = detail.members.find((m: { username: string }) => m.username === 'bob');
  expect(bob.role).toBe('member');
});

test('§4.6 group card shows on groups list', async () => {
  await alicePage.goto('/groups.html');
  await expect(alicePage.locator('text=Team Alpha')).toBeVisible({ timeout: 5000 });
});

test('§4.7 bob sees group on his dashboard', async () => {
  await bobPage.goto('/dashboard.html');
  await expect(bobPage.locator('text=Team Alpha')).toBeVisible({ timeout: 5000 });
});

test('§4.8 change bob role to admin', async () => {
  const r = await aliceApi.patch(`${BASE}/api/groups/${groupId}/members/${bobUserId}`, {
    data: { role: 'admin' },
  });
  expect(r.status()).toBe(200);
  const detail = await (await aliceApi.get(`${BASE}/api/groups/${groupId}`)).json();
  const bob = detail.members.find((m: { username: string }) => m.username === 'bob');
  expect(bob.role).toBe('admin');
});

test('§4.9 last-admin guard: cannot demote last admin', async () => {
  // Demote alice (both alice and bob are admins — allowed)
  await aliceApi.patch(`${BASE}/api/groups/${groupId}/members/${aliceUserId}`, {
    data: { role: 'member' },
  });
  // Now try to demote bob (last admin) — should fail
  const r = await aliceApi.patch(`${BASE}/api/groups/${groupId}/members/${bobUserId}`, {
    data: { role: 'member' },
  });
  expect(r.status()).toBe(400);
  const err = await r.json();
  expect(err.error).toContain('last admin');
  // Restore: bob promotes alice back
  await bobApi.patch(`${BASE}/api/groups/${groupId}/members/${aliceUserId}`, {
    data: { role: 'admin' },
  });
});

test('§4.10 cannot remove last admin', async () => {
  // Demote alice so bob is only admin
  await aliceApi.patch(`${BASE}/api/groups/${groupId}/members/${aliceUserId}`, {
    data: { role: 'member' },
  });
  const r = await aliceApi.delete(`${BASE}/api/groups/${groupId}/members/${bobUserId}`);
  expect(r.status()).toBe(400);
  // Restore
  await bobApi.patch(`${BASE}/api/groups/${groupId}/members/${aliceUserId}`, {
    data: { role: 'admin' },
  });
});

test('§4.11 carol joins then self-leaves', async () => {
  await aliceApi.post(`${BASE}/api/groups/${groupId}/members`, {
    data: { user_id: carolUserId, role: 'member' },
  });
  const leave = await carolApi.delete(`${BASE}/api/groups/${groupId}/members/${carolUserId}`);
  expect(leave.status()).toBe(200);
  const detail = await (await aliceApi.get(`${BASE}/api/groups/${groupId}`)).json();
  const carol = detail.members.find((m: { username: string }) => m.username === 'carol');
  expect(carol).toBeUndefined();
});

test('§4.12 edit group name', async () => {
  const r = await aliceApi.patch(`${BASE}/api/groups/${groupId}`, {
    data: { name: 'Team Alpha Renamed' },
  });
  expect(r.status()).toBe(200);
  const detail = await (await aliceApi.get(`${BASE}/api/groups/${groupId}`)).json();
  expect(detail.name).toBe('Team Alpha Renamed');
  await aliceApi.patch(`${BASE}/api/groups/${groupId}`, { data: { name: 'Team Alpha' } });
});

test('§4.13 delete a separate group', async () => {
  const create = await aliceApi.post(`${BASE}/api/groups`, { data: { name: 'Temp Group' } });
  const { id: tmpId } = await create.json();
  const del = await aliceApi.delete(`${BASE}/api/groups/${tmpId}`);
  expect(del.status()).toBe(200);
  const get = await aliceApi.get(`${BASE}/api/groups/${tmpId}`);
  expect(get.status()).toBe(403);
});

// ═══════════════════════════════════════════════════════════════════════════════
// §5  GROUP-BASED PLANNER SHARING
// ═══════════════════════════════════════════════════════════════════════════════

test('§5.1 attach Team Alpha to planner (view)', async () => {
  const r = await aliceApi.post(`${BASE}/api/planners/${sharedPlannerId}/shares/group-shares`, {
    data: { group_id: groupId, default_permission: 'view' },
  });
  expect(r.status()).toBe(200);
});

test('§5.2 bob sees planner via group (view)', async () => {
  const list = await (await bobApi.get(`${BASE}/api/planners`)).json();
  const p = list.find((x: { id: number }) => x.id === sharedPlannerId);
  expect(p).toBeDefined();
  expect(p.permission).toBe('view');
});

test('§5.3 bob cannot edit (PUT returns 403)', async () => {
  const { data } = await (await bobApi.get(`${BASE}/api/planners/${sharedPlannerId}`)).json();
  const r = await bobApi.put(`${BASE}/api/planners/${sharedPlannerId}`, { data });
  expect(r.status()).toBe(403);
});

test('§5.4 upgrade group default_permission to edit', async () => {
  const r = await aliceApi.post(`${BASE}/api/planners/${sharedPlannerId}/shares/group-shares`, {
    data: { group_id: groupId, default_permission: 'edit' },
  });
  expect(r.status()).toBe(200);
});

test('§5.5 bob can now PUT (200)', async () => {
  const { data } = await (await bobApi.get(`${BASE}/api/planners/${sharedPlannerId}`)).json();
  const r = await bobApi.put(`${BASE}/api/planners/${sharedPlannerId}`, { data });
  expect(r.status()).toBe(200);
});

test('§5.6 per-member override: restrict bob to view', async () => {
  const r = await aliceApi.put(
    `${BASE}/api/planners/${sharedPlannerId}/shares/group-shares/${groupId}/overrides/${bobUserId}`,
    { data: { permission: 'view' } }
  );
  expect(r.status()).toBe(200);
  const { data } = await (await bobApi.get(`${BASE}/api/planners/${sharedPlannerId}`)).json();
  const put = await bobApi.put(`${BASE}/api/planners/${sharedPlannerId}`, { data });
  expect(put.status()).toBe(403);
});

test('§5.7 effective permission reflects override', async () => {
  const list = await (await bobApi.get(`${BASE}/api/planners`)).json();
  const p = list.find((x: { id: number }) => x.id === sharedPlannerId);
  expect(p.permission).toBe('view');
});

test('§5.8 remove override restores edit access', async () => {
  const del = await aliceApi.delete(
    `${BASE}/api/planners/${sharedPlannerId}/shares/group-shares/${groupId}/overrides/${bobUserId}`
  );
  expect(del.status()).toBe(200);
  const { data } = await (await bobApi.get(`${BASE}/api/planners/${sharedPlannerId}`)).json();
  const put = await bobApi.put(`${BASE}/api/planners/${sharedPlannerId}`, { data });
  expect(put.status()).toBe(200);
});

test('§5.9 detach group — bob loses access', async () => {
  const r = await aliceApi.delete(
    `${BASE}/api/planners/${sharedPlannerId}/shares/group-shares/${groupId}`
  );
  expect(r.status()).toBe(200);
  const get = await bobApi.get(`${BASE}/api/planners/${sharedPlannerId}`);
  expect(get.status()).toBe(403);
});

test('§5.10 re-attach then detach cleanly', async () => {
  await aliceApi.post(`${BASE}/api/planners/${sharedPlannerId}/shares/group-shares`, {
    data: { group_id: groupId, default_permission: 'view' },
  });
  expect((await bobApi.get(`${BASE}/api/planners/${sharedPlannerId}`)).status()).toBe(200);
  await aliceApi.delete(`${BASE}/api/planners/${sharedPlannerId}/shares/group-shares/${groupId}`);
});

// ═══════════════════════════════════════════════════════════════════════════════
// §6  ACTIVITY CREATOR TRACKING
// ═══════════════════════════════════════════════════════════════════════════════

test('§6.1 activities created by alice have createdBy="alice"', async () => {
  const { data } = await (await aliceApi.get(`${BASE}/api/planners/${sharedPlannerId}`)).json();
  const acts = data.lanes.flatMap((l: { activities: { createdBy: string }[] }) => l.activities);
  expect(acts.length).toBeGreaterThan(0);
  for (const a of acts) {
    expect(a.createdBy).toBe('alice');
  }
});

test('§6.2 createdBy preserved after bob edits via PUT', async () => {
  await aliceApi.post(`${BASE}/api/planners/${sharedPlannerId}/shares`, {
    data: { email: 'bob@test.local', permission: 'edit' },
  });
  const { data } = await (await bobApi.get(`${BASE}/api/planners/${sharedPlannerId}`)).json();
  const lane = data.lanes[0];
  const modifiedLanes = [{
    ...lane,
    activities: lane.activities.map((a: { title: string }, i: number) =>
      i === 0 ? { ...a, title: 'Feature A — Edited by Bob' } : a
    ),
  }];
  await bobApi.put(`${BASE}/api/planners/${sharedPlannerId}`, { data: { lanes: modifiedLanes } });
  const refetch = await (await aliceApi.get(`${BASE}/api/planners/${sharedPlannerId}`)).json();
  const editedAct = refetch.data.lanes[0].activities[0];
  expect(editedAct.title).toBe('Feature A — Edited by Bob');
  expect(editedAct.createdBy).toBe('alice');
  await aliceApi.delete(`${BASE}/api/planners/${sharedPlannerId}/shares/${bobUserId}`);
});

test('§6.3 createdBy shown in activity dialog', async () => {
  await alicePage.goto(`/planner.html?id=${sharedPlannerId}`);
  await alicePage.click('button[title="Timeline list view"]');
  await alicePage.click('text=Feature A');
  await expect(alicePage.locator('text=Created by alice')).toBeVisible({ timeout: 3000 });
  await alicePage.keyboard.press('Escape');
});

// ═══════════════════════════════════════════════════════════════════════════════
// §7  UI SMOKE — PLANNER INTERACTIONS
// ═══════════════════════════════════════════════════════════════════════════════

test('§7.1 zoom button changes viewport label', async () => {
  await alicePage.goto(`/planner.html?id=${sharedPlannerId}`);
  await alicePage.click('button[title="Disc view"]');
  await alicePage.waitForTimeout(300);
  const initialLabel = await alicePage.locator('.cp-viewport-label').textContent();
  await alicePage.click('button[title="Zoom in"]');
  await alicePage.waitForTimeout(300);
  const zoomedLabel = await alicePage.locator('.cp-viewport-label').textContent();
  expect(zoomedLabel).not.toBe(initialLabel);
});

test('§7.2 navigation buttons shift the viewport', async () => {
  const label1 = await alicePage.locator('.cp-viewport-label').textContent();
  await alicePage.click('button[title="Navigate forward"]');
  await alicePage.waitForTimeout(300);
  const label2 = await alicePage.locator('.cp-viewport-label').textContent();
  expect(label2).not.toBe(label1);
  await alicePage.click('button[title="Navigate backward"]');
});

test('§7.3 year selector jumps to selected year', async () => {
  const yearSel = alicePage.locator('select[title="Jump to year"]');
  await yearSel.selectOption('2027');
  await alicePage.waitForTimeout(300);
  const label = await alicePage.locator('.cp-viewport-label').textContent();
  expect(label).toContain('2027');
});

test('§7.4 search filters activities', async () => {
  await alicePage.click('button[title="Timeline list view"]');
  await expect(alicePage.locator('text=Feature A')).toBeVisible();
  await alicePage.fill('.cp-filter-input', 'zzz-no-match');
  await alicePage.waitForTimeout(350);
  await expect(alicePage.locator('text=Feature A')).not.toBeVisible();
  await alicePage.fill('.cp-filter-input', '');
  await alicePage.waitForTimeout(350);
  await expect(alicePage.locator('text=Feature A')).toBeVisible();
});

test('§7.5 list view toggle switches views', async () => {
  await alicePage.click('button[title="Disc view"]');
  await expect(alicePage.locator('svg').first()).toBeVisible({ timeout: 3000 });
  await alicePage.click('button[title="Timeline list view"]');
  await expect(alicePage.locator('text=Feature A')).toBeVisible({ timeout: 3000 });
});

test('§7.6 dark mode toggle changes theme attribute', async () => {
  const themeBtn = alicePage.locator('#theme-toggle');
  await themeBtn.click();
  await expect(alicePage.locator('html')).toHaveAttribute('data-theme', 'dark');
  await themeBtn.click();
  await expect(alicePage.locator('html')).not.toHaveAttribute('data-theme', 'dark');
});

test('§7.7 share dialog opens with Users tab active', async () => {
  await alicePage.click('#share-btn');
  await expect(alicePage.locator('#share-overlay')).toBeVisible();
  await expect(alicePage.locator('#share-panel-users')).toBeVisible();
  await expect(alicePage.locator('#share-panel-groups')).not.toBeVisible();
});

test('§7.8 share dialog Groups tab shows group dropdown', async () => {
  await alicePage.click('#share-tab-groups');
  await expect(alicePage.locator('#share-panel-groups')).toBeVisible();
  await expect(alicePage.locator('#share-group-select option:not([value=""])')).toBeVisible({ timeout: 3000 });
  await alicePage.press('Escape');
});

// ═══════════════════════════════════════════════════════════════════════════════
// §8  EDGE CASES & ERROR HANDLING
// ═══════════════════════════════════════════════════════════════════════════════

test('§8.1 invalid planner ID in URL shows error', async () => {
  await alicePage.goto('/planner.html?id=99999');
  await expect(alicePage.locator('#planner-error')).toBeVisible({ timeout: 5000 });
});

test('§8.2 planner page without id redirects to dashboard', async () => {
  await alicePage.goto('/planner.html');
  await alicePage.waitForURL('**/dashboard.html', { timeout: 5000 });
});

test('§8.3 API: non-numeric planner ID returns 400', async () => {
  const r = await aliceApi.get(`${BASE}/api/planners/abc`);
  expect(r.status()).toBe(400);
});

test('§8.4 API: non-existent planner returns 404', async () => {
  const r = await aliceApi.get(`${BASE}/api/planners/99999`);
  expect(r.status()).toBe(404);
});

test('§8.5 create group with empty name returns 400', async () => {
  const r = await aliceApi.post(`${BASE}/api/groups`, { data: { name: '' } });
  expect(r.status()).toBe(400);
});

test('§8.6 share to own planner returns 400', async () => {
  const r = await aliceApi.post(`${BASE}/api/planners/${sharedPlannerId}/shares`, {
    data: { email: 'alice@test.local', permission: 'view' },
  });
  expect(r.status()).toBe(400);
});

test('§8.7 rate limiting blocks excessive login attempts', async ({ request }) => {
  // Loopback is always exempt; spoof a remote IP via X-Forwarded-For.
  // Use a unique email per run so the counter always starts at zero.
  const testEmail = `ratelimit_${Date.now()}@test.local`;
  let lastStatus = 0;
  for (let i = 0; i < 21; i++) {
    const r = await request.post(`${BASE}/api/auth/login`, {
      data: { email: testEmail, password: 'wrong' },
      headers: { 'X-Forwarded-For': '203.0.113.42' },
    });
    lastStatus = r.status();
  }
  expect(lastStatus).toBe(429);
});

// ═══════════════════════════════════════════════════════════════════════════════
// §9  GROUPS PAGE UI
// ═══════════════════════════════════════════════════════════════════════════════

test('§9.1 groups list page loads and shows Team Alpha', async () => {
  await alicePage.goto('/groups.html');
  await expect(alicePage.locator('text=Team Alpha')).toBeVisible({ timeout: 5000 });
});

test('§9.2 group detail page shows members and admin controls', async () => {
  await alicePage.goto(`/groups.html?id=${groupId}`);
  await expect(alicePage.locator('#detail-name')).toHaveText('Team Alpha');
  await expect(alicePage.locator('#add-member-form')).toBeVisible();
  await expect(alicePage.locator('#edit-group-btn')).toBeVisible();
  await expect(alicePage.locator('#delete-group-btn')).toBeVisible();
});

test('§9.3 non-admin member does not see admin controls', async () => {
  await aliceApi.post(`${BASE}/api/groups/${groupId}/members`, {
    data: { user_id: carolUserId, role: 'member' },
  });
  await carolPage.goto(`/groups.html?id=${groupId}`);
  await expect(carolPage.locator('#detail-name')).toHaveText('Team Alpha');
  await expect(carolPage.locator('#add-member-form')).not.toBeVisible();
  await expect(carolPage.locator('#edit-group-btn')).not.toBeVisible();
});

test('§9.4 user search in add-member form works', async () => {
  await alicePage.goto(`/groups.html?id=${groupId}`);
  await alicePage.fill('#member-search', 'car');
  await alicePage.waitForTimeout(350);
  await expect(alicePage.locator('#member-search-results')).toBeVisible();
  await expect(alicePage.locator('#member-search-results')).not.toHaveClass(/hidden/);
});

test('§9.5 edit group name via UI', async () => {
  await alicePage.click('#edit-group-btn');
  await expect(alicePage.locator('#edit-form-wrap')).toBeVisible();
  await alicePage.fill('#edit-name-input', 'Team Alpha v2');
  await alicePage.click('#edit-save-btn');
  await expect(alicePage.locator('#detail-name')).toHaveText('Team Alpha v2', { timeout: 5000 });
  await alicePage.click('#edit-group-btn');
  await alicePage.fill('#edit-name-input', 'Team Alpha');
  await alicePage.click('#edit-save-btn');
});
