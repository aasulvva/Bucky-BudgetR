// The app's version and What's New: one entry per version, newest first.
// Every PR adds one (docs/DEVELOPMENT.md, "Versions and What's New"):
// vX.YY.ZZ, where X goes up when a milestone is done, YY for a new feature
// and ZZ for a bugfix or minor change. The newest entry is the app's version.

import type { Language } from "./language";

export interface ChangelogEntry {
  /** vX.YY.ZZ */
  version: string;
  /** The day it was merged, yyyy-mm-dd. */
  date: string;
  title: Record<Language, string>;
  changes: Record<Language, string[]>;
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "v2.15.00",
    date: "2026-11-11",
    title: {
      en: "Reports: in/out/balance as cards, with account balances",
      nb: "Rapporter: inn/ut/saldo som kort, med kontosaldoer",
      nn: "Rapportar: inn/ut/saldo som kort, med kontosaldoar",
    },
    changes: {
      en: [
        "An in, out and balance module can now show a grid of cards instead of tables: one per bucket and account, with its change, where it started and ended, its in and out, and a total card. A bucket that ends below 0 is marked overspent. On a phone the cards stack, so nothing scrolls sideways.",
        "Show balances gives accounts their balance at the start and end of the period, in the grid and in the table. Other covers what else moved it, such as opening balances, adjustments and transfers that aren't counted, so the figures add up.",
        "An account or bucket opened during the period starts at its opening balance or funds, marked with when it opened, rather than at 0.",
      ],
      nb: [
        "En modul for inn, ut og saldo kan nå vise et rutenett med kort i stedet for tabeller: ett per bøtte og konto, med endringen, hvor den startet og sluttet, inn og ut, og et kort med totalen. En bøtte som slutter under 0, merkes som overforbrukt. På mobil legger kortene seg under hverandre, så ingenting ruller sidelengs.",
        "Vis saldoer gir kontoene saldoen ved start og slutt på perioden, i rutenettet og i tabellen. Annet dekker det andre som endret den, som åpningssaldoer, justeringer og overføringer som ikke telles med, så tallene går opp.",
        "En konto eller bøtte som ble åpnet i løpet av perioden, starter på åpningssaldoen eller startmidlene, merket med når den ble åpnet, i stedet for på 0.",
      ],
      nn: [
        "Ein modul for inn, ut og saldo kan no vise eit rutenett med kort i staden for tabellar: eitt per bøtte og konto, med endringa, kvar ho starta og slutta, inn og ut, og eit kort med totalen. Ei bøtte som sluttar under 0, vert merkt som overforbrukt. På mobil legg korta seg under kvarandre, så ingenting rullar sidelengs.",
        "Vis saldoar gjev kontoane saldoen ved start og slutt på perioden, i rutenettet og i tabellen. Anna dekkjer det andre som endra han, som opningssaldoar, justeringar og overføringar som ikkje vert talde med, så tala går opp.",
        "Ein konto eller ei bøtte som vart opna i løpet av perioden, startar på opningssaldoen eller startmidlane, merkt med når ho vart opna, i staden for på 0.",
      ],
    },
  },
  {
    version: "v2.14.00",
    date: "2026-11-10",
    title: {
      en: "Reports: transactions as a table",
      nb: "Rapporter: transaksjoner som tabell",
      nn: "Rapportar: transaksjonar som tabell",
    },
    changes: {
      en: [
        "A transactions module can now show a table instead of the list. Choose its columns and their order: date, time, type, counterparty, account, buckets, tags, description, amount, balance after (with one account) and notes.",
        "Each group (day, week, month or cycle) gets a subtotal, and the table a total, per currency. Show a row per transaction, with its buckets in one cell, or a row per bucket line. On a phone the table scrolls sideways with the first column in place, and in a PDF it fits the page.",
      ],
      nb: [
        "En transaksjonsmodul kan nå vise en tabell i stedet for listen. Velg kolonnene og rekkefølgen: dato, tid, type, motpart, konto, bøtter, tagger, beskrivelse, beløp, saldo etter (med én konto) og merknader.",
        "Hver gruppe (dag, uke, måned eller syklus) får en delsum, og tabellen en total, per valuta. Vis én rad per transaksjon, med bøttene i én celle, eller én rad per bøttelinje. På mobil ruller tabellen sidelengs med første kolonne på plass, og i en PDF passer den på siden.",
      ],
      nn: [
        "Ein transaksjonsmodul kan no vise ein tabell i staden for lista. Vel kolonnane og rekkjefølgja: dato, tid, type, motpart, konto, bøtter, taggar, skildring, beløp, saldo etter (med éin konto) og merknader.",
        "Kvar gruppe (dag, veke, månad eller syklus) får ein delsum, og tabellen ein total, per valuta. Vis éi rad per transaksjon, med bøttene i éi celle, eller éi rad per bøtteline. På mobil rullar tabellen sidelengs med første kolonne på plass, og i ein PDF passar han på sida.",
      ],
    },
  },
  {
    version: "v2.13.00",
    date: "2026-11-10",
    title: {
      en: "Reports: export to PDF",
      nb: "Rapporter: eksport til PDF",
      nn: "Rapportar: eksport til PDF",
    },
    changes: {
      en: [
        "Export PDF on a report makes a PDF of the report as it is on screen, saved or not. It starts with a cover page: the report's name, its period and what it compares with, its filters, its modules, who made it and when. Then come the modules, one after another, on A4 pages with page numbers.",
        "A transactions module has all of its transactions in the PDF, not just the first page. The PDF is always light, and uses your language, number and date format and time zone.",
      ],
      nb: [
        "Eksporter PDF på en rapport lager en PDF av rapporten slik den er på skjermen, lagret eller ikke. Den begynner med en forside: rapportens navn, perioden og hva den sammenlignes med, filtrene, modulene, hvem som laget den og når. Så kommer modulene etter hverandre, på A4-sider med sidetall.",
        "En transaksjonsmodul har alle transaksjonene sine i PDF-en, ikke bare den første siden. PDF-en er alltid lys, og bruker språket ditt, tall- og datoformatet ditt og tidssonen din.",
      ],
      nn: [
        "Eksporter PDF på ein rapport lagar ein PDF av rapporten slik han er på skjermen, lagra eller ikkje. Han byrjar med ei framside: namnet på rapporten, perioden og kva han vert samanlikna med, filtera, modulane, kven som laga han og når. Så kjem modulane etter kvarandre, på A4-sider med sidetal.",
        "Ein transaksjonsmodul har alle transaksjonane sine i PDF-en, ikkje berre den første sida. PDF-en er alltid lys, og bruker språket ditt, tal- og datoformatet ditt og tidssona di.",
      ],
    },
  },
  {
    version: "v2.12.00",
    date: "2026-11-10",
    title: {
      en: "Reports: budget vs spending",
      nb: "Rapporter: budsjett mot forbruk",
      nn: "Rapportar: budsjett mot forbruk",
    },
    changes: {
      en: [
        "A report can now show budget vs spending as a module: for each cycle in the period, each bucket's budget, what it used (with a bar), what was unspent and what carried over into the next cycle, with a total per currency. Buckets over budget are marked.",
        "A cycle counts in the period that holds most of its days, so it's in one year's report, not two. It's shown whole, and marked when it runs past the period or is still going.",
        "With more than one cycle, a summary over all of them comes first; turn off Show each cycle to see only the summary. It uses the report's accounts and buckets, or its own; tags and counterparty don't apply.",
      ],
      nb: [
        "En rapport kan nå vise budsjett mot forbruk som en modul: for hver syklus i perioden, hver bøttes budsjett, hva den brukte (med en stolpe), hva som var ubrukt og hva som ble med til neste syklus, med en total per valuta. Bøtter over budsjett er markert.",
        "En syklus teller i perioden som har flest av dagene dens, så den er med i én årsrapport, ikke to. Den vises hel, og er markert når den går utenfor perioden eller pågår.",
        "Med mer enn én syklus kommer en oppsummering over alle først; slå av Vis hver syklus for å se bare oppsummeringen. Den bruker rapportens kontoer og bøtter, eller sine egne; tagger og motpart gjelder ikke.",
      ],
      nn: [
        "Ein rapport kan no vise budsjett mot forbruk som ein modul: for kvar syklus i perioden, budsjettet til kvar bøtte, kva ho brukte (med ein stolpe), kva som var ubrukt og kva som vart med til neste syklus, med ein total per valuta. Bøtter over budsjett er markerte.",
        "Ein syklus tel i perioden som har flest av dagane hans, så han er med i éin årsrapport, ikkje to. Han vert vist heil, og er markert når han går utanfor perioden eller pågår.",
        "Med meir enn éin syklus kjem ei oppsummering over alle først; slå av Vis kvar syklus for å sjå berre oppsummeringa. Han bruker kontoane og bøttene til rapporten, eller sine eigne; taggar og motpart gjeld ikkje.",
      ],
    },
  },
  {
    version: "v2.11.00",
    date: "2026-11-10",
    title: {
      en: "Reports: in, out and balance",
      nb: "Rapporter: inn, ut og saldo",
      nn: "Rapportar: inn, ut og saldo",
    },
    changes: {
      en: [
        "A report can now show a table of money in and out as a module. Per bucket: what it had at the start, what came in (refills, income, opening funds, adjustments, moves), what went out (spending, overflow, adjustments, moves) and what it had at the end. Per account: income, expenses and the net, with transfers between accounts if you want them. Show buckets, accounts or both, and Show details for the parts of in and out.",
        "Each table has a total per currency, and a name opens its transactions. Break the module down by month or cycle to get a smaller table for each. It uses the report's accounts and buckets, or its own; tags and counterparty don't apply.",
      ],
      nb: [
        "En rapport kan nå vise en tabell over penger inn og ut som en modul. Per bøtte: hva den hadde ved start, hva som kom inn (påfyll, inntekt, startmidler, justeringer, flyttinger), hva som gikk ut (forbruk, overløp, justeringer, flyttinger) og hva den hadde ved slutt. Per konto: inntekter, utgifter og netto, med overføringer mellom kontoer om du vil. Vis bøtter, kontoer eller begge, og Vis detaljer for delene av inn og ut.",
        "Hver tabell har en total per valuta, og et navn åpner transaksjonene. Del modulen inn per måned eller syklus for å få en mindre tabell for hver. Den bruker rapportens kontoer og bøtter, eller sine egne; tagger og motpart gjelder ikke.",
      ],
      nn: [
        "Ein rapport kan no vise ein tabell over pengar inn og ut som ein modul. Per bøtte: kva ho hadde ved start, kva som kom inn (påfyll, inntekt, startmidlar, justeringar, flyttingar), kva som gjekk ut (forbruk, overløp, justeringar, flyttingar) og kva ho hadde ved slutt. Per konto: inntekter, utgifter og netto, med overføringar mellom kontoar om du vil. Vis bøtter, kontoar eller begge, og Vis detaljar for delane av inn og ut.",
        "Kvar tabell har ein total per valuta, og eit namn opnar transaksjonane. Del modulen inn per månad eller syklus for å få ein mindre tabell for kvar. Han bruker kontoane og bøttene til rapporten, eller sine eigne; taggar og motpart gjeld ikkje.",
      ],
    },
  },
  {
    version: "v2.10.00",
    date: "2026-11-10",
    title: {
      en: "Reports: a transactions module",
      nb: "Rapporter: en transaksjonsmodul",
      nn: "Rapportar: ein transaksjonsmodul",
    },
    changes: {
      en: [
        "A report can now list the period's transactions as a module, as the Transactions screen shows them. Filter it by accounts, buckets, tags, counterparty and type, or let it use the report's filters, and choose whether it shows refills & adjustments and reversed transactions. Group it by day, week, month or cycle, newest or oldest first.",
        "It shows the first 50, with Load more. Open in Transactions shows the same list there, and a transaction opens there too.",
      ],
      nb: [
        "En rapport kan nå vise periodens transaksjoner som en modul, slik Transaksjoner-skjermen viser dem. Filtrer på kontoer, bøtter, tagger, motpart og type, eller la den bruke rapportens filtre, og velg om den skal vise påfyll og justeringer og reverserte transaksjoner. Grupper den per dag, uke, måned eller syklus, med nyeste eller eldste først.",
        "Den viser de første 50, med Last inn flere. Åpne i Transaksjoner viser den samme listen der, og en transaksjon åpnes der også.",
      ],
      nn: [
        "Ein rapport kan no vise transaksjonane i perioden som ein modul, slik Transaksjonar-skjermen viser dei. Filtrer på kontoar, bøtter, taggar, motpart og type, eller la han bruke filtera til rapporten, og vel om han skal vise påfyll og justeringar og reverserte transaksjonar. Grupper han per dag, veke, månad eller syklus, med nyaste eller eldste først.",
        "Han viser dei første 50, med Last inn fleire. Opne i Transaksjonar viser den same lista der, og ein transaksjon vert opna der òg.",
      ],
    },
  },
  {
    version: "v2.09.00",
    date: "2026-11-09",
    title: {
      en: "Reports",
      nb: "Rapporter",
      nn: "Rapportar",
    },
    changes: {
      en: [
        "Stats & reports has a Reports tab: pick a year, half-year, quarter, month, cycle or custom dates, filter the whole report by accounts, buckets, tags or counterparty, and add the graphs you want as modules, in the order you want them.",
        "A module can compare with the previous period: both side by side, or the difference. Choose whether that's the period right before or the same period last year. While a period is still going, it's compared with as many days of the one before.",
        "For periods of 60 days or more, a module can also be broken down by month or by cycle into small graphs, with parts cut by the period's edges marked as partial.",
        "Start from the built-in Yearly report or Cycle summary, change it, and save it as your own report to open again later.",
      ],
      nb: [
        "Statistikk og rapporter har en ny fane, Rapporter: velg et år, halvår, kvartal, en måned, syklus eller egendefinerte datoer, filtrer hele rapporten på kontoer, bøtter, tagger eller motpart, og legg til grafene du vil ha som moduler, i den rekkefølgen du vil.",
        "En modul kan sammenlignes med forrige periode: begge ved siden av hverandre, eller differansen. Velg om det er perioden rett før eller samme periode i fjor. Mens en periode fortsatt pågår, sammenlignes den med like mange dager av perioden før.",
        "For perioder på 60 dager eller mer kan en modul også deles opp per måned eller per syklus i små grafer, der deler som kuttes av periodens kanter, merkes som delvise.",
        "Start fra den innebygde Årsrapport eller Syklusoppsummering, endre den, og lagre den som din egen rapport for å åpne den igjen senere.",
      ],
      nn: [
        "Statistikk og rapportar har ei ny fane, Rapportar: vel eit år, halvår, kvartal, ein månad, syklus eller eigendefinerte datoar, filtrer heile rapporten på kontoar, bøtter, taggar eller motpart, og legg til grafane du vil ha som modular, i den rekkjefølgja du vil.",
        "Ein modul kan samanliknast med førre periode: begge ved sida av kvarandre, eller differansen. Vel om det er perioden rett før eller same periode i fjor. Medan ein periode framleis går, vert han samanlikna med like mange dagar av perioden før.",
        "For periodar på 60 dagar eller meir kan ein modul også delast opp per månad eller per syklus i små grafar, der delar som vert kutta av kantane til perioden, er merkte som delvise.",
        "Start frå den innebygde Årsrapport eller Syklusoppsummering, endre han, og lagre han som din eigen rapport for å opne han igjen seinare.",
      ],
    },
  },
  {
    version: "v2.08.00",
    date: "2026-11-09",
    title: {
      en: "Export and import your data",
      nb: "Eksporter og importer dataene dine",
      nn: "Eksporter og importer dataa dine",
    },
    changes: {
      en: [
        "Settings → Data export and import: Download my data saves everything you have in the app as one file: accounts, buckets, cycles, transactions, tags, scheduled transactions, your settings and the dashboard. Keep it as a backup, or move to another server.",
        "Import… replaces all your data with such a file, after you've checked what's in it and typed your username. A copy of your current data is downloaded first, so you can go back. A file from another user or server is imported as a copy.",
      ],
      nb: [
        "Innstillinger → Eksport og import av data: Last ned dataene mine lagrer alt du har i appen som én fil: kontoer, bøtter, sykluser, transaksjoner, tagger, planlagte transaksjoner, innstillingene dine og oversikten. Ta vare på den som sikkerhetskopi, eller flytt til en annen server.",
        "Importer … erstatter alle dataene dine med en slik fil, etter at du har sett hva den inneholder og skrevet brukernavnet ditt. En kopi av dataene du har nå, lastes ned først, så du kan gå tilbake. En fil fra en annen bruker eller server importeres som en kopi.",
      ],
      nn: [
        "Innstillingar → Eksport og import av data: Last ned dataa mine lagrar alt du har i appen som éi fil: kontoar, bøtter, syklusar, transaksjonar, taggar, planlagde transaksjonar, innstillingane dine og oversikta. Ta vare på ho som tryggingskopi, eller flytt til ein annan tenar.",
        "Importer … erstattar alle dataa dine med ei slik fil, etter at du har sett kva ho inneheld og skrive brukarnamnet ditt. Ein kopi av dataa du har no, vert lasta ned først, så du kan gå tilbake. Ei fil frå ein annan brukar eller tenar vert importert som ein kopi.",
      ],
    },
  },
  {
    version: "v2.07.00",
    date: "2026-11-09",
    title: {
      en: "Logs for admins",
      nb: "Logger for administratorer",
      nn: "Loggar for administratorar",
    },
    changes: {
      en: [
        "Admin has a new Logs tab: warnings and errors, app events such as startup, cycle starts and scheduled transactions, and admin actions such as users created or passwords reset. Filter by type, period, user or reference, search, and open an entry for its details.",
        "Admins choose how long each kind of entry is kept, with Retention on the Logs tab.",
        "An error now shows a reference you can copy and pass on. For admins, it opens everything logged for that request.",
      ],
      nb: [
        "Administrasjon har en ny fane, Logger: advarsler og feil, hendelser i appen som oppstart, syklusstart og planlagte transaksjoner, og administratorhandlinger som nye brukere eller tilbakestilte passord. Filtrer på type, periode, bruker eller referanse, søk, og åpne en oppføring for detaljer.",
        "Administratorer velger hvor lenge hver type oppføring lagres, med Lagringstid på Logger-fanen.",
        "En feil viser nå en referanse du kan kopiere og gi videre. For administratorer åpner den alt som er logget for den forespørselen.",
      ],
      nn: [
        "Administrasjon har ei ny fane, Loggar: åtvaringar og feil, hendingar i appen som oppstart, syklusstart og planlagde transaksjonar, og administratorhandlingar som nye brukarar eller tilbakestilte passord. Filtrer på type, periode, brukar eller referanse, søk, og opne ei oppføring for detaljar.",
        "Administratorar vel kor lenge kvar type oppføring vert lagra, med Lagringstid på Loggar-fana.",
        "Ein feil viser no ein referanse du kan kopiere og gje vidare. For administratorar opnar han alt som er logga for den førespurnaden.",
      ],
    },
  },
  {
    version: "v2.06.00",
    date: "2026-11-09",
    title: {
      en: "Delete an account's buckets with it",
      nb: "Slett bøttene til en konto sammen med den",
      nn: "Slett bøttene til ein konto saman med han",
    },
    changes: {
      en: [
        "When you delete an account, each of its buckets can now be deleted with it instead of moved to another account, or all of them at once with Delete them all. What's left in a deleted bucket goes back to the account first, so it's part of the money you transfer or adjust.",
        "An account with no other account in its currency can now be deleted too, together with its buckets.",
      ],
      nb: [
        "Når du sletter en konto, kan hver av bøttene nå slettes sammen med den i stedet for å flyttes til en annen konto, eller alle på en gang med Slett alle. Det som er igjen i en slettet bøtte, går først tilbake til kontoen, så det blir med i pengene du overfører eller justerer.",
        "En konto uten noen annen konto i samme valuta kan nå også slettes, sammen med bøttene.",
      ],
      nn: [
        "Når du slettar ein konto, kan kvar av bøttene no slettast saman med han i staden for å flyttast til ein annan konto, eller alle på ein gong med Slett alle. Det som er att i ei sletta bøtte, går først tilbake til kontoen, så det blir med i pengane du overfører eller justerer.",
        "Ein konto utan nokon annan konto i same valuta kan no òg slettast, saman med bøttene.",
      ],
    },
  },
  {
    version: "v2.05.01",
    date: "2026-11-09",
    title: {
      en: "Widgets say when what they showed is gone",
      nb: "Moduler sier fra når det de viste, er borte",
      nn: "Modular seier frå når det dei viste, er borte",
    },
    changes: {
      en: [
        "Account balances and Money in and out set to one account, and Bucket status set to one bucket, now say when that account or bucket has been deleted, with a button to choose another, instead of quietly showing something else.",
      ],
      nb: [
        "Kontosaldoer og Inn og ut satt til én konto, og Bøttestatus satt til én bøtte, sier nå fra når kontoen eller bøtta er slettet, med en knapp for å velge en annen, i stedet for å vise noe annet uten å si fra.",
      ],
      nn: [
        "Kontosaldoar og Inn og ut sette til éin konto, og Bøttestatus sett til éi bøtte, seier no frå når kontoen eller bøtta er sletta, med ein knapp for å velje ein annan, i staden for å vise noko anna utan å seie frå.",
      ],
    },
  },
  {
    version: "v2.05.00",
    date: "2026-11-09",
    title: {
      en: "Delete buckets from Budget setup",
      nb: "Slett bøtter fra Budsjettoppsett",
      nn: "Slett bøtter frå Budsjettoppsett",
    },
    changes: {
      en: [
        "Budget setup can delete buckets: the bin on a bucket marks it Deleted, it stops counting in the budget, and Undo brings it back.",
        "It's deleted when you save, together with your other changes, and what's left in it goes back to the account's unallocated money.",
        "Without a running cycle, a bucket with money left can't be deleted; the button says why.",
      ],
      nb: [
        "Budsjettoppsett kan slette bøtter: søppelbøtta på en bøtte merker den Slettes, den telles ikke lenger i budsjettet, og Angre henter den tilbake.",
        "Den slettes når du lagrer, sammen med de andre endringene, og det som er igjen i den, går tilbake til de ufordelte pengene på kontoen.",
        "Uten en aktiv periode kan ikke en bøtte med penger igjen slettes; knappen sier hvorfor.",
      ],
      nn: [
        "Budsjettoppsett kan slette bøtter: søppelbøtta på ei bøtte merkjer ho Vert sletta, ho vert ikkje lenger talt i budsjettet, og Angre hentar ho tilbake.",
        "Ho vert sletta når du lagrar, saman med dei andre endringane, og det som er att i ho, går tilbake til dei ufordelte pengane på kontoen.",
        "Utan ein aktiv periode kan ikkje ei bøtte med pengar att slettast; knappen seier kvifor.",
      ],
    },
  },
  {
    version: "v2.04.00",
    date: "2026-11-09",
    title: {
      en: "New buckets from Budget setup",
      nb: "Nye bøtter fra Budsjettoppsett",
      nn: "Nye bøtter frå Budsjettoppsett",
    },
    changes: {
      en: [
        "Budget setup can add buckets: New bucket in the header, or at the end of an account's buckets, opens the same form as Bucket setup.",
        "A new bucket counts in the budget at once, shown as New, and is created when you save, together with your other changes. Until then you can change or remove it.",
        "Accounts without buckets now show on Budget setup too, so you can start a budget there.",
      ],
      nb: [
        "Budsjettoppsett kan legge til bøtter: Ny bøtte øverst, eller etter en kontos bøtter, åpner det samme skjemaet som Bøtteoppsett.",
        "En ny bøtte telles med i budsjettet med en gang, merket Ny, og opprettes når du lagrer, sammen med de andre endringene. Til da kan du endre eller fjerne den.",
        "Kontoer uten bøtter vises nå også i Budsjettoppsett, så du kan starte et budsjett der.",
      ],
      nn: [
        "Budsjettoppsett kan leggje til bøtter: Ny bøtte øvst, eller etter bøttene til ein konto, opnar det same skjemaet som Bøtteoppsett.",
        "Ei ny bøtte vert talt med i budsjettet med ein gong, merkt Ny, og vert oppretta når du lagrar, saman med dei andre endringane. Til då kan du endre eller fjerne ho.",
        "Kontoar utan bøtter vert no òg viste i Budsjettoppsett, så du kan starte eit budsjett der.",
      ],
    },
  },
  {
    version: "v2.03.00",
    date: "2026-11-09",
    title: {
      en: "Bucket settings on Bucket setup",
      nb: "Bøtteinnstillinger i Bøtteoppsett",
      nn: "Bøtteinnstillingar i Bøtteoppsett",
    },
    changes: {
      en: [
        "What new buckets start with (the refill mode, and what a Keep funds bucket does when overspent) and the income rules have moved from Settings to Bucket setup, under Bucket settings.",
        "A new bucket's form says which refill mode new buckets start as, and choosing On income without any income rules tells you, with a link to set them up.",
        "The income rules can also be edited from Budget setup.",
      ],
      nb: [
        "Hva nye bøtter starter med (påfyllingsmåten, og hva en bøtte med Behold midler gjør når den er overforbrukt) og inntektsreglene er flyttet fra Innstillinger til Bøtteoppsett, under Bøtteinnstillinger.",
        "Skjemaet for en ny bøtte sier hvilken påfyllingsmåte nye bøtter starter med, og velger du Ved inntekt uten noen inntektsregler, får du beskjed, med en lenke for å sette dem opp.",
        "Inntektsreglene kan også endres fra Budsjettoppsett.",
      ],
      nn: [
        "Kva nye bøtter startar med (påfyllingsmåten, og kva ei bøtte med Behald midlar gjer når ho er overforbrukt) og inntektsreglane er flytte frå Innstillingar til Bøtteoppsett, under Bøtteinnstillingar.",
        "Skjemaet for ei ny bøtte seier kva påfyllingsmåte nye bøtter startar med, og vel du Ved inntekt utan nokon inntektsreglar, får du beskjed, med ei lenkje for å setje dei opp.",
        "Inntektsreglane kan òg endrast frå Budsjettoppsett.",
      ],
    },
  },
  {
    version: "v2.02.00",
    date: "2026-11-09",
    title: {
      en: "Graphs per counterparty",
      nb: "Grafer per motpart",
      nn: "Grafar per motpart",
    },
    changes: {
      en: [
        "Graphs of spending or income can be split per counterparty: who pays you, and where the money goes. Names that differ only in capitals or spaces count as one.",
        "Income or spending without a counterparty has its own series, and with one account chosen, transfers are one Transfers series.",
        "Clicking a counterparty opens exactly its transactions; Transactions shows that filter as a pill you can remove.",
      ],
      nb: [
        "Grafer over utgifter eller inntekter kan deles opp per motpart: hvem som betaler deg, og hvor pengene går. Navn som bare skiller seg i store bokstaver eller mellomrom, telles som ett.",
        "Inntekter eller utgifter uten motpart får sin egen serie, og med én konto valgt blir overføringer én serie, Overføringer.",
        "Klikker du på en motpart, åpnes nøyaktig dens transaksjoner; Transaksjoner viser filteret som en knapp du kan fjerne.",
      ],
      nn: [
        "Grafar over utgifter eller inntekter kan delast opp per motpart: kven som betaler deg, og kvar pengane går. Namn som berre skil seg i store bokstavar eller mellomrom, vert talde som eitt.",
        "Inntekter eller utgifter utan motpart får eigen serie, og med éin konto vald vert overføringar éin serie, Overføringar.",
        "Klikkar du på ein motpart, vert nøyaktig transaksjonane hans opna; Transaksjonar viser filteret som ein knapp du kan fjerne.",
      ],
    },
  },
  {
    version: "v2.01.00",
    date: "2026-11-09",
    title: {
      en: "Banks on accounts",
      nb: "Bank på kontoer",
      nn: "Bank på kontoar",
    },
    changes: {
      en: [
        "An account can have a bank, set in Account setup, which suggests the banks of your other accounts. Accounts and Account setup show it.",
        "Register interest records the interest as an income from the account's bank, or with the counterparty Interest when it has none.",
        "When you set or change an account's bank, you're offered to give its earlier interest the bank's name; each is corrected, so the change stays in its history.",
      ],
      nb: [
        "En konto kan ha en bank, satt i Kontooppsett, som foreslår bankene til de andre kontoene dine. Kontoer og Kontooppsett viser den.",
        "Registrer renter fører rentene som en inntekt fra kontoens bank, eller med motparten Renter når den ikke har noen.",
        "Når du setter eller endrer banken til en konto, får du tilbud om å gi de tidligere rentene bankens navn; hver av dem korrigeres, så endringen blir stående i historikken.",
      ],
      nn: [
        "Ein konto kan ha ein bank, sett i Kontooppsett, som føreslår bankane til dei andre kontoane dine. Kontoar og Kontooppsett viser han.",
        "Registrer renter fører rentene som ei inntekt frå banken til kontoen, eller med motparten Renter når han ikkje har nokon.",
        "Når du set eller endrar banken til ein konto, får du tilbod om å gje dei tidlegare rentene namnet til banken; kvar av dei vert korrigert, så endringa vert ståande i historikken.",
      ],
    },
  },
  {
    version: "v2.00.02",
    date: "2026-11-09",
    title: {
      en: "Pie graphs without stray Total rows",
      nb: "Kakediagrammer uten ekstra Totalt-rader",
      nn: "Kakediagram utan ekstra Totalt-rader",
    },
    changes: {
      en: [
        "A pie per bucket no longer lists stray Total rows after switching Show to Balance, and they no longer stay when switching back.",
        "While a changed graph loads, the previous one stays as it was, dimmed, instead of mixing the new settings with the old numbers.",
      ],
      nb: [
        "Et kakediagram per bøtte viser ikke lenger ekstra Totalt-rader etter at Vis endres til Saldo, og de blir ikke lenger stående når du bytter tilbake.",
        "Mens en endret graf lastes, blir den forrige stående som den var, nedtonet, i stedet for å blande de nye innstillingene med de gamle tallene.",
      ],
      nn: [
        "Eit kakediagram per bøtte viser ikkje lenger ekstra Totalt-rader etter at Vis vert endra til Saldo, og dei vert ikkje lenger ståande når du byter tilbake.",
        "Medan ein endra graf vert lasta, vert den førre ståande som han var, nedtona, i staden for å blande dei nye innstillingane med dei gamle tala.",
      ],
    },
  },
  {
    version: "v2.00.01",
    date: "2026-11-09",
    title: {
      en: "Typing a time on a phone",
      nb: "Skrive inn klokkeslett på mobil",
      nn: "Skrive inn klokkeslett på mobil",
    },
    changes: {
      en: [
        "On a phone, the date and time picker opens as a dialog, so a whole time like 17:00 can be typed in one go instead of one digit at a time.",
      ],
      nb: [
        "På mobil åpnes velgeren for dato og klokkeslett som en dialog, så et helt klokkeslett som 17:00 kan skrives inn i ett strekk i stedet for ett siffer om gangen.",
      ],
      nn: [
        "På mobil vert veljaren for dato og klokkeslett opna som ein dialog, så eit heilt klokkeslett som 17:00 kan skrivast inn i eitt strekk i staden for eitt siffer om gongen.",
      ],
    },
  },
  {
    version: "v2.00.00",
    date: "2026-11-08",
    title: {
      en: "Transaction descriptions",
      nb: "Beskrivelser på transaksjoner",
      nn: "Skildringar på transaksjonar",
    },
    changes: {
      en: [
        "Version 2: the budget model and insight milestone is complete, with refill rules, dashboard widgets, graphs, scheduled transactions and notifications.",
        "A transaction can have a description: a note of what it was, on several lines if you like. Add it when you create or edit one; on a phone, tap Add description.",
        "Transactions shows the first line in the list and all of it in the detail, and the search finds descriptions as well as counterparties.",
        "A schedule's description goes to every transaction it records.",
      ],
      nb: [
        "Versjon 2: milepælen for budsjettmodell og innsikt er fullført, med påfyllingsregler, moduler på oversikten, grafer, planlagte transaksjoner og varsler.",
        "En transaksjon kan ha en beskrivelse: et notat om hva det var, gjerne over flere linjer. Legg den til når du oppretter eller redigerer en; på mobil trykker du Legg til beskrivelse.",
        "Transaksjoner viser første linje i lista og hele beskrivelsen i detaljene, og søket finner beskrivelser i tillegg til motparter.",
        "Beskrivelsen til en planlagt transaksjon følger med hver transaksjon den registrerer.",
      ],
      nn: [
        "Versjon 2: milepælen for budsjettmodell og innsikt er fullført, med påfyllingsreglar, modular på oversikta, grafar, planlagde transaksjonar og varsel.",
        "Ein transaksjon kan ha ei skildring: eit notat om kva det var, gjerne over fleire linjer. Legg ho til når du opprettar eller redigerer ein; på mobil trykkjer du Legg til skildring.",
        "Transaksjonar viser første linja i lista og heile skildringa i detaljane, og søket finn skildringar i tillegg til motpartar.",
        "Skildringa til ein planlagd transaksjon følgjer med kvar transaksjon han registrerer.",
      ],
    },
  },
  {
    version: "v1.16.02",
    date: "2026-11-08",
    title: {
      en: "Balance after each transaction",
      nb: "Saldo etter hver transaksjon",
      nn: "Saldo etter kvar transaksjon",
    },
    changes: {
      en: [
        "Filtered to one account, Transactions shows the account's balance after each transaction, like a bank statement. Other filters don't change it.",
        "A transaction's detail shows each account's balance after it.",
      ],
      nb: [
        "Filtrert på én konto viser Transaksjoner saldoen på kontoen etter hver transaksjon, som på et kontoutskrift. Andre filtre endrer den ikke.",
        "Detaljene til en transaksjon viser saldoen på hver konto etter den.",
      ],
      nn: [
        "Filtrert på éin konto viser Transaksjonar saldoen på kontoen etter kvar transaksjon, som på eit kontoutskrift. Andre filter endrar han ikkje.",
        "Detaljane til ein transaksjon viser saldoen på kvar konto etter han.",
      ],
    },
  },
  {
    version: "v1.16.01",
    date: "2026-11-08",
    title: {
      en: "Hide reversed transactions",
      nb: "Skjul reverserte transaksjoner",
      nn: "Skjul reverserte transaksjonar",
    },
    changes: {
      en: [
        "Transactions no longer lists reversed transactions, or the originals of ones moved to another account. Tick Show reversed & moved to see them; the choice is remembered in this browser.",
        "After Reverse, the transaction leaves the list, but its detail stays open.",
        "The Dashboard's Recent transactions leaves them out too, unless Show reversed & moved is ticked in its settings.",
      ],
      nb: [
        "Transaksjoner viser ikke lenger reverserte transaksjoner, eller originalene til dem som er flyttet til en annen konto. Kryss av for Vis reverserte og flyttede for å se dem. Valget huskes i denne nettleseren.",
        "Etter Reverser forsvinner transaksjonen fra lista, men detaljene blir stående åpne.",
        "Siste transaksjoner på Oversikt utelater dem også, med mindre Vis reverserte og flyttede er krysset av i innstillingene.",
      ],
      nn: [
        "Transaksjonar viser ikkje lenger reverserte transaksjonar, eller originalane til dei som er flytta til ein annan konto. Kryss av for Vis reverserte og flytta for å sjå dei. Valet vert hugsa i denne nettlesaren.",
        "Etter Reverser forsvinn transaksjonen frå lista, men detaljane vert ståande opne.",
        "Siste transaksjonar på Oversikt utelèt dei òg, med mindre Vis reverserte og flytta er kryssa av i innstillingane.",
      ],
    },
  },
  {
    version: "v1.16.00",
    date: "2026-11-08",
    title: {
      en: "Notifications",
      nb: "Varsler",
      nn: "Varsel",
    },
    changes: {
      en: [
        "Notifications remind you of what the app can't do for you: scheduled transactions waiting for approval, bills and transfers coming up in the next few days, investment and fund balances to update when a cycle starts, and priority buckets that aren't covered.",
        "Find them under Notifications above your profile in the side menu, or the bell in the header on mobile. The number on them is how many are open.",
        "Each one opens where it's done, and goes away by itself once it is. Dismiss one (or mark a balance as right) to hide it until it happens again.",
        "Choose which kinds show, and how many days ahead bills do, in Settings.",
      ],
      nb: [
        "Varsler minner deg om det appen ikke kan gjøre for deg: planlagte transaksjoner som venter på godkjenning, regninger og overføringer de neste dagene, investerings- og fondssaldoer å oppdatere når en periode starter, og prioriterte bøtter som ikke er dekket.",
        "Du finner dem under Varsler over profilen din i sidemenyen, eller bjella i toppen på mobil. Tallet på dem er hvor mange som er åpne.",
        "Hvert varsel åpner der det gjøres, og forsvinner av seg selv når det er gjort. Avvis et varsel (eller si at saldoen stemmer) for å skjule det til det skjer igjen.",
        "Velg hvilke typer som vises, og hvor mange dager fram regninger vises, i Innstillinger.",
      ],
      nn: [
        "Varsel minner deg om det appen ikkje kan gjere for deg: planlagde transaksjonar som ventar på godkjenning, rekningar og overføringar dei neste dagane, investerings- og fondssaldoar å oppdatere når ein periode startar, og prioriterte bøtter som ikkje er dekte.",
        "Du finn dei under Varsel over profilen din i sidemenyen, eller bjølla i toppen på mobil. Talet på dei er kor mange som er opne.",
        "Kvart varsel opnar der det blir gjort, og forsvinn av seg sjølv når det er gjort. Avvis eit varsel (eller sei at saldoen stemmer) for å skjule det til det skjer att.",
        "Vel kva typar som blir viste, og kor mange dagar fram rekningar blir viste, i Innstillingar.",
      ],
    },
  },
  {
    version: "v1.15.01",
    date: "2026-11-08",
    title: {
      en: "Extending over a planned cycle",
      nb: "Forlenge over en planlagt periode",
      nn: "Forlengje over ein planlagd periode",
    },
    changes: {
      en: [
        "Extending the active cycle past the end of a planned cycle no longer fails. The planned cycles it covers are removed, the dialog says which first, and the next one starts when the extended cycle ends. With a cycle rule, new ones are planned to keep enough ahead.",
      ],
      nb: [
        "Å forlenge den aktive perioden forbi slutten av en planlagt periode feiler ikke lenger. De planlagte periodene den dekker, fjernes, og dialogen sier hvilke først. Den neste starter når den forlengede perioden slutter. Med en perioderegel planlegges nye, så det er nok planlagt fremover.",
      ],
      nn: [
        "Å forlengje den aktive perioden forbi slutten av ein planlagd periode feilar ikkje lenger. Dei planlagde periodane han dekkjer, vert fjerna, og dialogen seier kva for nokre først. Den neste startar når den forlengde perioden sluttar. Med ein perioderegel vert nye planlagde, så det er nok planlagt framover.",
      ],
    },
  },
  {
    version: "v1.15.00",
    date: "2026-11-08",
    title: {
      en: "Approve scheduled transactions",
      nb: "Godkjenn planlagte transaksjoner",
      nn: "Godkjenn planlagde transaksjonar",
    },
    changes: {
      en: [
        "Scheduled transactions that ask first, or that couldn't be recorded on time, now wait for you at the top of the Scheduled tab, with why and when they're due. Overdue ones are marked in red and come first.",
        "Approve one as it is, open Edit and approve to change its amount, bucket lines, account or date first, or skip it. Select several to approve or skip them at once. An approved one is dated at its scheduled time when that has passed and is in the active cycle, otherwise now.",
        "Transactions in the menu, and the Scheduled tab, show how many are waiting, in red when one is overdue.",
        "The Dashboard has a new Scheduled widget with what's waiting for approval and what's coming up, or just one of them.",
        "Ask days before sets how early a schedule that asks first shows up in the queue, for example 14 days before rent is due on the 1st, so you can approve it early. It's overdue once its time has passed. New schedule now records a first time that's now or past straight away, as New transaction does, and a schedule set to start this minute no longer skips its first time.",
      ],
      nb: [
        "Planlagte transaksjoner som spør først, eller som ikke kunne føres i tide, venter nå på deg øverst på fanen Planlagte, med hvorfor og når de forfaller. De som har forfalt, er merket med rødt og kommer først.",
        "Godkjenn en som den er, åpne Rediger og godkjenn for å endre beløpet, bøttelinjene, kontoen eller datoen først, eller hopp over den. Velg flere for å godkjenne eller hoppe over dem på en gang. En godkjent transaksjon dateres til det planlagte tidspunktet når det er passert og i den aktive syklusen, ellers nå.",
        "Transaksjoner i menyen og fanen Planlagte viser hvor mange som venter, med rødt når en har forfalt.",
        "Oversikten har en ny modul, Planlagte, med det som venter på godkjenning og det som kommer, eller bare ett av dem.",
        "Spør dager før bestemmer hvor tidlig en planlagt transaksjon som spør først, dukker opp i køen, for eksempel 14 dager før husleien forfaller den 1., så du kan godkjenne den tidlig. Den har forfalt når tidspunktet er passert. Ny planlagt fører nå et første tidspunkt som er nå eller passert, med en gang, slik Ny transaksjon gjør, og en planlagt transaksjon som skal starte dette minuttet, hopper ikke lenger over første gang.",
      ],
      nn: [
        "Planlagde transaksjonar som spør først, eller som ikkje kunne førast i tide, ventar no på deg øvst på fana Planlagde, med kvifor og når dei forfell. Dei som har forfalle, er merkte med raudt og kjem først.",
        "Godkjenn ein som han er, opne Rediger og godkjenn for å endre beløpet, bøttelinjene, kontoen eller datoen først, eller hopp over han. Vel fleire for å godkjenne eller hoppe over dei på ein gong. Ein godkjend transaksjon vert datert til det planlagde tidspunktet når det er passert og i den aktive syklusen, elles no.",
        "Transaksjonar i menyen og fana Planlagde viser kor mange som ventar, med raudt når ein har forfalle.",
        "Oversikta har ein ny modul, Planlagde, med det som ventar på godkjenning og det som kjem, eller berre eitt av dei.",
        "Spør dagar før bestemmer kor tidleg ein planlagd transaksjon som spør først, dukkar opp i køen, til dømes 14 dagar før husleiga forfell den 1., så du kan godkjenne han tidleg. Han har forfalle når tidspunktet er passert. Ny planlagd fører no eit første tidspunkt som er no eller passert, med ein gong, slik Ny transaksjon gjer, og ein planlagd transaksjon som skal starte dette minuttet, hoppar ikkje lenger over første gong.",
      ],
    },
  },
  {
    version: "v1.14.00",
    date: "2026-11-08",
    title: {
      en: "Scheduled and recurring transactions",
      nb: "Planlagte og gjentakende transaksjoner",
      nn: "Planlagde og gjentakande transaksjonar",
    },
    changes: {
      en: [
        "Schedule a transaction for later, or make it repeat every so many days, weeks, months or years, such as the rent on the 25th. Turn on Repeat or schedule in New transaction: a transaction dated now or earlier is saved at once and repeats from the next time.",
        'Transactions has a new Scheduled tab with your schedules in words, such as "Every month on the 25th at 08:00", and their next time. Create one with New schedule, edit it, pause it or delete it there, and choose whether paused and ended ones show. The form shows the next times as you change it.',
        "A transaction dated in the future is saved as a scheduled one, recorded once at that time, or set to ask you first.",
        "Make recurring on a transaction starts a schedule like it. Transactions recorded by a schedule are marked in the list, and their detail links to the schedule.",
        "A schedule can record its transactions by itself, or ask you first. Approving them comes in the next update.",
      ],
      nb: [
        "Planlegg en transaksjon til senere, eller la den gjentas med noen dagers, ukers, måneders eller års mellomrom, for eksempel husleien den 25. Slå på Gjenta eller planlegg i Ny transaksjon: en transaksjon datert nå eller tidligere lagres med en gang og gjentas fra neste gang.",
        "Transaksjoner har en ny fane, Planlagte, med de planlagte transaksjonene dine i ord, for eksempel «Hver måned den 25. kl. 08:00», og neste gang. Lag en med Ny planlagt, og rediger, sett på pause eller slett den der, og velg om de som er på pause eller ferdige, skal vises. Skjemaet viser de neste gangene mens du endrer det.",
        "En transaksjon datert frem i tid lagres som planlagt og føres én gang på det tidspunktet, eller spør deg først om du vil.",
        "Gjør gjentakende på en transaksjon lager en planlagt transaksjon lik den. Transaksjoner som er ført av en planlagt transaksjon, er merket i listen, og detaljene lenker til den.",
        "En planlagt transaksjon kan føre transaksjonene selv, eller spørre deg først. Godkjenning kommer i neste oppdatering.",
      ],
      nn: [
        "Planlegg ein transaksjon til seinare, eller la han verte gjenteken med nokre dagars, vekers, månaders eller års mellomrom, til dømes husleiga den 25. Slå på Gjenta eller planlegg i Ny transaksjon: ein transaksjon datert no eller tidlegare vert lagra med ein gong og gjenteken frå neste gong.",
        "Transaksjonar har ei ny fane, Planlagde, med dei planlagde transaksjonane dine i ord, til dømes «Kvar månad den 25. kl. 08:00», og neste gong. Lag ein med Ny planlagd, og rediger, set på pause eller slett han der, og vel om dei som er på pause eller ferdige, skal visast. Skjemaet viser dei neste gongene medan du endrar det.",
        "Ein transaksjon datert fram i tid vert lagra som planlagd og ført éin gong på det tidspunktet, eller spør deg først om du vil.",
        "Gjer gjentakande på ein transaksjon lagar ein planlagd transaksjon lik han. Transaksjonar som er førte av ein planlagd transaksjon, er merkte i lista, og detaljane lenkjer til han.",
        "Ein planlagd transaksjon kan føre transaksjonane sjølv, eller spørje deg først. Godkjenning kjem i neste oppdatering.",
      ],
    },
  },
  {
    version: "v1.13.01",
    date: "2026-11-08",
    title: {
      en: "Groundwork for scheduled transactions",
      nb: "Grunnlag for planlagte transaksjoner",
      nn: "Grunnlag for planlagde transaksjonar",
    },
    changes: {
      en: [
        "The server can now hold scheduled and recurring transactions, such as the rent every month, and record them on time or queue them for you to approve. The screens to set them up come next. Nothing changes in the app yet.",
      ],
      nb: [
        "Serveren kan nå ta vare på planlagte og gjentakende transaksjoner, for eksempel husleien hver måned, og føre dem i tide eller legge dem i kø så du kan godkjenne dem. Skjermene for å sette dem opp kommer snart. Ingenting endres i appen ennå.",
      ],
      nn: [
        "Tenaren kan no ta vare på planlagde og gjentakande transaksjonar, til dømes husleiga kvar månad, og føre dei i tide eller leggje dei i kø så du kan godkjenne dei. Skjermane for å setje dei opp kjem snart. Ingenting vert endra i appen enno.",
      ],
    },
  },
  {
    version: "v1.13.00",
    date: "2026-11-08",
    title: {
      en: "Graphs on the Dashboard",
      nb: "Grafer på oversikten",
      nn: "Grafar på oversikta",
    },
    changes: {
      en: [
        "The Dashboard has a new Graph widget that shows one of your saved graphs. Add it with Add widget, or from Stats & reports: open a saved graph's menu and choose Add to dashboard, for the desktop layout, the mobile one or both.",
        "The widget follows the saved graph, so changing the graph on Stats & reports changes the widget too. Click the graph to open it there.",
        "Deleting a saved graph that's on the Dashboard warns you first, and its widgets then let you pick another one.",
      ],
      nb: [
        "Oversikten har en ny Graf-modul som viser en av de lagrede grafene dine. Legg den til med Legg til modul, eller fra Statistikk og rapporter: åpne menyen til en lagret graf og velg Legg til på oversikten, for skrivebordsvisningen, mobilvisningen eller begge.",
        "Modulen følger den lagrede grafen, så endrer du grafen under Statistikk og rapporter, endres modulen også. Klikk på grafen for å åpne den der.",
        "Sletter du en lagret graf som er på oversikten, får du en advarsel først, og modulene lar deg så velge en annen.",
      ],
      nn: [
        "Oversikta har ein ny Graf-modul som viser ein av dei lagra grafane dine. Legg han til med Legg til modul, eller frå Statistikk og rapportar: opne menyen til ein lagra graf og vel Legg til på oversikta, for skrivebordsvisinga, mobilvisinga eller begge.",
        "Modulen følgjer den lagra grafen, så endrar du grafen under Statistikk og rapportar, vert modulen òg endra. Klikk på grafen for å opne han der.",
        "Slettar du ein lagra graf som er på oversikta, får du ei åtvaring først, og modulane let deg så velje ein annan.",
      ],
    },
  },
  {
    version: "v1.12.00",
    date: "2026-11-08",
    title: {
      en: "Pie charts",
      nb: "Kakediagrammer",
      nn: "Kakediagram",
    },
    changes: {
      en: [
        "Graphs can now be pies: your spending, income or balances split per bucket or per account, or spread over time, such as one slice per month of the year (up to 12 slices).",
        "The total is in the middle. Next to the pie, a list shows each slice's amount and share. Or put the names and shares on the slices, or show both.",
        "The largest get their own slice and the rest add up to Other. Click a slice or a row in the list to open its transactions. Pies are saved like any other graph.",
        "Graphs have four new colours for this, and Other is a quieter grey that's easier to tell apart from them.",
      ],
      nb: [
        "Grafer kan nå være kakediagrammer: utgiftene, inntektene eller saldoene dine fordelt per bøtte eller per konto, eller over tid, for eksempel én sektor per måned i året (opptil 12 sektorer).",
        "Totalen står i midten. Ved siden av kaka viser en liste beløpet og andelen for hver sektor. Du kan også sette navn og andel på sektorene, eller vise begge.",
        "De største får egen sektor, og resten legges sammen som Annet. Klikk på en sektor eller en rad i listen for å åpne transaksjonene. Kakediagrammer lagres som andre grafer.",
        "Grafene har fått fire nye farger til dette, og Annet er en dempet grå som er lettere å skille fra dem.",
      ],
      nn: [
        "Grafar kan no vere kakediagram: utgiftene, inntektene eller saldoane dine fordelte per bøtte eller per konto, eller over tid, til dømes éin sektor per månad i året (opptil 12 sektorar).",
        "Totalen står i midten. Ved sida av kaka viser ei liste beløpet og delen for kvar sektor. Du kan òg setje namn og del på sektorane, eller vise begge.",
        "Dei største får eigen sektor, og resten vert lagt saman som Anna. Klikk på ein sektor eller ei rad i lista for å opne transaksjonane. Kakediagram vert lagra som andre grafar.",
        "Grafane har fått fire nye fargar til dette, og Anna er ein dempa grå som er lettare å skilje frå dei.",
      ],
    },
  },
  {
    version: "v1.11.00",
    date: "2026-11-08",
    title: {
      en: "Graphs",
      nb: "Grafer",
      nn: "Grafar",
    },
    changes: {
      en: [
        "Stats & reports shows your spending, income or balances over time, as bars or a line. Pick the period (such as the last 30 days, the last 3 cycles, this cycle, the previous year, one specific month or quarter, or your own dates) and whether to show it per day, week, month, cycle and so on.",
        "Show everything at once, or split it per account or per bucket. The largest get their own colour and the rest add up to Other. Filter on accounts, buckets, tags or counterparty, and show a line as a running total. Lines can be straight or stepped, and the Y axis starts at 0 or fits the values.",
        "Hover over a bar or point to see the exact amount, and click it to open those transactions. If there's more detail than the graph can draw (such as a year per hour) or than fits the screen, it shows it coarser and says so.",
        "Save a graph by name to come back to it, or bookmark the page: the settings are in its address.",
      ],
      nb: [
        "Statistikk og rapporter viser utgiftene, inntektene eller saldoene dine over tid, som søyler eller en linje. Velg tidsrommet (for eksempel de siste 30 dagene, de siste 3 periodene, denne perioden, i fjor, en bestemt måned eller et bestemt kvartal, eller egne datoer) og om det skal vises per dag, uke, måned, periode og så videre.",
        "Vis alt samlet, eller del det opp per konto eller per bøtte. De største får egen farge, og resten legges sammen som Annet. Filtrer på kontoer, bøtter, tagger eller motpart, og vis en linje som løpende sum. Linjer kan være rette eller trinnvise, og Y-aksen starter på 0 eller tilpasses dataene.",
        "Hold over en søyle eller et punkt for å se det nøyaktige beløpet, og klikk for å åpne transaksjonene. Er det flere detaljer enn grafen kan tegne (for eksempel et år per time) eller enn det er plass til på skjermen, viser den det grovere og sier fra.",
        "Lagre en graf med et navn for å komme tilbake til den, eller lag et bokmerke: innstillingene ligger i adressen.",
      ],
      nn: [
        "Statistikk og rapportar viser utgiftene, inntektene eller saldoane dine over tid, som søyler eller ei linje. Vel tidsrommet (til dømes dei siste 30 dagane, dei siste 3 periodane, denne perioden, i fjor, ein bestemt månad eller eit bestemt kvartal, eller eigne datoar) og om det skal visast per dag, veke, månad, periode og så vidare.",
        "Vis alt samla, eller del det opp per konto eller per bøtte. Dei største får eigen farge, og resten vert lagt saman som Anna. Filtrer på kontoar, bøtter, taggar eller motpart, og vis ei linje som løpande sum. Linjer kan vere rette eller trinnvise, og Y-aksen startar på 0 eller vert tilpassa dataa.",
        "Hald over ei søyle eller eit punkt for å sjå det nøyaktige beløpet, og klikk for å opne transaksjonane. Er det fleire detaljar enn grafen kan teikne (til dømes eit år per time) eller enn det er plass til på skjermen, viser han det grovare og seier frå.",
        "Lagre ein graf med eit namn for å kome tilbake til han, eller lag eit bokmerke: innstillingane ligg i adressa.",
      ],
    },
  },
  {
    version: "v1.10.01",
    date: "2026-11-08",
    title: {
      en: "Groundwork for graphs",
      nb: "Grunnlag for grafer",
      nn: "Grunnlag for grafar",
    },
    changes: {
      en: [
        "The server can now sum spending, income and balances over time, and the app has a shared picker for the time span and how finely to split it. They're for the Stats screen's graphs, which come next. Nothing changes in the app yet.",
      ],
      nb: [
        "Serveren kan nå summere utgifter, inntekter og saldoer over tid, og appen har en felles velger for tidsrommet og hvor fint det skal deles opp. De er til grafene på Statistikk-skjermen, som kommer snart. Ingenting endres i appen ennå.",
      ],
      nn: [
        "Tenaren kan no summere utgifter, inntekter og saldoar over tid, og appen har ein felles veljar for tidsrommet og kor fint det skal delast opp. Dei er til grafane på Statistikk-skjermen, som kjem snart. Ingenting vert endra i appen enno.",
      ],
    },
  },
  {
    version: "v1.10.00",
    date: "2026-11-07",
    title: {
      en: "Separate dashboards for phone and desktop",
      nb: "Egne oversikter for mobil og skrivebord",
      nn: "Eigne oversikter for mobil og skrivebord",
    },
    changes: {
      en: [
        "The dashboard has one layout for phones and one for wider screens, each with its own widgets, order and settings. Your current layout is now both, until you change one of them.",
        "Edit dashboard has a Desktop | Mobile switch, so you can arrange either layout from any screen, and Done saves both.",
        "Copy from desktop or Copy from mobile starts a layout from the other one, and Reset to default resets only the layout you're editing. The mobile default is Bucket status, Cycle and Recent transactions.",
      ],
      nb: [
        "Oversikten har én visning for telefoner og én for bredere skjermer, hver med egne moduler, rekkefølge og innstillinger. Den nåværende visningen din brukes nå til begge, til du endrer en av dem.",
        "Rediger oversikten har en Skrivebord | Mobil-bryter, så du kan ordne begge visningene fra hvilken som helst skjerm, og Ferdig lagrer begge.",
        "Kopier fra skrivebord eller Kopier fra mobil starter en visning fra den andre, og Tilbakestill tilbakestiller bare visningen du redigerer. Standard på mobil er Bøttestatus, Periode og Siste transaksjoner.",
      ],
      nn: [
        "Oversikta har éi vising for telefonar og éi for breiare skjermar, kvar med eigne modular, rekkjefølgje og innstillingar. Den noverande visinga di vert no brukt til begge, til du endrar ei av dei.",
        "Rediger oversikta har ein Skrivebord | Mobil-brytar, så du kan ordne begge visingane frå kva skjerm som helst, og Ferdig lagrar begge.",
        "Kopier frå skrivebord eller Kopier frå mobil startar ei vising frå den andre, og Tilbakestill tilbakestiller berre visinga du redigerer. Standard på mobil er Bøttestatus, Periode og Siste transaksjonar.",
      ],
    },
  },
  {
    version: "v1.09.00",
    date: "2026-11-07",
    title: {
      en: "Bucket status for one account",
      nb: "Bøttestatus for én konto",
      nn: "Bøttestatus for éin konto",
    },
    changes: {
      en: [
        "The Bucket status widget can show the buckets of one account: what they have left, whether the account is short or has money unallocated, and each bucket with its usage bar.",
        "Add one widget per account if you like. Each is titled with its account's name, and if that account is deleted, the widget offers to choose another.",
      ],
      nb: [
        "Bøttestatus-modulen kan vise bøttene til én konto: hva de har igjen, om kontoen mangler penger eller har ufordelte penger, og hver bøtte med forbruket sitt.",
        "Legg gjerne til én modul per konto. Hver får kontoens navn som tittel, og blir kontoen slettet, tilbyr modulen å velge en annen.",
      ],
      nn: [
        "Bøttestatus-modulen kan vise bøttene til éin konto: kva dei har att, om kontoen manglar pengar eller har ufordelte pengar, og kvar bøtte med forbruket sitt.",
        "Legg gjerne til éin modul per konto. Kvar får namnet til kontoen som tittel, og vert kontoen sletta, tilbyr modulen å velje ein annan.",
      ],
    },
  },
  {
    version: "v1.08.00",
    date: "2026-11-07",
    title: {
      en: "Money in and out on the dashboard",
      nb: "Inn og ut på oversikten",
      nn: "Inn og ut på oversikta",
    },
    changes: {
      en: [
        "A new dashboard widget, Money in and out, shows your income, expenses and their balance for the last few days, today, this week, this cycle, this month or this year.",
        "Show all accounts, or one account, where transfers in and out count as income and expenses too. With all accounts, only accounts in NOK are summed for now.",
        "Each figure opens its transactions on the Transactions screen.",
      ],
      nb: [
        "En ny modul på oversikten, Inn og ut, viser inntekter, utgifter og netto for de siste dagene, i dag, denne uken, denne perioden, denne måneden eller i år.",
        "Vis alle kontoer, eller én konto, der også overføringer inn og ut teller som inntekter og utgifter. Med alle kontoer summeres foreløpig bare kontoer i NOK.",
        "Hvert tall åpner transaksjonene sine under Transaksjoner.",
      ],
      nn: [
        "Ein ny modul på oversikta, Inn og ut, viser inntekter, utgifter og netto for dei siste dagane, i dag, denne veka, denne perioden, denne månaden eller i år.",
        "Vis alle kontoar, eller éin konto, der òg overføringar inn og ut tel som inntekter og utgifter. Med alle kontoar vert førebels berre kontoar i NOK summerte.",
        "Kvart tal opnar transaksjonane sine under Transaksjonar.",
      ],
    },
  },
  {
    version: "v1.07.01",
    date: "2026-11-07",
    title: {
      en: "Library update",
      nb: "Oppdatert bibliotek",
      nn: "Oppdatert bibliotek",
    },
    changes: {
      en: ["The library the server uses to check requests is updated. Nothing changes in the app."],
      nb: [
        "Biblioteket serveren bruker til å kontrollere forespørsler, er oppdatert. Ingenting endres i appen.",
      ],
      nn: [
        "Biblioteket tenaren brukar til å kontrollere førespurnader, er oppdatert. Ingenting vert endra i appen.",
      ],
    },
  },
  {
    version: "v1.07.00",
    date: "2026-11-07",
    title: {
      en: "Customisable dashboard",
      nb: "Tilpassbar oversikt",
      nn: "Tilpassbar oversikt",
    },
    changes: {
      en: [
        "Choose Edit dashboard to add, remove and rearrange widgets: drag them by their handle, or use the arrows. Done saves the layout, and Cancel throws the changes away.",
        "Add a widget as many times as you like, each with its own settings, such as two Bucket status widgets in different modes.",
        "Give a widget its own title, or let One bucket and One account be named after their bucket or account. Bucket status can hide its mode line, such as Needs attention.",
        "On wide screens, each widget can be half or full width. Reset to default puts back the five widgets you started with.",
      ],
      nb: [
        "Velg Rediger oversikten for å legge til, fjerne og flytte moduler: dra dem etter håndtaket, eller bruk pilene. Ferdig lagrer oppsettet, og Avbryt forkaster endringene.",
        "Legg til en modul så mange ganger du vil, hver med egne innstillinger, for eksempel to Bøttestatus-moduler som viser ulike ting.",
        "Gi en modul sin egen tittel, eller la Én bøtte og Én konto hete det samme som bøtta eller kontoen. Bøttestatus kan skjule linjen som viser modusen, for eksempel Trenger oppmerksomhet.",
        "På brede skjermer kan hver modul ha halv eller full bredde. Tilbakestill setter tilbake de fem modulene du startet med.",
      ],
      nn: [
        "Vel Rediger oversikta for å leggje til, fjerne og flytte modular: dra dei etter handtaket, eller bruk pilene. Ferdig lagrar oppsettet, og Avbryt forkastar endringane.",
        "Legg til ein modul så mange gonger du vil, kvar med eigne innstillingar, til dømes to Bøttestatus-modular som viser ulike ting.",
        "Gi ein modul sin eigen tittel, eller la Éi bøtte og Éin konto heite det same som bøtta eller kontoen. Bøttestatus kan skjule linja som viser modusen, til dømes Treng merksemd.",
        "På breie skjermar kan kvar modul ha halv eller full breidd. Tilbakestill set tilbake dei fem modulane du starta med.",
      ],
    },
  },
  {
    version: "v1.06.00",
    date: "2026-10-29",
    title: {
      en: "Fully manual buckets",
      nb: "Helt manuelle bøtter",
      nn: "Heilt manuelle bøtter",
    },
    changes: {
      en: [
        "A new refill mode, Fully manual, for buckets you fill by hand: they're never refilled and keep their funds from cycle to cycle.",
        "On Buckets, they have Add funds and Remove funds instead of Refill. Added money comes from the account's unallocated money, and removed money goes back to it.",
        "Their capacity is a fixed amount, or no cap at all. Budget setup leaves them out, since they have no refill amount.",
      ],
      nb: [
        "En ny påfyllingsmåte, Helt manuelt, for bøtter du fyller for hånd: de fylles aldri på og beholder midlene fra periode til periode.",
        "Under Bøtter har de Legg til midler og Fjern midler i stedet for Påfyll. Det du legger til, tas fra de ufordelte pengene på kontoen, og det du fjerner, går tilbake dit.",
        "Kapasiteten er et fast beløp eller ingen grense. Budsjettoppsett tar dem ikke med, siden de ikke har noe påfyllingsbeløp.",
      ],
      nn: [
        "Ein ny påfyllingsmåte, Heilt manuelt, for bøtter du fyller for hand: dei vert aldri fylte på og beheld midlane frå periode til periode.",
        "Under Bøtter har dei Legg til midlar og Fjern midlar i staden for Påfyll. Det du legg til, vert teke frå dei ufordelte pengane på kontoen, og det du fjernar, går tilbake dit.",
        "Kapasiteten er eit fast beløp eller inga grense. Budsjettoppsett tek dei ikkje med, sidan dei ikkje har noko påfyllingsbeløp.",
      ],
    },
  },
  {
    version: "v1.05.00",
    date: "2026-10-29",
    title: {
      en: "Budget setup can change this cycle too",
      nb: "Budsjettoppsett kan endre denne perioden også",
      nn: "Budsjettoppsett kan endre denne perioden òg",
    },
    changes: {
      en: [
        "Turn on Also change this cycle when saving Budget setup, and each bucket already refilled this cycle gets the same change in what's left as in its refill amount.",
        "Buckets still waiting for their refill get the new amount when they're refilled.",
        "Before saving, a summary shows each bucket's change and whether the account still covers its buckets.",
      ],
      nb: [
        "Slå på Endre også denne perioden når du lagrer Budsjettoppsett, så får hver bøtte som alt er fylt på denne perioden, samme endring i det som er igjen som i påfyllingsbeløpet.",
        "Bøtter som venter på påfyll, får det nye beløpet når de fylles på.",
        "Før du lagrer, viser en oversikt endringen for hver bøtte og om kontoen fortsatt dekker bøttene sine.",
      ],
      nn: [
        "Slå på Endre òg denne perioden når du lagrar Budsjettoppsett, så får kvar bøtte som alt er fylt på denne perioden, same endring i det som er att som i påfyllingsbeløpet.",
        "Bøtter som ventar på påfyll, får det nye beløpet når dei vert fylte på.",
        "Før du lagrar, viser ei oversikt endringa for kvar bøtte og om kontoen framleis dekkjer bøttene sine.",
      ],
    },
  },
  {
    version: "v1.04.00",
    date: "2026-10-29",
    title: {
      en: "Version numbers and What's New",
      nb: "Versjonsnumre og Nytt i appen",
      nn: "Versjonsnummer og Nytt i appen",
    },
    changes: {
      en: [
        "The app has a version number, shown on the login page and in the profile menu.",
        "About shows the version, the commit it was built from, and whether it's development or production.",
        "What's New lists the changes in each version. It opens after an update with new features; you can turn that off.",
      ],
      nb: [
        "Appen har et versjonsnummer, som vises på innloggingssiden og i profilmenyen.",
        "Om appen viser versjonen, hvilken commit den er bygget fra, og om det er utvikling eller produksjon.",
        "Nytt i appen viser endringene i hver versjon. Den åpnes etter en oppdatering med nye funksjoner; det kan du slå av.",
      ],
      nn: [
        "Appen har eit versjonsnummer, som vert vist på innloggingssida og i profilmenyen.",
        "Om appen viser versjonen, kva commit han er bygd frå, og om det er utvikling eller produksjon.",
        "Nytt i appen viser endringane i kvar versjon. Han vert opna etter ei oppdatering med nye funksjonar; det kan du slå av.",
      ],
    },
  },
  {
    version: "v1.03.00",
    date: "2026-10-29",
    title: {
      en: "Overspent buckets: carry as debt or clear",
      nb: "Overforbrukte bøtter: gjeld eller nullstilling",
      nn: "Overforbrukte bøtter: gjeld eller nullstilling",
    },
    changes: {
      en: [
        "A bucket with Keep funds can now clear an overspend at the next refill, instead of carrying it as debt.",
        "Choose it per bucket in Bucket setup; new buckets get the default from Settings.",
        "Buckets says what happens to an overspent bucket: paid back or cleared at the next refill.",
      ],
      nb: [
        "En bøtte med Behold midler kan nå nullstille et overforbruk ved neste påfylling, i stedet for å føre det som gjeld.",
        "Velg det for hver bøtte i Bøtteoppsett; nye bøtter får standardvalget fra Innstillinger.",
        "Bøtter viser hva som skjer med en overforbrukt bøtte: betales tilbake eller nullstilles ved neste påfylling.",
      ],
      nn: [
        "Ei bøtte med Behald midlar kan no nullstille eit overforbruk ved neste påfylling, i staden for å føre det som gjeld.",
        "Vel det for kvar bøtte i Bøtteoppsett; nye bøtter får standardvalet frå Innstillingar.",
        "Bøtter viser kva som skjer med ei overforbrukt bøtte: vert betalt tilbake eller nullstilt ved neste påfylling.",
      ],
    },
  },
  {
    version: "v1.02.00",
    date: "2026-10-28",
    title: {
      en: "A bucket's transactions",
      nb: "Transaksjonene til en bøtte",
      nn: "Transaksjonane til ei bøtte",
    },
    changes: {
      en: [
        "Open a bucket's transactions from Buckets: every refill, income, expense, adjustment and transfer in a cycle, with what was left after each.",
        "Show one type, or an earlier cycle; each line opens its transaction.",
      ],
      nb: [
        "Åpne transaksjonene til en bøtte fra Bøtter: hvert påfyll, hver inntekt, utgift, justering og overføring i en periode, med hva som var igjen etter hver.",
        "Vis én type eller en tidligere periode; hver linje åpner transaksjonen sin.",
      ],
      nn: [
        "Opne transaksjonane til ei bøtte frå Bøtter: kvart påfyll, kvar inntekt, utgift, justering og overføring i ein periode, med kva som var att etter kvar.",
        "Vis éin type eller ein tidlegare periode; kvar linje opnar transaksjonen sin.",
      ],
    },
  },
  {
    version: "v1.01.00",
    date: "2026-10-28",
    title: {
      en: "Cycles planned from a rule",
      nb: "Perioder planlagt etter en regel",
      nn: "Periodar planlagde etter ein regel",
    },
    changes: {
      en: [
        "Set a cycle rule in Settings, e.g. the 25th of each month, and the app keeps the next cycles planned.",
        "A date on a weekend or a Norwegian bank holiday moves to the working day before or after, as you choose.",
        "Your time zone is saved, so cycles start at midnight where you are.",
      ],
      nb: [
        "Sett en perioderegel i Innstillinger, f.eks. den 25. hver måned, så holder appen de neste periodene planlagt.",
        "En dato i en helg eller på en norsk helligdag flyttes til virkedagen før eller etter, som du velger.",
        "Tidssonen din lagres, så periodene starter ved midnatt der du er.",
      ],
      nn: [
        "Set ein perioderegel i Innstillingar, t.d. den 25. kvar månad, så held appen dei neste periodane planlagde.",
        "Ein dato i ei helg eller på ein norsk heilagdag vert flytt til yrkedagen før eller etter, som du vel.",
        "Tidssona di vert lagra, så periodane startar ved midnatt der du er.",
      ],
    },
  },
  {
    version: "v1.00.02",
    date: "2026-10-28",
    title: {
      en: "Fixes for iPhone",
      nb: "Rettelser for iPhone",
      nn: "Rettingar for iPhone",
    },
    changes: {
      en: [
        "Dialogs and form fields no longer zoom in on iPhone, and the page no longer stays zoomed.",
        "On mobile, the save bar no longer covers a transaction's buckets and tags.",
      ],
      nb: [
        "Dialoger og skjemafelt zoomer ikke lenger inn på iPhone, og siden blir ikke lenger værende innzoomet.",
        "På mobil dekker ikke lagrelinjen lenger bøttene og taggene til en transaksjon.",
      ],
      nn: [
        "Dialogar og skjemafelt zoomar ikkje lenger inn på iPhone, og sida vert ikkje lenger verande innzooma.",
        "På mobil dekkjer ikkje lagrelinja lenger bøttene og taggane til ein transaksjon.",
      ],
    },
  },
  {
    version: "v1.00.01",
    date: "2026-10-27",
    title: {
      en: "Debug settings for development",
      nb: "Feilsøkingsinnstillinger for utvikling",
      nn: "Feilsøkingsinnstillingar for utvikling",
    },
    changes: {
      en: [
        "In development only: set a simulated time, and save and restore snapshots of a user to try out scenarios. Production builds don't have them.",
      ],
      nb: [
        "Bare i utvikling: sett en simulert tid, og lagre og gjenopprett øyeblikksbilder av en bruker for å prøve ut scenarioer. Produksjonsbygg har dem ikke.",
      ],
      nn: [
        "Berre i utvikling: set ei simulert tid, og lagre og gjenopprett augneblinksbilete av ein brukar for å prøve ut scenario. Produksjonsbygg har dei ikkje.",
      ],
    },
  },
  {
    version: "v1.00.00",
    date: "2026-10-27",
    title: {
      en: "Bucky BudgetR 1.0",
      nb: "Bucky BudgetR 1.0",
      nn: "Bucky BudgetR 1.0",
    },
    changes: {
      en: [
        "Envelope budgeting with buckets: each gets a refill every cycle, and with Keep funds it saves up across cycles.",
        "Cycles: plan, start, extend and end them; buckets are refilled when a cycle starts or when your income arrives.",
        "Bank accounts and transactions: income, expenses and transfers split across buckets, with edit and reverse.",
        "An account's money is shared across its buckets automatically, and Reallocate does it by hand.",
        "Budget setup, bucket adjustments and moving funds between buckets.",
        "A dashboard, English and Norwegian (bokmål and nynorsk), and an Admin screen for users.",
        "Runs on your own server with Docker, over HTTPS on Tailscale or the LAN, with backups.",
      ],
      nb: [
        "Konvoluttbudsjett med bøtter: hver bøtte fylles på hver periode, og med Behold midler sparer den opp over flere perioder.",
        "Perioder: planlegg, start, forleng og avslutt dem; bøttene fylles på når en periode starter eller når inntekten kommer.",
        "Bankkontoer og transaksjoner: inntekter, utgifter og overføringer fordelt på bøtter, med redigering og reversering.",
        "Pengene på en konto fordeles automatisk på bøttene, og Fordel på nytt gjør det for hånd.",
        "Budsjettoppsett, bøttejusteringer og flytting av midler mellom bøtter.",
        "En oversikt, engelsk og norsk (bokmål og nynorsk), og en administrasjonsside for brukere.",
        "Kjører på din egen server med Docker, over HTTPS på Tailscale eller lokalnettet, med sikkerhetskopier.",
      ],
      nn: [
        "Konvoluttbudsjett med bøtter: kvar bøtte vert fylt på kvar periode, og med Behald midlar sparar ho opp over fleire periodar.",
        "Periodar: planlegg, start, forleng og avslutt dei; bøttene vert fylte på når ein periode startar eller når inntekta kjem.",
        "Bankkontoar og transaksjonar: inntekter, utgifter og overføringar fordelte på bøtter, med redigering og reversering.",
        "Pengane på ein konto vert fordelte automatisk på bøttene, og Fordel på nytt gjer det for hand.",
        "Budsjettoppsett, bøttejusteringar og flytting av midlar mellom bøtter.",
        "Ei oversikt, engelsk og norsk (bokmål og nynorsk), og ei administrasjonsside for brukarar.",
        "Køyrer på din eigen server med Docker, over HTTPS på Tailscale eller lokalnettet, med tryggingskopiar.",
      ],
    },
  },
];

const newest = CHANGELOG[0];
if (!newest) throw new Error("CHANGELOG is empty");

/** The app's version: the newest entry's. */
export const APP_VERSION = newest.version;

/** The commit the app was built from (vite.config.ts). */
export const APP_COMMIT = __APP_COMMIT__;

/** Whether this is the Vite dev server rather than a production build. */
export const IS_DEV = import.meta.env.DEV;

const VERSION = /^v(\d+)\.(\d{2})\.(\d{2})$/;

/** A version's parts, [major, feature, patch], or null when it isn't vX.YY.ZZ. */
export function parseVersion(version: string): [number, number, number] | null {
  const m = VERSION.exec(version);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Compares two versions: negative when a is older. Unparsable counts as oldest. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a) ?? [-1, 0, 0];
  const pb = parseVersion(b) ?? [-1, 0, 0];
  return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
}

/** A section's heading: "<title> (yyyy-mm-dd) - vX.YY.ZZ". */
export function entryTitle(entry: ChangelogEntry, language: Language): string {
  return `${entry.title[language]} (${entry.date}) - ${entry.version}`;
}

/**
 * Whether current is a newer feature or major version than seen (or nothing
 * was seen): what makes What's New pop up. A newer patch alone doesn't.
 */
export function isFeatureUpdate(seen: string | null | undefined, current: string): boolean {
  if (!seen) return true;
  const [sMajor, sFeature] = parseVersion(seen) ?? [-1, 0];
  const [cMajor, cFeature] = parseVersion(current) ?? [-1, 0];
  return cMajor - sMajor > 0 || (cMajor === sMajor && cFeature > sFeature);
}

/** The entries newer than seen; only the newest when nothing was seen. */
export function entriesSince(
  seen: string | null | undefined,
  entries: ChangelogEntry[] = CHANGELOG,
): ChangelogEntry[] {
  if (!seen) return entries.slice(0, 1);
  return entries.filter((e) => compareVersions(e.version, seen) > 0);
}

/** "v1.04.00", plus " · dev" in development. */
export function versionLabel(): string {
  return IS_DEV ? `${APP_VERSION} · dev` : APP_VERSION;
}
