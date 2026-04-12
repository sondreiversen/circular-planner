#!/usr/bin/env bash
set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'

echo ""
echo "============================================"
echo "   Circular Planner — Installation Script"
echo "============================================"
echo ""

# Check Node.js
if ! command -v node &>/dev/null; then
  echo -e "${RED}ERROR: Node.js not found.${NC}"
  echo "Install Node.js 18+ from https://nodejs.org/ and re-run this script."
  exit 1
fi
NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 18 ]; then
  echo -e "${RED}ERROR: Node.js 18+ required (found $(node -v)).${NC}"
  exit 1
fi
echo -e "${GREEN}✓ Node.js $(node -v)${NC}"

# Check psql
if ! command -v psql &>/dev/null; then
  echo -e "${RED}ERROR: psql (PostgreSQL client) not found.${NC}"
  echo "Install PostgreSQL and ensure psql is on your PATH."
  exit 1
fi
echo -e "${GREEN}✓ PostgreSQL client found${NC}"

# Install dependencies
echo ""
echo "Installing npm dependencies…"
npm install

# Generate .env if missing
if [ ! -f .env ]; then
  JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  cat > .env <<EOF
DATABASE_URL=postgresql://localhost:5432/circular_planner
JWT_SECRET=${JWT_SECRET}
PORT=3000
EOF
  echo -e "${GREEN}✓ Generated .env with a random JWT secret${NC}"
else
  echo -e "${YELLOW}⚠ .env already exists — skipping generation${NC}"
fi

# Create database
echo ""
echo "Creating database 'circular_planner' (if it doesn't exist)…"
if psql -U "${PGUSER:-postgres}" -tc "SELECT 1 FROM pg_database WHERE datname='circular_planner'" 2>/dev/null | grep -q 1; then
  echo -e "${YELLOW}⚠ Database already exists — skipping creation${NC}"
else
  psql -U "${PGUSER:-postgres}" -c "CREATE DATABASE circular_planner" 2>/dev/null || {
    echo -e "${RED}ERROR: Could not create database.${NC}"
    echo "Make sure PostgreSQL is running and the user '${PGUSER:-postgres}' has CREATE DATABASE rights."
    echo "Or create the database manually: createdb circular_planner"
    exit 1
  }
  echo -e "${GREEN}✓ Database created${NC}"
fi

# Build
echo ""
echo "Building the application…"
npm run build
echo -e "${GREEN}✓ Build complete${NC}"

echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}   Installation complete!${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo "Start the server:"
echo -e "  ${YELLOW}npm start${NC}          — production server"
echo -e "  ${YELLOW}npm run dev${NC}        — development (live reload)"
echo ""
echo "Then open http://localhost:3000"
echo ""
echo "To run with Docker instead:"
echo -e "  ${YELLOW}docker compose up --build${NC}"
echo ""
