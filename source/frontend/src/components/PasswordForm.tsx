import { Button, PasswordInput, Stack } from "@mantine/core";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { api } from "@/api/client";
import { ApiError, unwrap } from "@/api/errors";
import i18n from "@/i18n";

import { ErrorAlert } from "./ErrorAlert";

/**
 * The password policy: at least 12 characters (the API spec) and at most 72
 * bytes (bcrypt's limit, internal/auth).
 */
const MIN_CHARS = 12;
const MAX_BYTES = 72;

interface PasswordFormProps {
  /** Called once the password has changed. */
  onChanged: () => void;
  submitLabel?: string;
}

/**
 * Changes the user's password: the current one, the new one twice. The
 * server ends the user's other sessions.
 */
export function PasswordForm({ onChanged, submitLabel }: PasswordFormProps) {
  const { t } = useTranslation();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<{ current?: string; next?: string; confirm?: string }>({});

  const change = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/me/password", {
          body: { current_password: current, new_password: next },
        }),
      ),
    meta: { silentError: true },
    onSuccess: () => {
      setCurrent("");
      setNext("");
      setConfirm("");
      onChanged();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === "wrong_password") {
        setErrors({ current: t("auth.wrongPassword") });
      } else if (err instanceof ApiError && err.code === "weak_password") {
        // The checks below catch what the server would refuse.
        setErrors({ next: t("auth.weakPassword") });
      }
    },
  });

  const submit = (e: { preventDefault: () => void }) => {
    e.preventDefault();
    const found = check(current, next, confirm);
    setErrors(found);
    if (Object.keys(found).length === 0) change.mutate();
  };

  // Field errors are shown on the fields; anything else above the button.
  const otherError =
    change.error instanceof ApiError &&
    (change.error.code === "wrong_password" || change.error.code === "weak_password")
      ? undefined
      : change.error;

  return (
    <form onSubmit={submit} noValidate>
      <Stack gap="sm">
        <PasswordInput
          label={t("auth.currentPassword")}
          autoComplete="current-password"
          value={current}
          onChange={(e) => {
            setCurrent(e.currentTarget.value);
          }}
          error={errors.current}
          required
        />
        <PasswordInput
          label={t("auth.newPassword")}
          description={t("auth.newPasswordHint", { count: MIN_CHARS })}
          autoComplete="new-password"
          value={next}
          onChange={(e) => {
            setNext(e.currentTarget.value);
          }}
          error={errors.next}
          required
        />
        <PasswordInput
          label={t("auth.repeatPassword")}
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => {
            setConfirm(e.currentTarget.value);
          }}
          error={errors.confirm}
          required
        />
        {otherError && <ErrorAlert error={otherError} />}
        <Button type="submit" loading={change.isPending} style={{ alignSelf: "flex-start" }}>
          {submitLabel ?? t("auth.changePassword")}
        </Button>
      </Stack>
    </form>
  );
}

function check(current: string, next: string, confirm: string) {
  const errors: { current?: string; next?: string; confirm?: string } = {};
  const bytes = new TextEncoder().encode(next).length;
  if (current === "") errors.current = i18n.t("auth.enterCurrent");
  // Characters as the API spec counts them: code points.
  if (Array.from(next).length < MIN_CHARS) {
    errors.next = i18n.t("auth.tooShort", { count: MIN_CHARS });
  } else if (bytes > MAX_BYTES) errors.next = i18n.t("auth.tooLong", { count: MAX_BYTES });
  else if (next === current) errors.next = i18n.t("auth.sameAsCurrent");
  if (confirm !== next) errors.confirm = i18n.t("auth.noMatch");
  return errors;
}
