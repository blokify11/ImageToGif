# Image to GIF für Blokify

Web-App zum Umwandeln von Bildern in GIFs mit Drag-and-Drop-Upload.

## Features

- Upload via Drag and Drop oder Dateiauswahl
- Sofortige Umwandlung von Bild zu GIF
- Ergebnis-URL direkt kopierbar (auch per Klick auf das fertige GIF)
- Pfadbasiert unter `/imagetogif` nutzbar

## Lokal starten

```bash
npm install
npm start
```

Dann aufrufen:

- `http://localhost:3000/imagetogif/`

## API

- `POST /imagetogif/api/convert`
- Form-Field: `image` (Datei)
- Antwort:

```json
{
  "success": true,
  "url": "https://deine-domain/imagetogif/gifs/<id>.gif"
}
```

## Deployment unter blokify.net/imagetogif

Die App ist bereits auf den Basis-Pfad `/imagetogif` ausgelegt.

Wichtig: In Nginx muessen sowohl `/imagetogif` (ohne Slash) als auch `/imagetogif/` (mit Slash) behandelt werden, sonst entsteht ein 404 auf der Domain.

Beispiel Reverse-Proxy (Nginx):

```nginx
location = /imagetogif {
  return 301 /imagetogif/;
}

location ^~ /imagetogif/ {
  proxy_pass http://127.0.0.1:3000;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header X-Forwarded-Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

## Hinweise

- Erstellte GIFs werden im Ordner `gifs/` gespeichert.
- `gifs/` ist in `.gitignore` ausgeschlossen.
