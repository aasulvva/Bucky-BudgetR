import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ActionIcon, Box, SimpleGrid } from "@mantine/core";
import { IconGripVertical } from "@tabler/icons-react";
import type { CSSProperties, ReactNode } from "react";
import { useTranslation } from "react-i18next";

import {
  moveWidget,
  moveWidgetTo,
  removeWidget,
  replaceWidget,
  type Layout,
  type WidgetInstance,
  type SaveWidget,
} from "@/lib/dashboard";

import { widgetTitle } from "./frame";
import { WidgetView } from "./WidgetView";

/** A full-width widget spans both columns. */
const span = (widget: WidgetInstance): CSSProperties =>
  widget.width === "full" ? { gridColumn: "1 / -1" } : {};

/**
 * The Dashboard's widgets in a grid of one column, or two from md. In edit
 * mode (`onChange` given) they can be dragged by a handle, moved with the
 * arrow buttons, resized and removed; every change goes to `onChange`.
 */
export function DashboardGrid({
  layout,
  onSave,
  onChange,
}: {
  layout: Layout;
  onSave: SaveWidget;
  onChange?: (layout: Layout) => void;
}) {
  const { t } = useTranslation();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  if (!onChange) {
    return (
      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
        {layout.map((w) => (
          <Box key={w.id} style={span(w)}>
            <WidgetView widget={w} onSave={onSave} />
          </Box>
        ))}
      </SimpleGrid>
    );
  }

  /** "Bucket status", or "Bucket status 2" for the second copy. */
  const name = (w: WidgetInstance) => {
    const title = widgetTitle(t, w.type);
    const copies = layout.filter((o) => o.type === w.type);
    return copies.length > 1 ? `${title} ${copies.indexOf(w) + 1}` : title;
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = layout.findIndex((w) => w.id === active.id);
    const to = layout.findIndex((w) => w.id === over.id);
    if (from >= 0 && to >= 0) onChange(moveWidgetTo(layout, from, to));
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={layout.map((w) => w.id)} strategy={rectSortingStrategy}>
        <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
          {layout.map((w, i) => (
            <SortableCell key={w.id} widget={w}>
              {(handle) => (
                <WidgetView
                  widget={w}
                  onSave={onSave}
                  edit={{
                    name: name(w),
                    first: i === 0,
                    last: i === layout.length - 1,
                    handle: handle(name(w)),
                    onMove: (by) => {
                      onChange(moveWidget(layout, w.id, by));
                    },
                    onWidth: (width) => {
                      onChange(replaceWidget(layout, { ...w, width }));
                    },
                    onRemove: () => {
                      onChange(removeWidget(layout, w.id));
                    },
                  }}
                />
              )}
            </SortableCell>
          ))}
        </SimpleGrid>
      </SortableContext>
    </DndContext>
  );
}

/** A grid cell that can be dragged by the handle it gives its widget. */
function SortableCell({
  widget,
  children,
}: {
  widget: WidgetInstance;
  children: (handle: (name: string) => ReactNode) => ReactNode;
}) {
  const { t } = useTranslation();
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: widget.id });
  const style: CSSProperties = {
    ...span(widget),
    transform: CSS.Translate.toString(transform),
    transition,
    position: "relative",
    zIndex: isDragging ? 1 : undefined,
    opacity: isDragging ? 0.85 : undefined,
  };
  return (
    <Box ref={setNodeRef} style={style}>
      {children((name) => (
        <ActionIcon
          ref={setActivatorNodeRef}
          variant="subtle"
          color="gray"
          style={{ cursor: isDragging ? "grabbing" : "grab", touchAction: "none" }}
          {...attributes}
          {...listeners}
          aria-label={t("dashboard.edit.drag", { widget: name })}
          title={t("dashboard.edit.drag", { widget: name })}
        >
          <IconGripVertical size={18} />
        </ActionIcon>
      ))}
    </Box>
  );
}
