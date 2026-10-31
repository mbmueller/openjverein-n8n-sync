# Mitwirken

Danke fürs Interesse an **openjverein-n8n-sync**. Beiträge (Issues, Pull Requests, Verbesserungsvorschläge) sind willkommen.

## Lizenz

Dieses Projekt steht unter der **[PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0/)** (siehe [`LICENSE`](LICENSE)).

- **Erlaubt:** nichtkommerzielle Nutzung, Anpassung und Weitergabe (z. B. Vereine, Hobby, Bildung).
- **Nicht erlaubt:** Verkauf der Software bzw. kommerzielle Weiterverbreitung.

Mit einem Beitrag bestätigst du, dass deine Änderungen unter derselben Lizenz veröffentlicht werden dürfen. Copyright liegt bei den Beitragenden (siehe Required Notice in [`LICENSE`](LICENSE)).

## Issues melden

1. Prüfe zuerst, ob es schon ein passendes [Issue](https://github.com/mbmueller/openjverein-n8n-sync/issues) gibt.
2. Beschreibe kurz: erwartetes vs. tatsächliches Verhalten, Betriebssystem, Jameica-/OpenJVerein-Version (falls relevant).
3. **Keine Secrets** in Issues posten (Webhook-URLs mit echten Hosts, Tokens, Drive-Credentials, echte DB-Pfade, `.env`-Inhalte).

## Pull-Request-Ablauf

1. Fork bzw. Branch vom aktuellen `main`.
2. Änderungen fokussiert halten (ein Thema pro PR).
3. In Commits und Diffs nur **Platzhalter** für n8n/Drive (wie in `.env.example` und `n8n/*.json`) — keine echten Secrets.
4. Kurz im PR beschreiben, was geändert wurde und wie du getestet hast.
5. Auf Review warten; Feedback freundlich umsetzen.

### Erwartetes Verhalten in der Community

Sei respektvoll und sachlich. Keine Beleidigungen, keine belästigenden Beiträge. Bei Unklarheiten reicht oft ein kurzes, konstruktives Issue.

## Keine Secrets im Git

| Darf ins Repo | Bleibt lokal / in n8n |
|---------------|------------------------|
| Platzhalter in `.env.example` | echte `.env` |
| Dummy-IDs in `n8n/*.json` | Drive-OAuth, echte Ordner-IDs |
| `N8N_HOST_PLACEHOLDER`, `CHANGE_ME_…` | echte Webhook-URL / Secrets |

Vor dem Commit: `git status` / Diff prüfen — `.env`, Tokens und personenbezogene Exporte (`output/`, `outbox/` außer `.gitkeep`) gehören nicht ins Git (siehe `.gitignore`).

## Lokal testen (kurz)

Voraussetzungen: Python 3.10+, Java/H2-JAR, optional Jameica. Setup wie in der [README](README.md).

```bash
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r exporter/requirements.txt
cp .env.example .env
# .env mit lokalen Platzhalter-Werten füllen (keine echten Produktiv-Secrets nötig für Syntax-/Dry-Runs)
```

**Exporter** (nach Exit von Jameica, wenn H2 freigegeben ist — oder mit Test-DB-Pfad):

```bash
python exporter/export.py --trigger jameica_exit
python exporter/export.py --flush-only
```

**Jameica-Script** (Primärweg — siehe README):

```bash
chmod +x scripts/export-trigger.sh
# SYNC_ROOT in scripts/jameica-openjverein-sync.js setzen
# In Jameica: Datei → Einstellungen → Scripting → Script hinzufügen
./scripts/export-trigger.sh exit   # manueller Exit-Export-Test
```

**Wrapper** (optional/deprecated, nur Fallback):

```bash
./wrapper/jameica-wrapper.sh
```

n8n-Workflow: `n8n/einwilligung-bildnutzung.json` importieren, Drive-Credential und Ordner-IDs **nur in der n8n-UI** setzen, Webhook-Secret an lokale `.env` anbinden.

## Fragen?

Öffne ein Issue oder diskutiere im PR — lieber früh nachfragen als Secrets oder Breaking Changes unbemerkt einzubauen.
