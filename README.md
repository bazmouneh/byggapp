# Byggapp – uppdatering med schema, tilldelning och incheckning

## Installation på befintlig Windows-dator

1. Stoppa servern med Ctrl+C.
2. Säkerhetskopiera `C:\Users\Owner\byggapp` och Neon-databasen.
3. Kopiera innehållet i ZIP-paketets `backend` och `admin` till samma mappar i ditt projekt. **Ersätt inte din befintliga `.env`.**
4. Öppna PowerShell och kör:

```powershell
cd C:\Users\Owner\byggapp\backend
npm install
node migrate.js
node index.js
```

5. Öppna http://localhost:4000/login. Som admin: skapa kund, arbetsorder, tilldela via **Schema** och ange datum/tid. Som anställd: öppna **Mitt arbetsschema**, checka in, starta/avsluta rast och checka ut.

## Ändringar
- Kundnummer och projektnummer skapas av servern med unika sekvenser; befintliga kunder får kundnummer vid migrering.
- Service, entreprenad, jour, underhåll och övrigt; färdiga arbetsmoment.
- Administratör tilldelar arbetsorder till anställda och schemalägger datum/tid.
- Personal ser endast tilldelade öppna jobb och kan skapa nya arbetsorder (som admin sedan kan tilldela).
- Materialkatalog per företag, egna material tillåtna.
- Rast startas och avslutas med knappar; minuter beräknas på servern. Arbetstider sparas exakt, endast kundens fakturaunderlag avrundas.

## Viktiga begränsningar
- Lokal utvecklingsversion, inte färdig för offentlig drift. Mobil push, notifieringar, automatiskt fakturautskick och verklig kalenderintegration är inte byggda.
- Administratörens arbetsorder tilldelas manuellt, inga pushnotiser skickas ännu.
- Säkerhetsgranska, testa mot en separat testdatabas, och säkerställ återställningsrutiner innan produktion.
- Byt det tidigare exponerade Neon-databaslösenordet och uppdatera `.env` lokalt.


## Uppdatering 2.2 – paus, namn och faktura
- Personalen kan pausa en tilldelad arbetsorder efter utcheckning och återuppta den senare.
- Admin skapar och ändrar personalens fullständiga namn.
- Admin kan ange fakturauppgifter, ladda upp PNG/JPG-logotyp, skapa PDF-faktura och skicka med SMTP.
- Installera: säkerhetskopiera filer och databas; behåll `.env`; kör `npm install`, `node migrate.js`, `node index.js` i backend.
- För att skicka e-post krävs `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` i `.env`. Använd ett särskilt app-lösenord hos e-postleverantören. Utan SMTP fungerar PDF-export, men inte utskick.
- Fakturan beräknar moms med inställd procentsats; ROT är preliminärt och kräver manuell kontroll. Systemet är en prototyp, inte ett verifierat bokförings-/faktureringssystem. Kontrollera lagkrav, F-skatt, fakturauppgifter och betalningsuppgifter före användning med verkliga kunder.
- Viktigt: det tidigare exponerade Neon-lösenordet måste bytas före internetpublicering.

## Uppdatering november 2026
- Endast admin kan skapa arbetsorder (personalens POST-route borttagen).
- Adminfliken **Löner** visar faktiska arbetstimmar per anställd/månad, uppdelat i ordinarie/jour/övertid, och skapar PDF-utkast till lönespecifikation. Utkast kan skickas via SMTP till den anställdes registrerade e-post efter bekräftelse.
- Timlön, skatteavdrag och justering anges manuellt. Detta är INTE ett färdigt löne-/skattesystem; OB, semesterersättning, arbetsgivaravgifter och andra skyldigheter måste kontrolleras före utbetalning.
- ROT väljs endast vid fakturautkast. Beräknas preliminärt med 30 % av rabatterad arbetskostnad inklusive moms; villkor, ROT-utrymme, kund/personnummer, fastighetsbeteckning och skattehantering måste kontrolleras före skarp fakturering. För full ROT-fakturering behövs fler kunduppgifter och korrekt fakturauppställning.
- Gränssnittets layout moderniserad med befintliga färger.
- Fix för PostgreSQL 42P18 i projektregistrering och fakturainställningar.

### Installation
Stoppa servern. Säkerhetskopiera backend/admin och databasen. Ersätt backend/ och admin/ med innehållet i detta paket, **behåll din befintliga backend/.env**. Kör `npm install`, `node migrate.js`, `node index.js` i backend. Kör inte migrering mot produktion utan säkerhetskopia. SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/SMTP_FROM behövs för e-postutskick.

## Korrigering av löne-PDF
- Åtgärdar `Serverfel: rate is not defined` vid skapande av lönespecifikation.
- Varje lönerad använder sparad timlön för sin löneart, med ordinarie timlön som reserv för okänd löneart.
- Ingen ny migrering behövs. Behåll `.env`.
