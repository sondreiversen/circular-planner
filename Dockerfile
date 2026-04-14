# Stage 1 — build the frontend (Node)
FROM node:20.18-alpine AS frontend
WORKDIR /build
COPY package*.json ./
RUN npm ci
COPY client/ client/
COPY public/ public/
COPY tsconfig*.json ./
RUN npm run build:client

# Stage 2 — build the Go binary
FROM golang:1.22-alpine AS builder
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=frontend /build/public/js/ public/js/
RUN CGO_ENABLED=0 GOOS=linux go build -o /planner .

# Stage 3 — minimal runtime image
FROM alpine:3.19
RUN addgroup -S planner && adduser -S planner -G planner
WORKDIR /home/planner
COPY --from=builder --chown=planner:planner /planner ./planner
RUN mkdir -p data && chown planner:planner data
USER planner
EXPOSE 3000
CMD ["./planner"]
