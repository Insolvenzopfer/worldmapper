# 🗺️ WorldMap v2 – Kartenbetrachter

Selbst gehosteter, dynamischer Karten-Viewer für eigene Welten.

## 🚀 Starten

```bash
# 1. Entpacken & ins Verzeichnis wechseln
cd worldmap2

# 2. Umgebungsvariablen anpassen
cp .env.example .env
# Editiere .env und ändere DB_PASSWORD und JWT_SECRET!

# 3. Container starten
docker compose up -d --build

# 4. Browser öffnen
open http://localhost:8080
```

## 🔐 Standard-Login

| Feld       | Wert       |
|-----------|------------|
| Benutzer  | `admin`    |
| Passwort  | `admin123` |

> ⚠️ **Passwort sofort nach dem ersten Login ändern!**

## 📖 Features

| Feature | Beschreibung |
|---|---|
| **Benutzerverwaltung** | Super-Admin erstellt Benutzer, verwaltet Passwörter |
| **Passwort ändern** | Jeder Benutzer kann sein Passwort mit Bestätigung des alten ändern |
| **Nur Super-Admin** kann Karten erstellen | Normale Admins können nur zugewiesene Karten bearbeiten |
| **Karten-Link** | Kurzer 8-Zeichen-Token: `map.html?t=aBcD1234` |
| **Gruppen-Links** | Isolierter Link pro Gruppe – Besucher sehen NUR ihre Gruppe |
| **POI-Icons** | 20+ verschiedene Symbole (Stadt, Burg, Taverne, usw.) |
| **POI/Region Sichtbarkeit** | Public / Nur Gruppe / Versteckt (nur Editor) |
| **Routen mit Wegpunkten** | Punkt für Punkt, jeder Punkt hat Titel & Info-Text |
| **Route-Stile** | Durchgezogen, Gestrichelt, Gepunktet + gerundete Kurven |
| **Fog of War** | Pinsel-basiert, pro Gruppe, weiche Übergänge |
| **Seitenleiste** | POI/Route/Region/Nebel pro Gruppe einzeln ein-/ausschaltbar |
| **Echtzeit** | Socket.io – jede Änderung sofort für alle Besucher |
| **Backup** | Vollständiger JSON-Export aller Kartendaten |
| **SQL-Injection-Schutz** | Parametrisierte Queries überall, Input-Sanitisierung |

## 🏗️ Architektur

```
Browser → nginx (Port 8080)
            ├── /api/*       → Node.js/Express (Port 3000)
            ├── /socket.io/* → Socket.io (WebSocket)
            └── /uploads/*   → Statische Dateien
                                    ↕
                               PostgreSQL 15
```

## 💾 Backup & Restore

```bash
# Datenbank-Backup
docker exec worldmap2-db-1 pg_dump -U worldmap worldmap > db_backup.sql

# Bilder sichern
docker cp worldmap2-backend-1:/app/uploads ./uploads_backup/

# Karten-JSON-Export: Dashboard → Einstellungen → Backup-Tab
```

## 🔒 Sicherheit

- Alle Datenbankabfragen parametrisiert (kein SQL-Injection möglich)
- Alle Benutzereingaben werden serverseitig validiert und begrenzt
- JWT-Tokens (30 Tage), sicher signiert
- Passwörter mit bcrypt gehasht (10 Runden)
- Datei-Uploads auf Bilder beschränkt, UUID-Dateinamen
- Kein direkter Datenbankzugriff von außen (internes Docker-Netzwerk)

## 📁 Umgebungsvariablen (.env)

| Variable     | Standard                              | Beschreibung           |
|-------------|---------------------------------------|------------------------|
| DB_PASSWORD | `worldmap_secret`                     | Datenbankpasswort      |
| JWT_SECRET  | `please-change-this-secret-...`       | JWT-Signierungsgeheimnis |
| APP_PORT    | `8080`                                | Externer Port          |
