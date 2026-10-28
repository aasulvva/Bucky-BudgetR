import { Center, Loader } from "@mantine/core";
import { DatesProvider } from "@mantine/dates";
import { Navigate, Outlet, useLocation } from "react-router";

import { ErrorAlert } from "@/components/ErrorAlert";
import { applyLanguage, resolveLanguage } from "@/lib/language";
import { setLocale } from "@/lib/locale";

import { useDefaultTimeZone, useSession } from "./session";

/**
 * Guards the app's screens: without a session it sends the user to the login
 * page (coming back here afterwards), and a user who must change the password
 * to the password page. It also applies the user's locale and language, and
 * sets the time zone the first time.
 */
export function RequireSession() {
  const session = useSession();
  const location = useLocation();
  useDefaultTimeZone(session.data);

  if (session.isPending) {
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    );
  }
  if (session.isError) {
    return (
      <Center h="100vh" p="md">
        <ErrorAlert error={session.error} onRetry={() => void session.refetch()} />
      </Center>
    );
  }
  const user = session.data;
  if (!user) {
    const next = location.pathname + location.search;
    const to = next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`;
    return <Navigate to={to} replace />;
  }
  if (user.must_change_password) return <Navigate to="/change-password" replace />;

  // The formatters and translations are read on every call; remounting the
  // screens when the locale or language changes makes them all render again.
  const { locale } = user.preferences;
  const language = resolveLanguage(user.preferences);
  setLocale(locale);
  applyLanguage(language);
  return (
    // The date pickers' month and day names.
    <DatesProvider settings={{ locale: language }}>
      <Outlet key={`${locale ?? ""}/${language}`} />
    </DatesProvider>
  );
}
