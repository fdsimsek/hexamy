# HaxBall - LAN Multiplayer

Tarayici tabanli, LAN uzerinden cok oyunculu HaxBall oyunu. Ataturk Olimpiyat Stadi haritasi.

## Ozellikler

- Coklu oda sistemi (tek sunucu icinde birden fazla bagimsiz oda)
- Casual + Ranked oda tipi
- Oda olusturma ve opsiyonel oda sifresi
- Oda listesi uzerinden katilim (sifreliyse sifre girisli)
- Odaya giren oyuncu varsayilan olarak izleyici olur; takim secince oyuna girer
- Her odada 2-8 oyuncu (takim basi 1-4 kisi)
- Gercek zamanli fizik motoru (WebSocket)
- Ilk 5 golu atan takim kazanir
- Reconnect token ile kisa sureli baglanti geri donusu
- Chat moderation + host mute/kick araclari
- Sezonluk leaderboard ve temel ELO takibi (ranked odalar)

## Kurulum

```bash
git clone https://github.com/fdsimsek/hexamy.git
cd hexamy
npm install
```

## Baslatma

```bash
npm start
```

Sunucu basladiktan sonra terminalde su adresleri goreceksin:

```
Yerel:  http://localhost:3000
LAN:    http://<senin-ip-adresin>:3000
```

- **Ayni bilgisayar:** Tarayicida `http://localhost:3000` ac
- **Ayni agdaki arkadaslar:** LAN adresini paylas, tarayicidan acsinlar

## Oda Akisi

1. Kullanici adini gir.
2. Oda listesinden bir oda sec veya yeni oda olustur.
3. Oda sifreliyse sifre gir.
4. Odaya girdiginde izleyici olarak gorunursun.
5. Kirmizi/Mavi takima gecince aktif oyuncu olarak maca dahil olursun.

### Port 3000 zaten kullanimda hatasi

`npm start` yazinca "EADDRINUSE: address already in use" hatasi aliyorsan, once 3000 portunu kullanan islemi kapat:

**Windows (PowerShell):**
```powershell
Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

Sonra tekrar `npm start` calistir.

## Kontroller

| Aksiyon | Tuslar |
|---------|--------|
| Hareket | `W` `A` `S` `D` veya `Arrow` tuslari |
| Sut | `Space` veya `L` |
| Quick Chat | `7` `8` `9` `0` |
| Spectator Kamera Modu | `C` |

## Production Notlari

- Health: `GET /healthz`
- Readiness: `GET /readyz`
- Metrics (Prometheus format): `GET /metrics`
- Leaderboard API: `GET /api/leaderboard`

### Onemli ENV'ler

- `ALLOWED_ORIGINS` (virgulle ayir, production'da set et)
- `RECONNECT_TTL_MS` (default: 30000)
- `MAX_CONNECTIONS`
- `MAX_WS_PAYLOAD_BYTES`
- `RATE_LIMIT_*` ayarlari

## Teknolojiler

- **Sunucu:** Node.js, Express, WebSocket (ws)
- **Istemci:** Vanilla JS, Canvas API
