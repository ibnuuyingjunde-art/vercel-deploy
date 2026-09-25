# Vercel Deploy Tool — Lianix Tools

Tool deploy ke Vercel + **MongoDB** untuk statistik & history deploy.

## Fitur

- Deploy project ke Vercel via REST API v13
- **Statistik global** (Total / Sukses / Building / Gagal) disimpan di MongoDB Atlas
- History deploy tersimpan di MongoDB (dengan fallback localStorage)
- Backend: `server.js` (Node.js built-in HTTP + MongoDB driver)

## Setup

1. Pastikan `.env` berisi kredensial MongoDB:

```env
MONGODB_URI="mongodb+srv://USER:PASS@cluster0.xxxxx.mongodb.net"
MONGODB_DB="vercel_deploy_tool"   # opsional
PORT=3000                         # opsional
```

2. Install dependency:

```bash
npm install
```

3. Jalankan server:

```bash
npm start
# atau
node server.js
```

4. Buka browser: **http://localhost:3000**

## API Endpoints

| Method | Path | Keterangan |
|--------|------|------------|
| GET | `/api/health` | Cek status server + MongoDB |
| GET | `/api/stats` | Statistik deploy (total, sukses, building, gagal) |
| GET | `/api/deploys?limit=40` | List history deploy |
| POST | `/api/deploys` | Simpan record deploy baru |
| PATCH | `/api/deploys/:id` | Update status / URL deploy |
| DELETE | `/api/deploys?confirm=yes` | Hapus semua history |

## Struktur

```
vercel-mongo-app/
├── server.js       # Backend Express-free + MongoDB
├── index.html      # Frontend UI
├── package.json
├── .env            # Kredensial (JANGAN commit)
└── README.md
```

## Catatan

- Token Vercel tetap disimpan di `localStorage` browser (tidak ke server).
- History & stats disinkronkan ke MongoDB setiap deploy / update status.
- Jika server offline, UI tetap jalan dengan data localStorage.
