import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Menu,
  Select,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { IconDots } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useUpdatePreferences } from "@/app/session";
import { ErrorAlert } from "@/components/ErrorAlert";
import { ResponsiveModal } from "@/components/ResponsiveModal";
import {
  cleanGraph,
  newGraphId,
  sameGraph,
  type GraphSettings,
  type SavedGraph,
} from "@/lib/graphs";

const MAX_NAME = 60;
const MAX_SAVED = 50;

interface SavedGraphsProps {
  saved: SavedGraph[];
  /** The graph on screen. */
  current: GraphSettings;
  /** The saved graph picked, if any. */
  selectedId: string | null;
  /** Picks a saved graph (its settings replace the current ones), or none. */
  onSelect: (graph: SavedGraph | null) => void;
}

type Dialog = { kind: "saveAs" | "rename"; name: string } | { kind: "delete" } | null;

/** Saved graphs (#122): pick one, save the current graph, rename or delete. */
export function SavedGraphs({ saved, current, selectedId, onSelect }: SavedGraphsProps) {
  const { t } = useTranslation();
  const update = useUpdatePreferences();
  const [dialog, setDialog] = useState<Dialog>(null);
  const selected = saved.find((g) => g.id === selectedId) ?? null;
  const changed = selected !== null && !sameGraph(selected.graph, current);

  const save = async (list: SavedGraph[]) => {
    await update.mutateAsync({ saved_graphs: list });
  };
  const close = () => {
    update.reset();
    setDialog(null);
  };

  const nameError = (name: string) => {
    if (dialog?.kind !== "saveAs" && dialog?.kind !== "rename") return undefined;
    if (name.trim() === "") return t("common.enterName");
    if (name.trim().length > MAX_NAME) return t("common.maxChars", { count: MAX_NAME });
    return undefined;
  };

  const confirm = async () => {
    if (!dialog) return;
    if (dialog.kind === "delete") {
      if (!selected) return;
      await save(saved.filter((g) => g.id !== selected.id));
      onSelect(null);
    } else if (dialog.kind === "saveAs") {
      const graph: SavedGraph = {
        id: newGraphId(saved),
        name: dialog.name.trim(),
        graph: cleanGraph(current),
      };
      await save([...saved, graph]);
      onSelect(graph);
    } else if (selected) {
      await save(saved.map((g) => (g.id === selected.id ? { ...g, name: dialog.name.trim() } : g)));
    }
    setDialog(null);
  };

  return (
    <Stack gap="xs">
      <Group gap="xs" align="flex-end" wrap="wrap">
        <Select
          label={t("stats.saved.label")}
          placeholder={saved.length === 0 ? t("stats.saved.none") : t("stats.saved.pick")}
          data={saved.map((g) => ({ value: g.id, label: g.name }))}
          value={selected?.id ?? null}
          onChange={(id) => {
            onSelect(saved.find((g) => g.id === id) ?? null);
          }}
          disabled={saved.length === 0}
          clearable
          w={260}
        />
        {selected && (
          <Button
            variant="default"
            disabled={!changed}
            loading={update.isPending && dialog === null}
            onClick={() => {
              void save(
                saved.map((g) => (g.id === selected.id ? { ...g, graph: cleanGraph(current) } : g)),
              );
            }}
          >
            {t("common.save")}
          </Button>
        )}
        <Button
          variant={selected ? "subtle" : "default"}
          disabled={saved.length >= MAX_SAVED}
          onClick={() => {
            update.reset();
            setDialog({ kind: "saveAs", name: "" });
          }}
        >
          {t(selected ? "stats.saved.saveAs" : "stats.saved.save")}
        </Button>
        {selected && (
          <Menu position="bottom-end">
            <Menu.Target>
              <ActionIcon variant="subtle" size="lg" aria-label={t("stats.saved.more")}>
                <IconDots size={18} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item
                onClick={() => {
                  update.reset();
                  setDialog({ kind: "rename", name: selected.name });
                }}
              >
                {t("stats.saved.rename")}
              </Menu.Item>
              <Menu.Item
                color="red"
                onClick={() => {
                  update.reset();
                  setDialog({ kind: "delete" });
                }}
              >
                {t("common.delete")}
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        )}
        {changed && (
          <Badge variant="light" color="gray" mb={6}>
            {t("stats.saved.unsaved")}
          </Badge>
        )}
      </Group>
      {update.error && dialog === null && <ErrorAlert error={update.error} />}

      <ResponsiveModal
        opened={dialog !== null}
        onClose={close}
        title={
          dialog?.kind === "delete"
            ? t("stats.saved.deleteTitle")
            : dialog?.kind === "rename"
              ? t("stats.saved.renameTitle")
              : t("stats.saved.saveAsTitle")
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (dialog && dialog.kind !== "delete" && nameError(dialog.name)) return;
            void confirm().catch(() => undefined);
          }}
        >
          <Stack gap="md">
            {dialog?.kind === "delete" ? (
              <Text size="sm">{t("stats.saved.deleteText", { name: selected?.name ?? "" })}</Text>
            ) : (
              dialog && (
                <TextInput
                  label={t("stats.saved.name")}
                  value={dialog.name}
                  onChange={(e) => {
                    setDialog({ ...dialog, name: e.currentTarget.value });
                  }}
                  error={dialog.name !== "" ? nameError(dialog.name) : undefined}
                  data-autofocus
                />
              )
            )}
            {update.error && <ErrorAlert error={update.error} />}
            <Group justify="flex-end" gap="xs">
              <Button variant="default" onClick={close}>
                {t("common.cancel")}
              </Button>
              <Button
                type="submit"
                color={dialog?.kind === "delete" ? "red" : undefined}
                loading={update.isPending}
                disabled={
                  dialog !== null &&
                  dialog.kind !== "delete" &&
                  nameError(dialog.name) !== undefined
                }
              >
                {dialog?.kind === "delete" ? t("common.delete") : t("common.save")}
              </Button>
            </Group>
          </Stack>
        </form>
      </ResponsiveModal>
    </Stack>
  );
}
