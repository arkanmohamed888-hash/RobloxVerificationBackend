# Roblox verification backend

This backend works with the Discord bot project previously provided.

## Local setup
1. Install Node.js 20+.
2. Copy `.env.example` to `.env`.
3. Fill in the Discord bot token, server ID, citizen role ID.
4. Set `BACKEND_API_KEY` to exactly the same secret used in the bot's `.env`.
5. Set a separate strong `ROBLOX_API_KEY`.
6. Run `npm install`, then `npm start`.
7. Test `GET /health`.

## Railway deployment
1. Upload these files to a separate GitHub repository.
2. Railway > New Project > Deploy from GitHub Repo.
3. Add all variables from `.env.example` in Railway Variables.
4. Add a Railway Volume mounted at `/data`.
5. Set `DB_PATH=/data/verification.sqlite`.
6. Generate a public domain in Railway Networking.
7. Set that public URL as `BACKEND_URL` in the Discord bot service variables.

## Required endpoints
- `POST /roblox/create-code`: header `x-api-key: ROBLOX_API_KEY`, JSON `{ "robloxUserId": "123" }`
- `POST /discord/verify`: header `Authorization: Bearer BACKEND_API_KEY`, JSON `{ "code": "123456", "discordUserId": "...", "guildId": "..." }`
- `POST /roblox/check`: header `x-api-key: ROBLOX_API_KEY`, JSON `{ "robloxUserId": "123" }`

## Security
- Keep all secrets in Railway Variables or local `.env`; never put them in Roblox LocalScripts or publish them.
- The Roblox HTTP requests must originate from server-side Scripts.
- Do not use the example secrets. Generate long random values.
- The backend fails closed: if Discord cannot be reached, access is not granted.
