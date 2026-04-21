# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

- **go-backend**: reached parity with main — ported 25 UX/ops/reliability improvements, the groups feature, and APP_NAME/APP_LOGO_URL customization. Retains SQLite-default + embedded static assets + air-gap deployment model.

## [0.5.0] - 2026-04-20

### Added
- Groups and group-based planner sharing — invite a group instead of individual users; activity creator is now tracked and displayed.
- Customizable app name and logo via `APP_NAME` and `APP_LOGO_URL` environment variables, enabling white-label deployments without code changes.

## [0.4.0] - 2025-12-01

### Added
- Air-gapped installer: packages all dependencies for offline Debian/Ubuntu deployment.

### Fixed
- Air-gapped installer failed on Debian/Ubuntu systems due to missing package resolution step.
- `docker-compose` invocation in installer used a conflicting same-file flag; corrected to `docker compose`.

## [0.3.0] - 2025-11-01

### Fixed
- Docker container bound only to IPv6 (`::`) on some hosts, making the service unreachable over IPv4. Port now explicitly bound to `0.0.0.0`.

[Unreleased]: https://github.com/example/circular-planner/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/example/circular-planner/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/example/circular-planner/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/example/circular-planner/releases/tag/v0.3.0
