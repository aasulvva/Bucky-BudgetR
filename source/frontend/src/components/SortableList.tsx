import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ActionIcon, Box, Stack } from "@mantine/core";
import { IconGripVertical } from "@tabler/icons-react";
import type { CSSProperties, ReactNode } from "react";

/** Gives an item its drag handle, labelled with the item's name. */
export type DragHandle = (name: string) => ReactNode;

/**
 * A vertical list whose items are dragged by a handle (with the mouse, touch
 * or the keyboard: Space, the arrows, Space), as the Dashboard's widgets are
 * (#37). Each list is its own: a drag never leaves it, even in a list
 * inside one of its items. `onReorder` gets the list in its new order.
 */
export function SortableList<T extends { id: string }>({
  items,
  onReorder,
  dragLabel,
  gap = "xs",
  children,
}: {
  items: T[];
  onReorder: (items: T[]) => void;
  /** The handle's label, from the item's name. */
  dragLabel: (name: string) => string;
  gap?: "xs" | "sm" | "md";
  children: (item: T, index: number, handle: DragHandle) => ReactNode;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = items.findIndex((x) => x.id === active.id);
    const to = items.findIndex((x) => x.id === over.id);
    if (from >= 0 && to >= 0) onReorder(arrayMove(items, from, to));
  };
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={items.map((x) => x.id)} strategy={verticalListSortingStrategy}>
        <Stack gap={gap}>
          {items.map((x, i) => (
            <SortableItem key={x.id} id={x.id} dragLabel={dragLabel}>
              {(handle) => children(x, i, handle)}
            </SortableItem>
          ))}
        </Stack>
      </SortableContext>
    </DndContext>
  );
}

function SortableItem({
  id,
  dragLabel,
  children,
}: {
  id: string;
  dragLabel: (name: string) => string;
  children: (handle: DragHandle) => ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });
  const style: CSSProperties = {
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
          style={{ cursor: isDragging ? "grabbing" : "grab", touchAction: "none", flexShrink: 0 }}
          {...attributes}
          {...listeners}
          aria-label={dragLabel(name)}
          title={dragLabel(name)}
        >
          <IconGripVertical size={18} />
        </ActionIcon>
      ))}
    </Box>
  );
}
