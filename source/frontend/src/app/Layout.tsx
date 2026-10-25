import {
  ActionIcon,
  AppShell,
  Button,
  Group,
  NavLink,
  ScrollArea,
  Stack,
  Text,
  Title,
  useComputedColorScheme,
  useMantineColorScheme,
  useMantineTheme,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { IconMoon, IconSun } from "@tabler/icons-react";
import { Link, Outlet, useLocation } from "react-router";

import classes from "./Layout.module.css";
import { findNav, navTabs, type NavTab } from "./nav";

/**
 * The app shell: a side menu on desktop; bottom tabs, with a sub-menu for tabs
 * that hold several screens, on mobile.
 */
export function Layout() {
  const theme = useMantineTheme();
  const isDesktop = useMediaQuery(`(min-width: ${theme.breakpoints.sm})`, true);
  const current = findNav(useLocation().pathname);

  return (
    <AppShell
      header={{ height: 56 }}
      navbar={{ width: 260, breakpoint: "sm", collapsed: { mobile: true } }}
      footer={isDesktop ? undefined : { height: 64 }}
      padding="md"
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Title order={1} size="h4">
            Bucky BudgetR
          </Title>
          <ColorSchemeToggle />
        </Group>
      </AppShell.Header>

      {isDesktop && (
        <AppShell.Navbar p="sm">
          <SideNav pathname={current?.item.path} />
        </AppShell.Navbar>
      )}
      {/* Dev only (renders nothing in production builds); on desktop so the
          button doesn't cover the bottom tabs. */}
      {isDesktop && <ReactQueryDevtools buttonPosition="bottom-right" />}

      <AppShell.Main>
        {!isDesktop && current && current.tab.items.length > 1 && (
          <SubNav tab={current.tab} pathname={current.item.path} />
        )}
        <Outlet />
      </AppShell.Main>

      {!isDesktop && (
        <AppShell.Footer className={classes.footer}>
          <BottomTabs current={current?.tab} />
        </AppShell.Footer>
      )}
    </AppShell>
  );
}

function SideNav({ pathname }: { pathname: string | undefined }) {
  return (
    <ScrollArea>
      <Stack gap="md">
        {navTabs.map((tab) =>
          tab.action ? (
            <Button
              key={tab.id}
              component={Link}
              to={tab.items[0]?.path ?? "/"}
              leftSection={<tab.icon size={18} />}
            >
              {tab.items[0]?.label}
            </Button>
          ) : (
            <div key={tab.id}>
              <Text size="xs" fw={700} c="dimmed" tt="uppercase" px="sm" mb={4}>
                {tab.label}
              </Text>
              {tab.items.map((item) => (
                <NavLink
                  key={item.path}
                  component={Link}
                  to={item.path}
                  label={item.label}
                  active={item.path === pathname}
                />
              ))}
            </div>
          ),
        )}
      </Stack>
    </ScrollArea>
  );
}

function BottomTabs({ current }: { current: NavTab | undefined }) {
  return (
    <>
      {navTabs.map((tab) => {
        const to = tab.items[0]?.path ?? "/";
        if (tab.action) {
          return (
            <div key={tab.id} className={classes.action}>
              <ActionIcon
                component={Link}
                to={to}
                size={52}
                radius="xl"
                className={classes.actionButton}
                aria-label={tab.items[0]?.label}
              >
                <tab.icon size={28} />
              </ActionIcon>
            </div>
          );
        }
        const active = tab.id === current?.id;
        return (
          <Link
            key={tab.id}
            to={to}
            className={classes.tab}
            data-active={active || undefined}
            aria-current={active ? "page" : undefined}
          >
            <tab.icon size={22} />
            <span className={classes.tabLabel}>{tab.shortLabel ?? tab.label}</span>
          </Link>
        );
      })}
    </>
  );
}

function SubNav({ tab, pathname }: { tab: NavTab; pathname: string }) {
  return (
    <ScrollArea type="never" className={classes.subnav}>
      <Group gap="xs" wrap="nowrap" preventGrowOverflow={false}>
        {tab.items.map((item) => (
          <Button
            key={item.path}
            component={Link}
            to={item.path}
            size="compact-sm"
            radius="xl"
            className={classes.subnavItem}
            variant={item.path === pathname ? "filled" : "default"}
            // Bring the current screen into view when it's far right.
            ref={item.path === pathname ? scrollIntoView : undefined}
          >
            {item.label}
          </Button>
        ))}
      </Group>
    </ScrollArea>
  );
}

function scrollIntoView(el: HTMLElement | null) {
  el?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function ColorSchemeToggle() {
  const { setColorScheme } = useMantineColorScheme();
  const computed = useComputedColorScheme("light");
  const next = computed === "dark" ? "light" : "dark";
  return (
    <ActionIcon
      variant="default"
      size="lg"
      aria-label={`Switch to ${next} mode`}
      onClick={() => {
        setColorScheme(next);
      }}
    >
      {computed === "dark" ? <IconSun size={18} /> : <IconMoon size={18} />}
    </ActionIcon>
  );
}
