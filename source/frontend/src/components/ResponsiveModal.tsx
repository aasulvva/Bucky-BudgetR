import { Modal, useMantineTheme, type ModalProps } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";

/** A dialog: centred on desktop, full screen on mobile. */
export function ResponsiveModal(props: ModalProps) {
  const theme = useMantineTheme();
  const isDesktop = useMediaQuery(`(min-width: ${theme.breakpoints.sm})`, true);
  return <Modal size="md" fullScreen={!isDesktop} {...props} />;
}
