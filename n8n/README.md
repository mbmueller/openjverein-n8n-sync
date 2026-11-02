# n8n-Workflow

Importiere [`einwilligung-bildnutzung.json`](einwilligung-bildnutzung.json) in deine n8n-Instanz.

## Erwarteter Stand (working stack)

| Thema | Wert |
|-------|------|
| Webhook path | `einwilligung-bildnutzung` (POST) |
| Authentication | **None** (optional Secret-IF: leer / `CHANGE_ME_…` → pass) |
| Drive | OAuth nur in der n8n-UI; Ordner-IDs = Platzhalter im JSON |
| Upload | **Upload** + Binary-Feld `data` (Code-Nodes `Binär …` davor) |
| Ordner | `aktuell/` · `archiv/` (Parent für `YYYY-MM-DD/`) · `meta/` |

Nach Import: Credential + drei Folder-IDs setzen, Workflow aktivieren, Production-URL (`/webhook/…`, nicht `/webhook-test/…`) in lokale `.env` als `N8N_WEBHOOK_URL`.

Fehler `expects … binary file 'data'` → JSON aus diesem Repo **neu importieren**, nicht nur Credentials am alten Graph tauschen.

Details: Haupt-[README](../README.md).
