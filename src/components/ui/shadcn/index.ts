/**
 * shadcn/ui (SOW §6 "Tailwind CSS and shadcn/ui"; ADR-151). Owned source in shadcn/ui's form
 * (Radix primitives, `cva` variants, `cn`), themed with MOTION's design tokens. Screens use them
 * through `@/components/ui/*`, which are built on these.
 */
export { Alert, AlertDescription, AlertTitle } from './alert';
export { Badge, badgeVariants } from './badge';
export { Button, buttonVariants } from './button';
export { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from './card';
export { Input } from './input';
export { Label } from './label';
export { NativeSelect } from './native-select';
export { Skeleton } from './skeleton';
export { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from './table';
export { Textarea } from './textarea';
export { DraggableWidgetGrid, type DraggableWidgetGridProps, type WidgetItem, type WidgetSize } from './draggable-widget-grid';
