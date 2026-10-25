import {
  Alert,
  Button,
  Card,
  Center,
  Loader,
  PasswordInput,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Navigate, useSearchParams } from "react-router";

import { api } from "@/api/client";
import { ApiError, unwrap } from "@/api/errors";
import { SESSION_KEY, clearSessionEnded, sessionEnded, useSession } from "@/app/session";
import { ErrorAlert } from "@/components/ErrorAlert";

/** Where to go after logging in: a path in the app, never another site. */
function safeNext(next: string | null): string {
  return next?.startsWith("/") && !next.startsWith("//") ? next : "/";
}

export default function Login() {
  const session = useSession();
  const client = useQueryClient();
  const [params] = useSearchParams();
  // Read once and then cleared, so the notice shows for this visit only.
  const [ended] = useState(sessionEnded);
  useEffect(clearSessionEnded, []);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const login = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/auth/login", { body: { username, password } })),
    meta: { silentError: true },
    onSuccess: (user) => {
      client.setQueryData(SESSION_KEY, user);
    },
    onError: () => {
      setPassword("");
    },
  });

  if (session.isPending) {
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    );
  }
  if (session.data) {
    return (
      <Navigate
        to={session.data.must_change_password ? "/change-password" : safeNext(params.get("next"))}
        replace
      />
    );
  }

  const submit = (e: { preventDefault: () => void }) => {
    e.preventDefault();
    login.mutate();
  };

  return (
    <Center mih="100vh" p="md">
      <Card withBorder radius="md" p="xl" w="100%" maw={400}>
        <form onSubmit={submit}>
          <Stack gap="md">
            <Title order={1} size="h3">
              Bucky BudgetR
            </Title>
            {ended && !login.error && (
              <Alert color="blue">Your session has ended. Log in again.</Alert>
            )}
            <TextInput
              label="Username"
              autoComplete="username"
              autoFocus
              value={username}
              onChange={(e) => {
                setUsername(e.currentTarget.value);
              }}
              required
            />
            <PasswordInput
              label="Password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => {
                setPassword(e.currentTarget.value);
              }}
              required
            />
            {login.error && <LoginError error={login.error} />}
            <Button type="submit" loading={login.isPending} disabled={!username || !password}>
              Log in
            </Button>
          </Stack>
        </form>
      </Card>
    </Center>
  );
}

function LoginError({ error }: { error: Error }) {
  if (
    error instanceof ApiError &&
    (error.code === "invalid_credentials" || error.code === "too_many_attempts")
  ) {
    return (
      <Alert color="red">
        <Text size="sm">{error.problem.detail}</Text>
      </Alert>
    );
  }
  return <ErrorAlert error={error} />;
}
