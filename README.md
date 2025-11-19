## Tripay Callback Service

Service Node.js ringan untuk menerima callback Tripay dan memperbarui data transaksi di Supabase. Folder ini bisa dijadikan repo terpisah dan dideploy di VPS/EC2 dengan IP publik tetap.

### Konfigurasi

1. Salin `.env.example` menjadi `.env` dan isi:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `TRIPAY_PRIVATE_KEY`

2. Install dependensi:

```bash
npm install
```

3. Jalanan lokal:

```bash
npm start
```

Service akan listen di `http://localhost:4000` (bisa diubah dengan `PORT`).

Endpoint:
- `GET /healthz` → cek sehat
- `POST /tripay/callback` → endpoint callback Tripay (verifikasi HMAC + update Supabase)

Untuk produksi, biasanya service ini dijalankan di belakang Nginx/HTTPS dan dikelola dengan prosess manager seperti `pm2`.

