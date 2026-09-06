# LLP Premium Store — Render + Turso

## Render
Build Command: `npm install`
Start Command: `npm start`

Required Environment Variables:
- `TURSO_DATABASE_URL`
- `TURSO_AUTH_TOKEN`
- `SESSION_SECRET`
- `ADMIN_SECRET_FALLBACK_PASSWORD` (only used when the Turso `admin` table is empty)
- `NODE_ENV=production`

## Important
- No Groq API key, OpenAI API key, Gemini API key, or other external AI API is used.
- The shopping bot is implemented in server-side JavaScript and uses live Turso product/settings/order data.
- Product uploads are held in memory and stored in Turso as data URLs, so they do not depend on Render's ephemeral disk.
- The LLP circular logo is intentionally fixed. There is no logo-change control in Admin Settings.
- The public site does not expose an Admin Panel link. Open `/admin/login` directly.
