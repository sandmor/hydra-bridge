# hydra-bridge

Tiny Express + TypeScript app that bridges Ory Hydra (OAuth2/OIDC) with Kratos sessions for login/consent.

## Quick start

Dev:
```bash
npm install
npm run dev
```

Build & run:
```bash
npm run build
npm start
```

Health: GET /healthz (PORT defaults to 8080)

## Env

Copy `.env.example` to `.env` and set:
- HYDRA_ADMIN_URL (e.g. http://hydra:4445)
- KRATOS_PUBLIC_URL (e.g. http://kratos:4433)
- AUTH_UI_ORIGIN (your SPA)
- BASE_PUBLIC_ORIGIN (this service’s public origin)
- PORT (optional)

## Docker

Dev (localhost):
```bash
docker compose up --build
```

Prod-like (no host port):
```bash
docker compose -f docker-compose.yml up --build
```

What happens:
- Compose reads `.env`
- Dev publishes http://localhost:8080
- Base file uses `expose` + networks (`idp`, `proxy`)

Verify `.env`:
- Startup logs include: `hydra-bridge listening on <port> (env: HYDRA_ADMIN_URL=..., KRATOS_PUBLIC_URL=...)`

Plain Docker:
```bash
docker build -t hydra-bridge:local .
docker run --rm -p 8080:8080 --env-file .env hydra-bridge:local
```

## Tips

- Node 18+ has global fetch
- `app.set('trust proxy', true)` is on (use correct X-Forwarded-* headers)

## License

MIT