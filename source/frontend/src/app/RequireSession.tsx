import { Center, Loader } from "@mantine/core";
import { Navigate, Outlet, useLocation } from "react-router";

import { ErrorAlert } from "@/components/ErrorAlert";
import { setLocale } from "@/lib/locale";

import { useSession } from "./session";

/**
 * Guards the app's screens: without a session it sends the user to the login
 * page (coming back here afterwards), and a user who must change the password
 * to the password page. It also applies the user's locale.
 */
export function RequireSession() {
  const session = useSession();
  const location = useLocation();

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

  // The formatters read the locale on every call; remounting the screens when
  // it changes makes them all format again.
  setLocale(user.preferences.locale);
  return <Outlet key={user.preferences.locale ?? ""} />;
}
