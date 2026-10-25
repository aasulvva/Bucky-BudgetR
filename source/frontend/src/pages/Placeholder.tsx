import { Anchor, Stack, Text, Title } from "@mantine/core";

interface PlaceholderProps {
  title: string;
  issue: number;
}

/** Stands in for a screen that hasn't been built yet. */
export function Placeholder({ title, issue }: PlaceholderProps) {
  return (
    <Stack gap="xs">
      <Title order={2}>{title}</Title>
      <Text c="dimmed">
        Coming in{" "}
        <Anchor href={`https://github.com/aasulvva/Bucky-BudgetR/issues/${issue}`} target="_blank">
          #{issue}
        </Anchor>
        .
      </Text>
    </Stack>
  );
}
