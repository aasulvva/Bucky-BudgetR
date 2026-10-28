import { createTheme, Drawer, Modal } from "@mantine/core";

// While a dialog is open Mantine locks page scrolling, which also blocks
// pinch-zoom unless allowed; on a phone that could leave the page stuck
// zoomed in (#103).
const removeScrollProps = { allowPinchZoom: true };

export const theme = createTheme({
  primaryColor: "blue",
  defaultRadius: "md",
  components: {
    Modal: Modal.extend({ defaultProps: { removeScrollProps } }),
    Drawer: Drawer.extend({ defaultProps: { removeScrollProps } }),
  },
});
