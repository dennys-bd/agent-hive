// Two fields side by side share their rows (label, input, hint) through subgrid, so a label that wraps pushes both inputs down together.
export const FIELD_ROW = 'grid grid-cols-2 gap-x-3 gap-y-1';
export const FIELD = 'row-span-3 grid grid-rows-subgrid';
export const FIELD_LABEL = 'self-end';
// A switch that depends on the one above it (#573): indented under it, with a rule on its left.
export const CHILD = 'ml-4 border-l pl-5';
