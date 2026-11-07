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
