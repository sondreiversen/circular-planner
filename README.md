# Circular Planner

A collaborative circular (Plandisc-style) planner web application. Visualise activities as arcs on a disc, organised into concentric lanes, with zoom levels from year down to week.

## Features

- **Circular disc visualisation** — time runs clockwise from 12 o'clock
- **Zoom levels** — Year → Quarter → Month → Week
- **Concentric lanes** — organise activities by team, project, or theme
- **Colour-coded activities** — with titles, descriptions and date ranges
- **Filters** — toggle lane visibility and search by activity title
- **User accounts** — register, login, create and manage multiple planners
- **Sharing** — share planners with other users (view or edit access)
- **Persistent storage** — PostgreSQL backend

## Quick Start

### Option 1 — Install script (bare Node.js + PostgreSQL)

Requires: Node.js 18+, PostgreSQL running locally.

```bash
git clone <repo-url>
cd circular-planner
./install.sh
npm start
```

Open http://localhost:3000, register an account and create your first planner.

### Option 2 — Docker Compose

Requires: Docker and Docker Compose.

```bash
git clone <repo-url>
cd circular-planner
docker compose up --build
```

Open http://localhost:3000.

To set a custom JWT secret or port:
```bash
JWT_SECRET=my-secret PORT=8080 docker compose up --build
```

## Development

```bash
npm install
cp .env.example .env   # edit DATABASE_URL if needed
npm run dev            # starts server (nodemon) + webpack watch concurrently
```

Open http://localhost:9000 (webpack dev server proxies API calls to port 3000).

## Project Structure

```
server/         Express API (auth, planners, sharing) + PostgreSQL migrations
client/src/     TypeScript frontend (D3.js rendering, planner logic)
public/         Static HTML pages and CSS
dist/           Build output (gitignored)
install.sh      One-command setup for bare Node.js deployments
Dockerfile      Container image
docker-compose.yml  App + PostgreSQL services
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `postgresql://localhost:5432/circular_planner` | PostgreSQL connection string |
| `JWT_SECRET` | *(insecure default)* | Secret for signing JWT tokens — **change in production** |
| `PORT` | `3000` | HTTP port |
