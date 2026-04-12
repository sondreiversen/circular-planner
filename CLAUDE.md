# Circular Planner

A standalone full-stack web application — circular disc planner (Plandisc-style) with user accounts, PostgreSQL storage, and sharing.

## Build commands

```bash
npm run build          # build both client and server
npm run build:client   # webpack → dist/public/js/
npm run build:server   # tsc → dist/server/
npm run dev            # server (nodemon) + webpack watch, concurrently
npm start              # run compiled server (production)
npm run migrate        # run DB migrations manually
npm test               # Jest frontend tests
```

## Architecture

### Stack
- **Frontend**: Vanilla TypeScript + D3.js, webpack-bundled into three entry points (`planner`, `auth`, `dashboard`)
- **Backend**: Node.js + Express, TypeScript compiled with `tsc`
- **Database**: PostgreSQL — migrations run automatically on server start
- **Auth**: JWT tokens in `Authorization: Bearer` header, stored in `localStorage`

### Project structure

```
server/
  index.ts              Express app + auto-migration on startup
  config.ts             Env vars (DATABASE_URL, JWT_SECRET, PORT)
  db.ts                 pg Pool + query helper
  middleware/auth.ts    JWT verification middleware (attaches req.user)
  routes/auth.ts        POST /api/auth/register, /login; GET /me
  routes/planners.ts    CRUD for planners + transactional lane/activity sync
  routes/share.ts       Share management (GET/POST/DELETE)
  migrations/
    001-initial.sql     Schema (users, planners, lanes, activities, planner_shares)
    migrate.ts          Manual migration runner (npm run migrate)
client/src/
  index.ts              Planner page: fetch from API, init Planner
  planner.ts            Main controller (toolbar, state, CRUD, filters)
  renderer.ts           D3 SVG rendering (disc, lanes, arcs, seam shadow)
  viewport.ts           Zoom levels, navigation, grid specs
  dialogs.ts            Activity/lane modals (plain DOM)
  data-manager.ts       Saves to PUT /api/planners/:id
  api-client.ts         Centralized fetch + JWT token management
  auth.ts               Login/register page logic
  dashboard.ts          Planner list page logic
  types.ts              All TypeScript interfaces
  utils.ts              Date math, color palette, ID generation
public/
  index.html            Login/register page
  dashboard.html        Planner list
  planner.html          Planner view (loads planner by ?id=N)
  css/
    circular-planner.css  Disc/toolbar styles
    app.css               App chrome, auth, dashboard styles
```

### Data flow

1. User logs in → JWT stored in `localStorage` as `cp_token`
2. Dashboard fetches `GET /api/planners` (owned + shared)
3. Planner page fetches `GET /api/planners/:id` → gets `{ config, data }` → creates `Planner` instance
4. On data change, `DataManager.scheduleSave()` debounces then calls `PUT /api/planners/:id` with full `PlannerData`
5. Server does transactional upsert/delete sync of lanes and activities

### Database schema

```
users              id, username, email, password_hash
planners           id, owner_id → users, title, start_date, end_date
lanes              id (VARCHAR), planner_id → planners, name, sort_order, color
activities         id (VARCHAR), lane_id, planner_id, title, description, dates, color
planner_shares     planner_id, user_id, permission ('view'|'edit')
```

Lane and activity IDs are frontend-generated short strings (from `randomId()`), scoped to their planner — compound primary keys `(id, planner_id)`.

## Zoom and navigation

Four zoom levels: **Year → Quarter → Month → Week**

- **Year level**: slides month-by-month (not full-year jumps)
- **Year selector**: `<select>` in toolbar for jumping to a specific year
- **Custom date range**: in filter panel (▼ Filter), two date inputs + Apply
- **Keyboard**: Arrow left/right = navigate, up/down = zoom in/out
- **Scroll to zoom**: mouse wheel on the SVG

## Filtering

▼ Filter button reveals a secondary row with:
- Search input (debounced 200ms) — filters activity titles
- Per-lane checkboxes — toggle visibility (hidden lanes keep their slot)
- Custom date range picker

FilterState (`types.ts`) is ephemeral — not persisted.

## Visual design

- **Disc**: radial gradient background, drop shadow, SVG `<defs>` for all filters/gradients
- **Seam shadow**: narrow gradient arc at 12 o'clock makes end-of-range appear to float above start
- **Toolbar**: two rows — primary (nav/zoom/filter toggle) + collapsible secondary (filters/lanes)
- **Lane colours**: 8 vibrant options at ~0.25 opacity (`LANE_COLORS` in utils.ts)
- **Buttons**: CSS classes `cp-btn`, `cp-btn-primary`, `cp-btn-active` with hover transitions

## Important patterns

- `requireAuth` middleware reads `Authorization: Bearer <token>`, attaches `req.user`
- `api-client.ts` automatically adds the JWT header and redirects to `/index.html` on 401
- Server `PUT /api/planners/:id` is a last-write-wins full sync — no partial updates
- Migrations run automatically at server startup via `runMigrations()` in `server/index.ts`
- The SQL migration files must be `.sql` and are applied in alphabetical order

## Deployment

### Bare Node.js
```bash
./install.sh   # checks dependencies, installs, creates DB, builds
npm start
```

### Docker
```bash
docker compose up --build
```
Set `JWT_SECRET` in environment or `.env` before production deployment.
