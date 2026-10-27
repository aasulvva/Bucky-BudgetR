import {
  ActionIcon,
  AppShell,
  Avatar,
  Badge,
  Box,
  Button,
  Drawer,
  Group,
  Menu,
  NavLink,
  ScrollArea,
  Stack,
  Text,
  Title,
  UnstyledButton,
  useComputedColorScheme,
  useMantineColorScheme,
  useMantineTheme,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { IconLogout, IconMoon, IconShield, IconSettings, IconSun } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, Outlet, useLocation } from "react-router";

import { CycleBanners } from "@/components/cycles/CycleBanners";
import { CycleStatus } from "@/components/cycles/CycleStatus";
import { DebugButton, DebugMenuItem, DebugRoot } from "@/components/debug";
import { useClockVersion } from "@/lib/clock";

import classes from "./Layout.module.css";
import { findNav, navTabs, profileItems, type NavItem, type NavTab } from "./nav";
import { useSession, useSignOut } from "./session";

/**
 * The app shell (spec §9). Desktop: a side menu with collapsible groups and
 * the profile menu at the bottom. Mobile: a header with the screen's name and
 * the profile menu, and bottom tabs; a tab that holds several screens opens
 * them in a sheet.
 */
export function Layout() {
  const { t } = useTranslation();
  const theme = useMantineTheme();
  const isDesktop = useMediaQuery(`(min-width: ${theme.breakpoints.sm})`, true);
  const current = findNav(useLocation().pathname);
  // Moving the debug clock (development only) redraws the screen.
  const clockVersion = useClockVersion();

  return (
    <AppShell
      header={isDesktop ? undefined : { height: 56 }}
      navbar={{ width: 260, breakpoint: "sm", collapsed: { mobile: true } }}
      footer={isDesktop ? undefined : { height: 64 }}
      padding="md"
    >
      {!isDesktop && (
        <AppShell.Header>
          <Group h="100%" pl="md" pr="xs" justify="space-between" wrap="nowrap">
            <Title order={1} size="h4" lineClamp={1}>
              {current ? t(`nav.items.${current.item.key}`) : "Bucky BudgetR"}
            </Title>
            <Group gap={4} wrap="nowrap">
              <CycleStatus placement="header" />
              <ProfileMenu placement="header" />
            </Group>
          </Group>
        </AppShell.Header>
      )}

      {isDesktop && (
        <AppShell.Navbar p="sm">
          <SideNav current={current} />
        </AppShell.Navbar>
      )}
      {/* Dev only (renders nothing in production builds); on desktop so the
          button doesn't cover the bottom tabs. */}
      {isDesktop && <ReactQueryDevtools buttonPosition="bottom-right" />}

      <AppShell.Main>
        <DebugRoot />
        <CycleBanners />
        <Outlet key={clockVersion} />
      </AppShell.Main>

      {!isDesktop && (
        <AppShell.Footer className={classes.footer}>
          <BottomTabs current={current?.tab} pathname={current?.item.path} />
        </AppShell.Footer>
      )}
    </AppShell>
  );
}

type Current = ReturnType<typeof findNav>;

function SideNav({ current }: { current: Current }) {
  const { t } = useTranslation();
  // Groups the user opened or closed; otherwise Budget & Reporting and the
  // group of the current screen are open.
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const pathname = current?.item.path;

  return (
    <>
      <AppShell.Section>
        <Title order={1} size="h4" px="sm" pt={4} pb="sm">
          Bucky BudgetR
        </Title>
        <Stack mb="sm">
          <CycleStatus placement="sidebar" />
        </Stack>
      </AppShell.Section>
      <AppShell.Section grow component={ScrollArea}>
        <Stack gap={4}>
          {navTabs.map((tab) => {
            const first = tab.items[0];
            if (tab.action) {
              return (
                <Button
                  key={tab.id}
                  component={Link}
                  to={first?.path ?? "/"}
                  leftSection={<tab.icon size={18} />}
                  mb="xs"
                >
                  {first && t(`nav.items.${first.key}`)}
                </Button>
              );
            }
            if (tab.items.length === 1 && first) {
              return (
                <NavLink
                  key={tab.id}
                  component={Link}
                  to={first.path}
                  label={t(`nav.items.${first.key}`)}
                  leftSection={<tab.icon size={18} />}
                  active={first.path === pathname}
                />
              );
            }
            const opened = toggled[tab.id] ?? (tab.id === "budget" || tab.id === current?.tab?.id);
            return (
              <NavLink
                key={tab.id}
                label={t(`nav.tabs.${tab.id}`)}
                leftSection={<tab.icon size={18} />}
                opened={opened}
                onChange={(open) => {
                  setToggled((t) => ({ ...t, [tab.id]: open }));
                }}
                childrenOffset={28}
                mt="xs"
              >
                {tab.items.map((item) => (
                  <NavLink
                    key={item.path}
                    component={Link}
                    to={item.path}
                    label={<ItemLabel item={item} />}
                    active={item.path === pathname}
                  />
                ))}
              </NavLink>
            );
          })}
        </Stack>
      </AppShell.Section>
      <AppShell.Section pt="sm">
        <Group gap={4} wrap="nowrap">
          <Box flex={1} miw={0}>
            <ProfileMenu placement="sidebar" />
          </Box>
          <DebugButton />
        </Group>
      </AppShell.Section>
    </>
  );
}

function ItemLabel({ item }: { item: NavItem }) {
  const { t } = useTranslation();
  const label = t(`nav.items.${item.key}`);
  if (!item.later) return label;
  return (
    <Group gap={6} wrap="nowrap">
      {label}
      <Badge size="xs" variant="light" color="gray">
        {t("common.later")}
      </Badge>
    </Group>
  );
}

function BottomTabs({ current, pathname }: { current: NavTab | undefined; pathname?: string }) {
  const { t } = useTranslation();
  const [sheet, setSheet] = useState<NavTab | undefined>();

  return (
    <>
      {navTabs.map((tab) => {
        const first = tab.items[0];
        const to = first?.path ?? "/";
        if (tab.action) {
          return (
            <div key={tab.id} className={classes.action}>
              <ActionIcon
                component={Link}
                to={to}
                size={52}
                radius="xl"
                className={classes.actionButton}
                aria-label={first && t(`nav.items.${first.key}`)}
              >
                <tab.icon size={28} />
              </ActionIcon>
            </div>
          );
        }
        const active = tab.id === current?.id;
        const content = (
          <>
            <tab.icon size={22} />
            <span className={classes.tabLabel}>{t(`nav.tabs.${tab.short ?? tab.id}`)}</span>
          </>
        );
        if (tab.items.length === 1) {
          return (
            <Link
              key={tab.id}
              to={to}
              className={classes.tab}
              data-active={active || undefined}
              aria-current={active ? "page" : undefined}
            >
              {content}
            </Link>
          );
        }
        return (
          <UnstyledButton
            key={tab.id}
            className={classes.tab}
            data-active={active || undefined}
            aria-haspopup="dialog"
            aria-expanded={sheet?.id === tab.id}
            onClick={() => {
              setSheet(tab);
            }}
          >
            {content}
          </UnstyledButton>
        );
      })}

      <Drawer
        opened={sheet !== undefined}
        onClose={() => {
          setSheet(undefined);
        }}
        position="bottom"
        size="auto"
        title={sheet && t(`nav.tabs.${sheet.id}`)}
      >
        <Stack gap={4} pb="md">
          {sheet?.items.map((item) => (
            <NavLink
              key={item.path}
              component={Link}
              to={item.path}
              label={<ItemLabel item={item} />}
              active={item.path === pathname}
              className={classes.sheetItem}
              onClick={() => {
                setSheet(undefined);
              }}
            />
          ))}
        </Stack>
      </Drawer>
    </>
  );
}

/**
 * The profile menu: Settings, Admin (admins only), the color scheme and sign
 * out. In the side menu it is a button with the username; in the mobile
 * header an avatar.
 */
function ProfileMenu({ placement }: { placement: "sidebar" | "header" }) {
  const { t } = useTranslation();
  const user = useSession().data;
  const avatar = (
    <Avatar size={32} radius="xl" color="blue" aria-hidden>
      {user?.username.slice(0, 1).toUpperCase()}
    </Avatar>
  );

  return (
    <Menu position={placement === "sidebar" ? "top-start" : "bottom-end"} width={260}>
      <Menu.Target>
        {placement === "sidebar" ? (
          <UnstyledButton className={classes.profileButton}>
            {avatar}
            <span className={classes.profileText}>
              <Text fw={600} size="sm" truncate>
                {user?.username ?? t("nav.profile")}
              </Text>
              <Text size="xs" c="dimmed">
                {t("nav.profileAndSettings")}
              </Text>
            </span>
          </UnstyledButton>
        ) : (
          <ActionIcon variant="subtle" size={44} radius="xl" aria-label={t("nav.profile")}>
            {avatar}
          </ActionIcon>
        )}
      </Menu.Target>
      <Menu.Dropdown>
        {user && (
          <Menu.Label>
            {user.username} · {user.admin ? t("nav.roleAdmin") : t("nav.roleUser")}
          </Menu.Label>
        )}
        {profileItems
          .filter((item) => !item.adminOnly || user?.admin)
          .map((item) => (
            <Menu.Item
              key={item.path}
              component={Link}
              to={item.path}
              leftSection={item.adminOnly ? <IconShield size={18} /> : <IconSettings size={18} />}
            >
              <Text size="sm">{t(`nav.items.${item.key}`)}</Text>
              <Text size="xs" c="dimmed">
                {t(`nav.descriptions.${item.key}`)}
              </Text>
            </Menu.Item>
          ))}
        <ColorSchemeItem />
        {placement === "header" && <DebugMenuItem />}
        <Menu.Divider />
        <SignOutItem />
      </Menu.Dropdown>
    </Menu>
  );
}

function ColorSchemeItem() {
  const { t } = useTranslation();
  const { setColorScheme } = useMantineColorScheme();
  const computed = useComputedColorScheme("light");
  const next = computed === "dark" ? "light" : "dark";
  return (
    <Menu.Item
      leftSection={computed === "dark" ? <IconSun size={18} /> : <IconMoon size={18} />}
      onClick={() => {
        setColorScheme(next);
      }}
    >
      {next === "dark" ? t("nav.darkMode") : t("nav.lightMode")}
    </Menu.Item>
  );
}

function SignOutItem() {
  const { t } = useTranslation();
  const signOut = useSignOut();
  return (
    <Menu.Item leftSection={<IconLogout size={18} />} onClick={signOut}>
      {t("nav.signOut")}
    </Menu.Item>
  );
}
