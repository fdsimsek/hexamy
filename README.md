# HaxBall - LAN Multiplayer

Tarayici tabanli, LAN uzerinden cok oyunculu HaxBall oyunu. Ataturk Olimpiyat Stadi haritasi.

## Ozellikler

- 2-8 oyuncu (takim basi 1-4 kisi)
- Lobi sistemi (takim secimi, oda sahibi maci baslatir)
- Gercek zamanli fizik motoru (WebSocket)
- Ilk 5 golu atan takim kazanir

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

## Teknolojiler

- **Sunucu:** Node.js, Express, WebSocket (ws)
- **Istemci:** Vanilla JS, Canvas API
